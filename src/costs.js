// Computes daily and month-to-date electricity cost for the current calendar
// month (Europe/London), by combining half-hourly consumption with the
// half-hourly unit rates and standing charges that were in force at the time.
// Designed for Agile-style tariffs where the unit rate changes every 30
// minutes, but also works for flat tariffs (the rate is just constant).

const OCTOPUS_BASE = "https://api.octopus.energy/v1";
const KRAKEN_GRAPHQL_URL = "https://api.octopus.energy/v1/graphql/";

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
    // since export meter points report energy sent out, not consumed. An
    // explicit override is available in case a account has an unusual setup.
    const meterPoint = env.OCTOPUS_MPAN
      ? meterPoints.find((mp) => mp.mpan === env.OCTOPUS_MPAN)
      : meterPoints.find((mp) => !mp.is_export) || meterPoints[0];
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
    const meters = meterPoint.meters || [];
    // If a meter exchange has happened, several meters can be listed for the
    // same meter point. Allow pinning the exact one via an env var; otherwise
    // assume the last-listed meter is the current one (Octopus lists them in
    // installation order).
    const meter = env.OCTOPUS_METER_SERIAL
      ? meters.find((m) => m.serial_number === env.OCTOPUS_METER_SERIAL) || {
          serial_number: env.OCTOPUS_METER_SERIAL,
        }
      : meters[meters.length - 1];
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

    const rateContext = await buildRateContext(agreements, monthStart, periodEnd, authHeader);
    const { rateMap, dayNightSegments, standingSegments, tariffSegments } = rateContext;

    // Intelligent Octopus Go's real off-peak eligibility isn't just the
    // advertised 23:30-05:30 window: Octopus grants extra "smart charge"
    // dispatch windows on top of it, which vary night to night. Fetch the
    // account's actual completed dispatches via the (separate) GraphQL API
    // so those bonus windows count as off-peak too.
    const { dispatchWindows, dispatchDebug } = await fetchDispatchWindows(
      apiKey,
      accountNumber,
      monthStart,
      periodEnd
    );

    // Intelligent Octopus Go also bills any energy routed through the smart
    // charging system at the off-peak rate regardless of clock time - both a
    // session that overruns the guaranteed window to hit its target, and a
    // manual daytime top-up. There's no clean API field for "this reading was
    // EV-routed", so approximate it: a half-hour slot using unusually high
    // power (well above normal appliance baseline) is assumed to be EV
    // charging. Tune via OCTOPUS_EV_THRESHOLD_KWH if 2 kWh/slot (~4kW) is
    // wrong for this household's charger/appliances.
    const evThresholdKwh = env.OCTOPUS_EV_THRESHOLD_KWH
      ? Number(env.OCTOPUS_EV_THRESHOLD_KWH)
      : 2;

    // Export: many solar accounts have a second, export-only meter point.
    // Auto-detect it and price its consumption (= energy sent to the grid)
    // the same way, to work out export earnings per day.
    const exportMeterPoint = env.OCTOPUS_EXPORT_MPAN
      ? meterPoints.find((mp) => mp.mpan === env.OCTOPUS_EXPORT_MPAN)
      : meterPoints.find((mp) => mp.is_export);
    const exportByDate = new Map(); // londonDateKey -> profitPence
    let exportDebug = null;

    if (exportMeterPoint) {
      const exportMeters = exportMeterPoint.meters || [];
      const exportMeter = env.OCTOPUS_EXPORT_METER_SERIAL
        ? exportMeters.find((m) => m.serial_number === env.OCTOPUS_EXPORT_METER_SERIAL) || {
            serial_number: env.OCTOPUS_EXPORT_METER_SERIAL,
          }
        : exportMeters[exportMeters.length - 1];

      if (exportMeter) {
        const exportMpan = exportMeterPoint.mpan;
        const exportSerial = exportMeter.serial_number;
        const exportConsumption = await fetchAllPages(
          `${OCTOPUS_BASE}/electricity-meter-points/${exportMpan}/meters/${exportSerial}/consumption/` +
            `?period_from=${monthStart.toISOString()}&period_to=${periodEnd.toISOString()}` +
            `&page_size=25000&order_by=period`,
          authHeader
        ).catch(() => []);

        const exportRateContext = await buildRateContext(
          exportMeterPoint.agreements || [],
          monthStart,
          periodEnd,
          authHeader
        );

        let totalExportKwh = 0;
        let slotsWithNoRate = 0;
        for (const slot of exportConsumption) {
          const kwh = slot.consumption;
          totalExportKwh += kwh;
          const slotInstant = new Date(slot.interval_start);
          const rate = lookupRate(slotInstant, kwh, exportRateContext, dispatchWindows, evThresholdKwh);
          if (rate == null) {
            slotsWithNoRate++;
            continue;
          }
          const dateKey = londonDateKey(slotInstant);
          exportByDate.set(dateKey, (exportByDate.get(dateKey) || 0) + kwh * rate);
        }

        exportDebug = {
          mpan: exportMpan,
          meterSerial: exportSerial,
          rawConsumptionRecordCount: exportConsumption.length,
          totalExportKwh: round(totalExportKwh, 3),
          slotsWithNoRate,
          sampleReadings: exportConsumption.slice(0, 3).map((s) => ({
            interval_start: s.interval_start,
            consumption: s.consumption,
          })),
          tariffSegments: exportRateContext.tariffSegments,
        };
      }
    }

    const dayMap = new Map(); // londonDateKey -> { kwh, costPence, missingRate }
    // Debug: kWh summed per half-hour-of-day bucket (London local), across all
    // days, so a boundary/classification bug shows up as a spike right at the
    // 23:30 or 05:30 edge rather than being spread evenly through the day.
    const hourBuckets = Array.from({ length: 48 }, () => ({ kwh: 0, offPeak: null }));
    let evThresholdReclassifiedKwh = 0;
    let evThresholdReclassifiedSlots = 0;

    for (const slot of consumption) {
      const kwh = slot.consumption;
      const slotInstant = new Date(slot.interval_start);
      const standardOffPeak = isStandardOffPeakWindow(slotInstant);
      const offPeak = isOffPeak(slotInstant, kwh, dispatchWindows, evThresholdKwh);
      if (offPeak && !standardOffPeak && kwh >= evThresholdKwh) {
        evThresholdReclassifiedKwh += kwh;
        evThresholdReclassifiedSlots++;
      }
      const rate = lookupRate(slotInstant, kwh, rateContext, dispatchWindows, evThresholdKwh);
      const dateKey = londonDateKey(slotInstant);

      const londonMinutes = getLondonMinutesOfDay(slotInstant);
      const bucketIndex = Math.floor(londonMinutes / 30);
      hourBuckets[bucketIndex].kwh += kwh;
      hourBuckets[bucketIndex].offPeak = offPeak;
      const entry =
        dayMap.get(dateKey) ||
        {
          kwh: 0,
          costPence: 0,
          missingRate: false,
          offPeakKwh: 0,
          offPeakCostPence: 0,
          onPeakKwh: 0,
          onPeakCostPence: 0,
        };
      entry.kwh += kwh;
      if (offPeak) entry.offPeakKwh += kwh;
      else entry.onPeakKwh += kwh;
      if (rate != null) {
        const cost = kwh * rate;
        entry.costPence += cost;
        if (offPeak) entry.offPeakCostPence += cost;
        else entry.onPeakCostPence += cost;
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
      entry.exportProfitPence = exportByDate.get(dateKey) ?? 0;
    }

    const days = [...dayMap.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([date, e]) => ({
        date,
        kwh: round(e.kwh, 3),
        standingChargeGBP: round(e.standingChargePence / 100, 2),
        costGBP: round(e.costPence / 100, 2),
        offPeakKwh: round(e.offPeakKwh, 3),
        offPeakCostGBP: round(e.offPeakCostPence / 100, 2),
        onPeakKwh: round(e.onPeakKwh, 3),
        onPeakCostGBP: round(e.onPeakCostPence / 100, 2),
        exportProfitGBP: round(e.exportProfitPence / 100, 2),
        estimated: e.missingRate,
      }));

    const totalCostPence = days.reduce((sum, d) => sum + d.costGBP * 100, 0);
    const totalKwh = days.reduce((sum, d) => sum + d.kwh, 0);
    const totalOffPeakCostGBP = round(days.reduce((sum, d) => sum + d.offPeakCostGBP, 0), 2);
    const totalOnPeakCostGBP = round(days.reduce((sum, d) => sum + d.onPeakCostGBP, 0), 2);
    const totalOffPeakKwh = round(days.reduce((sum, d) => sum + d.offPeakKwh, 0), 2);
    const totalOnPeakKwh = round(days.reduce((sum, d) => sum + d.onPeakKwh, 0), 2);
    const totalExportProfitGBP = round(days.reduce((sum, d) => sum + d.exportProfitGBP, 0), 2);

    const sampleSlot = consumption[0];
    const sampleRateKeys = [...rateMap.keys()].slice(0, 3).map((t) => new Date(t).toISOString());

    const averageDailyCostGBP = days.length
      ? round((totalCostPence / 100 - totalExportProfitGBP) / days.length, 2)
      : 0;
    const daysInMonth = getDaysInLondonMonth(monthStart);
    const forecastCostGBP = round(averageDailyCostGBP * daysInMonth, 2);

    return json({
      accountNumber,
      mpan,
      meterSerial: serial,
      days,
      totalCostGBP: round(totalCostPence / 100, 2),
      totalKwh: round(totalKwh, 2),
      totalOffPeakCostGBP,
      totalOnPeakCostGBP,
      totalOffPeakKwh,
      totalOnPeakKwh,
      totalExportProfitGBP,
      averageDailyCostGBP,
      daysInMonth,
      forecastCostGBP,
      monthStart: monthStart.toISOString(),
      generatedAt: new Date().toISOString(),
      debug: {
        propertyCount: properties.length,
        meterPointCount: meterPoints.length,
        meterPointMpans: meterPoints.map((mp) => ({ mpan: mp.mpan, isExport: !!mp.is_export })),
        metersOnThisMeterPoint: meters.map((m) => m.serial_number),
        agreementCount: agreements.length,
        periodFrom: monthStart.toISOString(),
        periodTo: periodEnd.toISOString(),
        rawConsumptionRecordCount: consumption.length,
        mostRecentReadingAt,
        tariffSegments,
        rateMapSize: rateMap.size,
        sampleConsumptionIntervalStart: sampleSlot?.interval_start ?? null,
        sampleRateKeys,
        export: exportDebug,
        dispatches: dispatchDebug,
        evThresholdKwh,
        evThresholdReclassifiedKwh: round(evThresholdReclassifiedKwh, 3),
        evThresholdReclassifiedSlots,
        hourBuckets: hourBuckets.map((b, i) => ({
          time: `${String(Math.floor((i * 30) / 60)).padStart(2, "0")}:${String((i * 30) % 60).padStart(2, "0")}`,
          kwh: round(b.kwh, 3),
          offPeak: b.offPeak,
        })),
      },
    });
  } catch (err) {
    return json(
      { error: "upstream_error", message: err.message || String(err) },
      err.status || 502
    );
  }
}

