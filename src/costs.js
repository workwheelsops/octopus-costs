// Computes daily and month-to-date electricity cost for the current calendar
// month (Europe/London), by combining half-hourly consumption with the
// half-hourly unit rates and standing charges that were in force at the time.
// Designed for Agile-style tariffs where the unit rate changes every 30
// minutes, but also works for flat tariffs (the rate is just constant).

const OCTOPUS_BASE = "https://api.octopus.energy/v1";

export async function computeCosts(env) {
  const apiKey = env.OCTOPUS_API_KEY;
  const accountNumber = env.OCTOPUS_ACCOUNT_NUMBER;

  if (!apiKey || !accountNumber) {
    return json(
      {
        error: "not_configured",
        message:
          "Missing OCTOPUS_API_KEY and/or OCTOPUS_ACCOUNT_NUMBER. Set them as Worker secrets (see README).",
      },
      500
    );
  }

  const authHeader = "Basic " + btoa(`${apiKey}:`);

  try {
    const account = await octopusGet(
      `${OCTOPUS_BASE}/accounts/${encodeURIComponent(accountNumber)}/`,
      authHeader
    );

    const properties = account.properties || [];
    const property = properties.find((p) => !p.moved_out_at) || properties[0];
    const meterPoints = property?.electricity_meter_points || [];
    // Prefer the import meter point over an export one (e.g. solar export),
    // since export meter points report energy sent out, not consumed.
    const meterPoint = meterPoints.find((mp) => !mp.is_export) || meterPoints[0];
    if (!meterPoint) {
      return json(
        {
          error: "no_meter_point",
          message: "No electricity meter point found on this account.",
        },
        404
      );
    }

    const mpan = meterPoint.mpan;
    const meter = meterPoint.meters?.[0];
    if (!meter) {
      return json(
        { error: "no_meter", message: "No meter found on the electricity meter point." },
        404
      );
    }
    const serial = meter.serial_number;
    const agreements = meterPoint.agreements || [];

    const { monthStart, periodEnd } = getCurrentLondonMonthRange();

    const consumption = await fetchAllPages(
      `${OCTOPUS_BASE}/electricity-meter-points/${mpan}/meters/${serial}/consumption/` +
        `?period_from=${monthStart.toISOString()}&period_to=${periodEnd.toISOString()}` +
        `&page_size=25000&order_by=period`,
      authHeader
    );

    // If this month is empty, check whether the meter has ever reported any
    // half-hourly data via the API at all (helps tell "meter isn't smart /
    // hasn't shared data yet" apart from "just this month is missing").
    let mostRecentReadingAt = null;
    if (consumption.length === 0) {
      const latest = await octopusGet(
        `${OCTOPUS_BASE}/electricity-meter-points/${mpan}/meters/${serial}/consumption/` +
          `?page_size=1&order_by=-period`,
        authHeader
      ).catch(() => null);
      mostRecentReadingAt = latest?.results?.[0]?.interval_start ?? null;
    }

    const rateMap = new Map(); // interval_start ISO -> value_inc_vat (pence)
    const standingSegments = []; // { segStart, segEnd, charges: [...] }

    for (const agreement of agreements) {
      const validFrom = new Date(agreement.valid_from);
      const validTo = agreement.valid_to ? new Date(agreement.valid_to) : periodEnd;
      const segStart = maxDate(validFrom, monthStart);
      const segEnd = minDate(validTo, periodEnd);
      if (segStart >= segEnd) continue;

      const tariffCode = agreement.tariff_code;
      const productCode = parseProductCode(tariffCode);
      if (!tariffCode || !productCode) continue;

      const rates = await fetchAllPages(
        `${OCTOPUS_BASE}/products/${productCode}/electricity-tariffs/${tariffCode}/standard-unit-rates/` +
          `?period_from=${segStart.toISOString()}&period_to=${segEnd.toISOString()}&page_size=25000`,
        authHeader
      ).catch(() => []);
      for (const r of rates) rateMap.set(r.valid_from, r.value_inc_vat);

      const charges = await fetchAllPages(
        `${OCTOPUS_BASE}/products/${productCode}/electricity-tariffs/${tariffCode}/standing-charges/` +
          `?period_from=${segStart.toISOString()}&period_to=${segEnd.toISOString()}&page_size=25000`,
        authHeader
      ).catch(() => []);
      standingSegments.push({ segStart, segEnd, charges });
    }

    const dayMap = new Map(); // londonDateKey -> { kwh, costPence, missingRate }

    for (const slot of consumption) {
      const kwh = slot.consumption;
      const rate = rateMap.get(slot.interval_start);
      const dateKey = londonDateKey(new Date(slot.interval_start));
      const entry = dayMap.get(dateKey) || { kwh: 0, costPence: 0, missingRate: false };
      entry.kwh += kwh;
      if (rate != null) {
        entry.costPence += kwh * rate;
      } else {
        entry.missingRate = true;
      }
      dayMap.set(dateKey, entry);
    }

    for (const [dateKey, entry] of dayMap) {
      const dayStartUTC = londonDateKeyToUTC(dateKey);
      const standingChargePence = findStandingCharge(standingSegments, dayStartUTC);
      entry.standingChargePence = standingChargePence ?? 0;
      entry.costPence += entry.standingChargePence;
      if (standingChargePence == null) entry.missingRate = true;
    }

    const days = [...dayMap.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([date, e]) => ({
        date,
        kwh: round(e.kwh, 3),
        standingChargeGBP: round(e.standingChargePence / 100, 2),
        costGBP: round(e.costPence / 100, 2),
        estimated: e.missingRate,
      }));

    const totalCostPence = days.reduce((sum, d) => sum + d.costGBP * 100, 0);
    const totalKwh = days.reduce((sum, d) => sum + d.kwh, 0);

    return json({
      accountNumber,
      mpan,
      meterSerial: serial,
      days,
      totalCostGBP: round(totalCostPence / 100, 2),
      totalKwh: round(totalKwh, 2),
      averageDailyCostGBP: days.length ? round(totalCostPence / 100 / days.length, 2) : 0,
      monthStart: monthStart.toISOString(),
      generatedAt: new Date().toISOString(),
      debug: {
        propertyCount: properties.length,
        meterPointCount: meterPoints.length,
        meterPointMpans: meterPoints.map((mp) => ({ mpan: mp.mpan, isExport: !!mp.is_export })),
        agreementCount: agreements.length,
        periodFrom: monthStart.toISOString(),
        periodTo: periodEnd.toISOString(),
        rawConsumptionRecordCount: consumption.length,
        mostRecentReadingAt,
      },
    });
  } catch (err) {
    return json(
      { error: "upstream_error", message: err.message || String(err) },
      err.status || 502
    );
  }
}

