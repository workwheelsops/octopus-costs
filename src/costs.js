// Computes daily electricity cost for a date range (Europe/London), by
// combining half-hourly consumption with the half-hourly unit rates and
// standing charges that were in force at the time. Designed for Agile-style
// tariffs where the unit rate changes every 30 minutes, but also works for
// flat/dual-rate tariffs. The core per-day computation is shared between the
// current-month view (computeCosts) and the multi-month history view
// (computeHistory), since a date range spanning tariff changes already works
// correctly - agreements are matched by date overlap either way.

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

  const { monthStart, periodEnd } = getCurrentLondonMonthRange();

  try {
    const breakdown = await computeDailyBreakdown(env, monthStart, periodEnd, {
      includeProductMeta: true,
    });
    const { days } = breakdown;

    const totalCostPence = days.reduce((sum, d) => sum + d.costGBP * 100, 0);
    const totalKwh = days.reduce((sum, d) => sum + d.kwh, 0);
    const totalOffPeakCostGBP = round(days.reduce((sum, d) => sum + d.offPeakCostGBP, 0), 2);
    const totalOnPeakCostGBP = round(days.reduce((sum, d) => sum + d.onPeakCostGBP, 0), 2);
    const totalOffPeakKwh = round(days.reduce((sum, d) => sum + d.offPeakKwh, 0), 2);
    const totalOnPeakKwh = round(days.reduce((sum, d) => sum + d.onPeakKwh, 0), 2);
    const totalExportProfitGBP = round(days.reduce((sum, d) => sum + d.exportProfitGBP, 0), 2);

    // Axle Energy's VPP earnings aren't available via a personal API token
    // (only a partner/business-level "organisational token" can reach their
    // rewards endpoint), so this is entered manually as a fixed monthly
    // figure rather than pulled live.
    const axleVppProfitGBP = env.AXLE_VPP_PROFIT_GBP ? Number(env.AXLE_VPP_PROFIT_GBP) : 0;

    const averageDailyCostGBP = days.length
      ? round((totalCostPence / 100 - totalExportProfitGBP - axleVppProfitGBP) / days.length, 2)
      : 0;
    const daysInMonth = getDaysInLondonMonth(monthStart);
    const forecastCostGBP = round(averageDailyCostGBP * daysInMonth, 2);

    return json({
      accountNumber: breakdown.accountNumber,
      mpan: breakdown.mpan,
      meterSerial: breakdown.meterSerial,
      days,
      totalCostGBP: round(totalCostPence / 100, 2),
      totalKwh: round(totalKwh, 2),
      totalOffPeakCostGBP,
      totalOnPeakCostGBP,
      totalOffPeakKwh,
      totalOnPeakKwh,
      totalExportProfitGBP,
      axleVppProfitGBP,
      averageDailyCostGBP,
      daysInMonth,
      forecastCostGBP,
      monthStart: monthStart.toISOString(),
      generatedAt: new Date().toISOString(),
      debug: breakdown.debug,
    });
  } catch (err) {
    if (err.responseBody) return json(err.responseBody, err.status);
    return json(
      { error: "upstream_error", message: err.message || String(err) },
      err.status || 502
    );
  }
}