// Builds a rate lookup for a set of agreements (from one meter point) over
// [monthStart, periodEnd]: a half-hourly rateMap for tariffs that publish
// standard-unit-rates, plus dayNightSegments as a fallback for tariffs that
// only publish flat day/night rates (e.g. Intelligent Octopus Go), plus
// standingSegments (irrelevant for export meter points, but harmless).
async function buildRateContext(agreements, monthStart, periodEnd, authHeader) {
  const rateMap = new Map(); // instant (ms since epoch) -> value_inc_vat (pence)
  const standingSegments = []; // { segStart, segEnd, charges: [...] }
  const dayNightSegments = []; // { segStart, segEnd, dayRates: [...], nightRates: [...] }
  const tariffSegments = []; // debug: what was queried and what came back

  for (const agreement of agreements) {
    const validFrom = new Date(agreement.valid_from);
    const validTo = agreement.valid_to ? new Date(agreement.valid_to) : periodEnd;
    const segStart = maxDate(validFrom, monthStart);
    const segEnd = minDate(validTo, periodEnd);
    if (segStart >= segEnd) continue;

    const tariffCode = agreement.tariff_code;
    const productCode = parseProductCode(tariffCode);
    const segmentDebug = { tariffCode, productCode, segStart: segStart.toISOString(), segEnd: segEnd.toISOString() };
    tariffSegments.push(segmentDebug);
    if (!tariffCode || !productCode) {
      segmentDebug.error = "Could not derive a product code from this tariff code.";
      continue;
    }

    const product = await octopusGet(`${OCTOPUS_BASE}/products/${productCode}/`, authHeader).catch(
      (e) => ({ error: e.message })
    );
    segmentDebug.product = product?.error
      ? { error: product.error }
      : {
          fullName: product.full_name,
          displayName: product.display_name,
          isVariable: product.is_variable,
          isBusiness: product.is_business,
          direction: product.direction,
          availableFrom: product.available_from,
          availableTo: product.available_to,
        };

    try {
      const rates = await fetchAllPages(
        `${OCTOPUS_BASE}/products/${productCode}/electricity-tariffs/${tariffCode}/standard-unit-rates/` +
          `?period_from=${segStart.toISOString()}&period_to=${segEnd.toISOString()}&page_size=25000`,
        authHeader
      );
      // Key by instant, not the raw string: Octopus's consumption endpoint
      // can return interval_start with a local UTC offset (e.g. "+01:00"
      // during BST) while rates' valid_from uses "Z" for the same instant,
      // so string equality would silently miss every match.
      for (const r of rates) rateMap.set(new Date(r.valid_from).getTime(), r.value_inc_vat);
      segmentDebug.rateRecordCount = rates.length;

      if (rates.length === 0) {
        // Some fixed dual-rate tariffs (e.g. Intelligent Octopus Go) don't
        // publish half-hourly rates via standard-unit-rates at all; they
        // expose one flat day rate and one flat night rate instead.
        const dayRates = await fetchAllPages(
          `${OCTOPUS_BASE}/products/${productCode}/electricity-tariffs/${tariffCode}/day-unit-rates/` +
            `?period_from=${segStart.toISOString()}&period_to=${segEnd.toISOString()}&page_size=25000`,
          authHeader
        ).catch(() => []);
        const nightRates = await fetchAllPages(
          `${OCTOPUS_BASE}/products/${productCode}/electricity-tariffs/${tariffCode}/night-unit-rates/` +
            `?period_from=${segStart.toISOString()}&period_to=${segEnd.toISOString()}&page_size=25000`,
          authHeader
        ).catch(() => []);
        segmentDebug.dayRateRecordCount = dayRates.length;
        segmentDebug.nightRateRecordCount = nightRates.length;

        if (dayRates.length > 0 || nightRates.length > 0) {
          dayNightSegments.push({ segStart, segEnd, dayRates, nightRates });
        } else {
          // Genuinely nothing published anywhere for this tariff: probe
          // with no date filter to confirm it's not just this window.
          const probe = await octopusGet(
            `${OCTOPUS_BASE}/products/${productCode}/electricity-tariffs/${tariffCode}/standard-unit-rates/?page_size=3`,
            authHeader
          ).catch((e) => ({ error: e.message }));
          if (probe?.error) {
            segmentDebug.rateProbeError = probe.error;
          } else {
            segmentDebug.rateProbe = {
              totalCountEver: probe?.count ?? null,
              sample: (probe?.results || []).map((r) => ({
                valid_from: r.valid_from,
                valid_to: r.valid_to,
                value_inc_vat: r.value_inc_vat,
              })),
            };
          }
        }
      }
    } catch (err) {
      segmentDebug.rateError = err.message;
    }

    try {
      const charges = await fetchAllPages(
        `${OCTOPUS_BASE}/products/${productCode}/electricity-tariffs/${tariffCode}/standing-charges/` +
          `?period_from=${segStart.toISOString()}&period_to=${segEnd.toISOString()}&page_size=25000`,
        authHeader
      );
      standingSegments.push({ segStart, segEnd, charges });
      segmentDebug.standingChargeRecordCount = charges.length;
    } catch (err) {
      segmentDebug.standingChargeError = err.message;
    }
  }

  return { rateMap, standingSegments, dayNightSegments, tariffSegments };
}