async function octopusGet(url, authHeader) {
  const res = await fetch(url, { headers: { Authorization: authHeader } });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const err = new Error(
      `Octopus API request failed (${res.status}) for ${url}: ${body.slice(0, 300)}`
    );
    err.status = res.status === 401 || res.status === 403 ? 502 : res.status;
    throw err;
  }
  return res.json();
}

async function fetchAllPages(firstUrl, authHeader) {
  let url = firstUrl;
  const results = [];
  while (url) {
    const page = await octopusGet(url, authHeader);
    if (Array.isArray(page.results)) results.push(...page.results);
    url = page.next || null;
  }
  return results;
}

function parseProductCode(tariffCode) {
  // e.g. "E-1R-AGILE-24-10-01-C" -> "AGILE-24-10-01"
  const match = /^[EG]-1R-(.+)-([A-Z])$/.exec(tariffCode || "");
  return match ? match[1] : null;
}

function findStandingCharge(segments, dayStartUTC) {
  for (const seg of segments) {
    if (dayStartUTC < seg.segStart || dayStartUTC >= seg.segEnd) continue;
    for (const charge of seg.charges) {
      const from = new Date(charge.valid_from);
      const to = charge.valid_to ? new Date(charge.valid_to) : null;
      if (dayStartUTC >= from && (!to || dayStartUTC < to)) {
        return charge.value_inc_vat;
      }
    }
  }
  return null;
}

function getLondonOffsetMinutes(date) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
    .formatToParts(date)
    .reduce((acc, p) => {
      acc[p.type] = p.value;
      return acc;
    }, {});
  const asUTC = Date.UTC(
    +parts.year,
    +parts.month - 1,
    +parts.day,
    +parts.hour === 24 ? 0 : +parts.hour,
    +parts.minute
  );
  return Math.round((asUTC - date.getTime()) / 60000);
}

function londonWallTimeToUTC(y, m, d, h = 0, mi = 0, s = 0) {
  const utcGuess = Date.UTC(y, m - 1, d, h, mi, s);
  const offsetMinutes = getLondonOffsetMinutes(new Date(utcGuess));
  return new Date(utcGuess - offsetMinutes * 60000);
}

function getCurrentLondonMonthRange() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .formatToParts(now)
    .reduce((acc, p) => {
      acc[p.type] = p.value;
      return acc;
    }, {});

  const monthStart = londonWallTimeToUTC(+parts.year, +parts.month, 1, 0, 0, 0);
  return { monthStart, periodEnd: now };
}

function londonDateKey(date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function londonDateKeyToUTC(dateKey) {
  const [y, m, d] = dateKey.split("-").map(Number);
  return londonWallTimeToUTC(y, m, d, 0, 0, 0);
}

function maxDate(a, b) {
  return a > b ? a : b;
}
function minDate(a, b) {
  return a < b ? a : b;
}
function round(n, dp) {
  const f = 10 ** dp;
  return Math.round((n + Number.EPSILON) * f) / f;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