// Totals for each of the last HISTORY_MONTHS calendar months (default 24,
// Europe/London), including the current partial month. Reuses the exact
// same per-day pricing logic as computeCosts, just over a wider range and
// grouped by month afterwards - months on different tariffs are handled
// automatically since agreements are already matched by date overlap, not
// assumed to be constant.
export async function computeHistory(env) {
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

  const historyMonths = env.HISTORY_MONTHS ? Number(env.HISTORY_MONTHS) : 24;
  const monthKeys = getLastNMonthKeys(historyMonths);
  const rangeStart = monthKeyToLondonRange(monthKeys[0]).start;
  const { periodEnd: rangeEnd } = getCurrentLondonMonthRange();

  try {
    // Skip per-agreement product-metadata lookups here: a year can span many
    // more tariff changes than a single month, and each extra lookup is an
    // extra outbound request - not worth it for a summary view.
    const breakdown = await computeDailyBreakdown(env, rangeStart, rangeEnd, {
      includeProductMeta: false,
    });
    const { days } = breakdown;

    const monthTotals = new Map();
    for (const key of monthKeys) {
      monthTotals.set(key, {
        kwh: 0,
        costGBP: 0,
        offPeakCostGBP: 0,
        onPeakCostGBP: 0,
        standingChargeGBP: 0,
        exportProfitGBP: 0,
        daysWithData: 0,
        estimatedDays: 0,
      });
    }
    for (const d of days) {
      const entry = monthTotals.get(d.date.slice(0, 7));
      if (!entry) continue;
      entry.kwh += d.kwh;
      entry.costGBP += d.costGBP;
      entry.offPeakCostGBP += d.offPeakCostGBP;
      entry.onPeakCostGBP += d.onPeakCostGBP;
      entry.standingChargeGBP += d.standingChargeGBP;
      entry.exportProfitGBP += d.exportProfitGBP;
      entry.daysWithData++;
      if (d.estimated) entry.estimatedDays++;
    }

    // Which tariff(s) were active each month, since some months may differ.
    const allTariffSegments = [
      ...(breakdown.debug.tariffSegments || []),
      ...(breakdown.debug.export?.tariffSegments || []),
    ];
    for (const key of monthKeys) {
      const { start, end } = monthKeyToLondonRange(key);
      const effectiveEnd = minDate(end, rangeEnd);
      const overlapping = allTariffSegments.filter(
        (s) => new Date(s.segStart) < effectiveEnd && new Date(s.segEnd) > start
      );
      monthTotals.get(key).tariffCodes = [...new Set(overlapping.map((s) => s.tariffCode))];
    }

    const months = monthKeys.map((key) => {
      const e = monthTotals.get(key);
      return {
        month: key,
        kwh: round(e.kwh, 2),
        costGBP: round(e.costGBP, 2),
        offPeakCostGBP: round(e.offPeakCostGBP, 2),
        onPeakCostGBP: round(e.onPeakCostGBP, 2),
        standingChargeGBP: round(e.standingChargeGBP, 2),
        exportProfitGBP: round(e.exportProfitGBP, 2),
        netCostGBP: round(e.costGBP - e.exportProfitGBP, 2),
        daysWithData: e.daysWithData,
        estimatedDays: e.estimatedDays,
        tariffCodes: e.tariffCodes,
      };
    });

    return json({
      accountNumber: breakdown.accountNumber,
      mpan: breakdown.mpan,
      meterSerial: breakdown.meterSerial,
      months,
      periodFrom: rangeStart.toISOString(),
      periodTo: rangeEnd.toISOString(),
      generatedAt: new Date().toISOString(),
      debug: breakdown.debug,
    });
  } catch (err) {
    if (err.responseBody) return json(err.responseBody, err.status);
    return json(
      { error: "upstream_error", message: err.message || String(err) },
      err.status || 502
    );
  }
}