// Looks up the rate (pence/kWh inc VAT) for one consumption slot: first the
// half-hourly rateMap, then the day/night fallback if that misses.
function lookupRate(slotInstant, kwh, rateContext, dispatchWindows, evThresholdKwh) {
  const rate = rateContext.rateMap.get(slotInstant.getTime());
  if (rate != null) return rate;
  const seg = rateContext.dayNightSegments.find(
    (s) => slotInstant >= s.segStart && slotInstant < s.segEnd
  );
  if (!seg) return null;
  const rates = isOffPeak(slotInstant, kwh, dispatchWindows, evThresholdKwh)
    ? seg.nightRates
    : seg.dayRates;
  return findActiveRate(rates, slotInstant);
}

// Fetches the account's actual smart-charge dispatch history via Octopus's
// GraphQL (Kraken) API, which is separate from the REST v1 API and needs its
// own JWT obtained from the API key. Degrades gracefully (empty windows) if
// this account isn't on a smart/Intelligent tariff or the call fails, since
// the standard off-peak window still applies either way.
async function fetchDispatchWindows(apiKey, accountNumber, monthStart, periodEnd) {
  try {
    const tokenRes = await fetch(KRAKEN_GRAPHQL_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query:
          "mutation krakenTokenAuthentication($input: ObtainJSONWebTokenInput!) { " +
          "obtainKrakenToken(input: $input) { token } }",
        variables: { input: { APIKey: apiKey } },
      }),
    });
    const tokenData = await tokenRes.json();
    if (tokenData.errors?.length) {
      return {
        dispatchWindows: [],
        dispatchDebug: { step: "auth", errors: tokenData.errors.map((e) => e.message) },
      };
    }
    const token = tokenData.data?.obtainKrakenToken?.token;
    if (!token) {
      return { dispatchWindows: [], dispatchDebug: { step: "auth", error: "No token returned" } };
    }

    const dispatchRes = await fetch(KRAKEN_GRAPHQL_URL, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: token },
      body: JSON.stringify({
        query:
          "query getCompletedDispatches($accountNumber: String!) { " +
          "completedDispatches(accountNumber: $accountNumber) { start end delta meta { source location } } }",
        variables: { accountNumber },
      }),
    });
    const dispatchData = await dispatchRes.json();
    if (dispatchData.errors?.length) {
      return {
        dispatchWindows: [],
        dispatchDebug: { step: "completedDispatches", errors: dispatchData.errors.map((e) => e.message) },
      };
    }

    const raw = dispatchData.data?.completedDispatches ?? [];
    const windows = raw
      .filter((d) => d.start && d.end)
      .map((d) => ({ start: new Date(d.start), end: new Date(d.end) }))
      .filter((w) => w.end > monthStart && w.start < periodEnd);

    return {
      dispatchWindows: windows,
      dispatchDebug: {
        totalDispatchesEver: raw.length,
        dispatchesThisMonth: windows.length,
        sample: raw.slice(0, 3),
      },
    };
  } catch (err) {
    return { dispatchWindows: [], dispatchDebug: { step: "exception", error: err.message } };
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

function findActiveRate(records, instant) {
  for (const r of records) {
    const from = new Date(r.valid_from);
    const to = r.valid_to ? new Date(r.valid_to) : null;
    if (instant >= from && (!to || instant < to)) return r.value_inc_vat;
  }
  return null;
}

// Intelligent Octopus Go's advertised baseline off-peak window: 23:30 to
// 05:30, daily, Europe/London local time. Octopus tops this up with extra
// "smart charge" dispatch windows on top, which vary night to night -
// see isOffPeak below, which is what should actually be used for pricing.
function isStandardOffPeakWindow(date) {
  const minutesOfDay = getLondonMinutesOfDay(date);
  const offPeakStart = 23 * 60 + 30;
  const offPeakEnd = 5 * 60 + 30;
  return minutesOfDay >= offPeakStart || minutesOfDay < offPeakEnd;
}

function getLondonMinutesOfDay(date) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
    .formatToParts(date)
    .reduce((acc, p) => {
      acc[p.type] = p.value;
      return acc;
    }, {});
  return (+parts.hour % 24) * 60 + +parts.minute;
}

// A slot is off-peak if it's within the standard baseline window, within one
// of the account's actual smart-charge dispatch windows for that night, or
// (heuristically) drawing enough power that it's almost certainly an EV
// charging session rather than ordinary appliance use - Intelligent Octopus
// Go bills those at the off-peak rate wherever they fall in the day.
function isOffPeak(date, kwh, dispatchWindows, evThresholdKwh) {
  if (isStandardOffPeakWindow(date)) return true;
  if (kwh >= evThresholdKwh) return true;
  return dispatchWindows.some((w) => date >= w.start && date < w.end);
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

function getDaysInLondonMonth(monthStart) {
  const [y, m] = londonDateKey(monthStart).split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
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