// Shared core: fetches the account, resolves the import (and export) meter,
// prices every consumption slot in [rangeStart, rangeEnd), and returns a
// per-day breakdown. Throws an error carrying .responseBody/.status for
// structured API errors (e.g. no meter found); callers translate that to a
// JSON response.
async function computeDailyBreakdown(env, rangeStart, rangeEnd, { includeProductMeta = true } = {}) {
  const apiKey = env.OCTOPUS_API_KEY;
  const accountNumber = env.OCTOPUS_ACCOUNT_NUMBER;
  const authHeader = "Basic " + btoa(`${apiKey}:`);

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
    throw apiError({ error: "no_meter_point", message: "No electricity meter point found on this account." }, 404);
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
    throw apiError({ error: "no_meter", message: "No meter found on the electricity meter point." }, 404);
  }
  const serial = meter.serial_number;
  const agreements = meterPoint.agreements || [];

  const consumption = await fetchAllPages(
    `${OCTOPUS_BASE}/electricity-meter-points/${mpan}/meters/${serial}/consumption/` +
      `?period_from=${rangeStart.toISOString()}&period_to=${rangeEnd.toISOString()}` +
      `&page_size=25000&order_by=period`,
    authHeader
  );

  // If this range is empty, check whether the meter has ever reported any
  // half-hourly data via the API at all (helps tell "meter isn't smart /
  // hasn't shared data yet" apart from "just this range is missing").
  let mostRecentReadingAt = null;
  if (consumption.length === 0) {
    const latest = await octopusGet(
      `${OCTOPUS_BASE}/electricity-meter-points/${mpan}/meters/${serial}/consumption/` +
        `?page_size=1&order_by=-period`,
      authHeader
    ).catch(() => null);
    mostRecentReadingAt = latest?.results?.[0]?.interval_start ?? null;
  }

  const rateContext = await buildRateContext(agreements, rangeStart, rangeEnd, authHeader, {
    includeProductMeta,
  });
  const { rateMap, standingSegments, tariffSegments } = rateContext;

  // Intelligent Octopus Go's real off-peak eligibility isn't just the
  // advertised 23:30-05:30 window: Octopus grants extra "smart charge"
  // dispatch windows on top of it, which vary night to night. Fetch the
  // account's actual completed dispatches via the (separate) GraphQL API
  // so those bonus windows count as off-peak too.
  const { dispatchWindows, dispatchDebug } = await fetchDispatchWindows(
    apiKey,
    accountNumber,
    rangeStart,
    rangeEnd
  );

  // Intelligent Octopus Go also bills any energy routed through the smart
  // charging system at the off-peak rate regardless of clock time - both a
  // session that overruns the guaranteed window to hit its target, and a
  // manual daytime top-up. There's no clean API field for "this reading was
  // EV-routed", so approximate it: a half-hour slot using unusually high
  // power (well above normal appliance baseline) is assumed to be EV
  // charging. Tune via OCTOPUS_EV_THRESHOLD_KWH if 2 kWh/slot (~4kW) is
  // wrong for this household's charger/appliances.
  const evThresholdKwh = env.OCTOPUS_EV_THRESHOLD_KWH ? Number(env.OCTOPUS_EV_THRESHOLD_KWH) : 2;

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
          `?period_from=${rangeStart.toISOString()}&period_to=${rangeEnd.toISOString()}` +
          `&page_size=25000&order_by=period`,
        authHeader
      ).catch(() => []);

      const exportRateContext = await buildRateContext(
        exportMeterPoint.agreements || [],
        rangeStart,
        rangeEnd,
        authHeader,
        { includeProductMeta }
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
  // Debug: kWh summed per half-hour-of-day bucket (London local), across the
  // whole range, so a boundary/classification bug shows up as a spike right
  // at the 23:30 or 05:30 edge rather than being spread evenly through the
  // day.
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

  const sampleSlot = consumption[0];
  const sampleRateKeys = [...rateMap.keys()].slice(0, 3).map((t) => new Date(t).toISOString());

  return {
    accountNumber,
    mpan,
    meterSerial: serial,
    days,
    debug: {
      propertyCount: properties.length,
      meterPointCount: meterPoints.length,
      meterPointMpans: meterPoints.map((mp) => ({ mpan: mp.mpan, isExport: !!mp.is_export })),
      metersOnThisMeterPoint: meters.map((m) => m.serial_number),
      agreementCount: agreements.length,
      periodFrom: rangeStart.toISOString(),
      periodTo: rangeEnd.toISOString(),
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
  };
}

function apiError(body, status) {
  const err = new Error(body.message || body.error);
  err.responseBody = body;
  err.status = status;
  return err;
}

// Builds a rate lookup for a set of agreements (from one meter point) over
// [rangeStart, rangeEnd]: a half-hourly rateMap for tariffs that publish
// standard-unit-rates, plus dayNightSegments as a fallback for tariffs that
// only publish flat day/night rates (e.g. Intelligent Octopus Go), plus
// standingSegments (irrelevant for export meter points, but harmless).
// includeProductMeta adds one extra lookup per agreement purely for
// diagnostics - skip it for wide ranges with many tariff changes to keep the
// outbound request count down.
async function buildRateContext(
  agreements,
  rangeStart,
  rangeEnd,
  authHeader,
  { includeProductMeta = true } = {}
) {
  const rateMap = new Map(); // instant (ms since epoch) -> value_inc_vat (pence)
  const rateSegments = []; // { segStart, segEnd, rates: [...] } - fallback for sparse rate records
  const standingSegments = []; // { segStart, segEnd, charges: [...] }
  const dayNightSegments = []; // { segStart, segEnd, dayRates: [...], nightRates: [...] }
  const tariffSegments = []; // debug: what was queried and what came back

  for (const agreement of agreements) {
    const validFrom = new Date(agreement.valid_from);
    const validTo = agreement.valid_to ? new Date(agreement.valid_to) : rangeEnd;
    const segStart = maxDate(validFrom, rangeStart);
    const segEnd = minDate(validTo, rangeEnd);
    if (segStart >= segEnd) continue;

    const tariffCode = agreement.tariff_code;
    const productCode = parseProductCode(tariffCode);
    const segmentDebug = { tariffCode, productCode, segStart: segStart.toISOString(), segEnd: segEnd.toISOString() };
    tariffSegments.push(segmentDebug);
    if (!tariffCode || !productCode) {
      segmentDebug.error = "Could not derive a product code from this tariff code.";
      continue;
    }

    if (includeProductMeta) {
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
    }

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

      if (rates.length > 0) {
        segmentDebug.rateSample = rates.slice(0, 5).map((r) => ({
          valid_from: r.valid_from,
          valid_to: r.valid_to,
          value_inc_vat: r.value_inc_vat,
        }));
        // Not every "standard-unit-rates" tariff actually changes every 30
        // minutes: some fixed tariffs publish it too, but with a handful of
        // records each covering a wide validity window (days, not a single
        // slot). The exact-instant map above only ever matches the first
        // slot after each such change, so keep the raw records too and fall
        // back to interval-containment matching (lookupRate) when the map
        // misses - cheap since it only runs for the slots that need it.
        const distinctValues = [...new Set(rates.map((r) => r.value_inc_vat))];
        // A handful of distinct values repeating over many records (as
        // opposed to genuine Agile, where almost every record is a unique
        // half-hourly price) means this is really a disguised day/night
        // tariff published via standard-unit-rates instead of the dedicated
        // day/night endpoints - so the same "EV charging outside the window
        // still gets the cheap rate" rule should apply here too.
        const isLikelyFixedDualRate = distinctValues.length <= 4;
        segmentDebug.distinctRateValueCount = distinctValues.length;
        segmentDebug.isLikelyFixedDualRate = isLikelyFixedDualRate;
        rateSegments.push({
          segStart,
          segEnd,
          rates,
          minRate: Math.min(...distinctValues),
          isLikelyFixedDualRate,
        });
      }

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
        } else if (includeProductMeta) {
          // Genuinely nothing published anywhere for this tariff: probe
          // with no date filter to confirm it's not just this window. Only
          // bother for the single-month view - not worth another request
          // per historical tariff segment.
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

  return { rateMap, rateSegments, standingSegments, dayNightSegments, tariffSegments };
}

// Looks up the rate (pence/kWh inc VAT) for one consumption slot: the
// half-hourly rateMap (exact instant match) or interval-containment fallback
// for the same segment, then the day/night fallback if neither has anything.
function lookupRate(slotInstant, kwh, rateContext, dispatchWindows, evThresholdKwh) {
  const rateSeg = rateContext.rateSegments.find(
    (s) => slotInstant >= s.segStart && slotInstant < s.segEnd
  );

  // Exact-instant match first (the common case for genuine half-hourly
  // tariffs); fall back to interval containment for sparse ones where most
  // slots fall inside a wider validity window rather than matching exactly.
  let rate = rateContext.rateMap.get(slotInstant.getTime());
  if (rate == null && rateSeg) {
    rate = findActiveRate(rateSeg.rates, slotInstant);
  }

  if (rate != null) {
    // Intelligent Octopus Go-style tariffs bill EV smart-charge sessions at
    // the off-peak rate regardless of clock time. Some standard-unit-rates
    // tariffs are really a disguised day/night tariff (see
    // isLikelyFixedDualRate) rather than genuine Agile, so the same rule
    // should apply there too - whichever path supplied the exact rate.
    if (
      rateSeg?.isLikelyFixedDualRate &&
      kwh >= evThresholdKwh &&
      !isStandardOffPeakWindow(slotInstant) &&
      rateSeg.minRate < rate
    ) {
      return rateSeg.minRate;
    }
    return rate;
  }

  const dayNightSeg = rateContext.dayNightSegments.find(
    (s) => slotInstant >= s.segStart && slotInstant < s.segEnd
  );
  if (!dayNightSeg) return null;
  const rates = isOffPeak(slotInstant, kwh, dispatchWindows, evThresholdKwh)
    ? dayNightSeg.nightRates
    : dayNightSeg.dayRates;
  return findActiveRate(rates, slotInstant);
}

// Fetches the account's actual smart-charge dispatch history via Octopus's
// GraphQL (Kraken) API, which is separate from the REST v1 API and needs its
// own JWT obtained from the API key. Degrades gracefully (empty windows) if
// this account isn't on a smart/Intelligent tariff or the call fails, since
// the standard off-peak window still applies either way.
async function fetchDispatchWindows(apiKey, accountNumber, rangeStart, rangeEnd) {
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
      .filter((w) => w.end > rangeStart && w.start < rangeEnd);

    return {
      dispatchWindows: windows,
      dispatchDebug: {
        totalDispatchesEver: raw.length,
        dispatchesInRange: windows.length,
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

// { y, m } for the London calendar month `monthsAgo` months before the
// current one (0 = this month).
function getLondonYearMonth(monthsAgo) {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
  })
    .formatToParts(now)
    .reduce((acc, p) => {
      acc[p.type] = p.value;
      return acc;
    }, {});
  let y = +parts.year;
  let m = +parts.month - monthsAgo;
  while (m <= 0) {
    m += 12;
    y -= 1;
  }
  return { y, m };
}

// ["YYYY-MM", ...] for the last 12 calendar months, oldest first, ending
// with the current (possibly partial) month.
function getLastNMonthKeys(n) {
  const keys = [];
  for (let i = n - 1; i >= 0; i--) {
    const { y, m } = getLondonYearMonth(i);
    keys.push(`${y}-${String(m).padStart(2, "0")}`);
  }
  return keys;
}

// UTC instants for the start (inclusive) and end (exclusive) of a "YYYY-MM"
// London calendar month.
function monthKeyToLondonRange(monthKey) {
  const [y, m] = monthKey.split("-").map(Number);
  const start = londonWallTimeToUTC(y, m, 1, 0, 0, 0);
  let ny = y;
  let nm = m + 1;
  if (nm > 12) {
    nm = 1;
    ny += 1;
  }
  const end = londonWallTimeToUTC(ny, nm, 1, 0, 0, 0);
  return { start, end };
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
