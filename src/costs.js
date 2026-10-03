// Computes daily electricity cost for a date range (Europe/London), by
// combining half-hourly consumption with the half-hourly unit rates and
// standing charges that were in force at the time. Designed for Agile-style
// tariffs where the unit rate changes every 30 minutes, but also works for
// flat/dual-rate tariffs. The core per-day computation is shared between the
// current-month view (computeCosts) and the multi-month history views
// (computeHistoricalMonths / computeCurrentMonthHistory), since a date range
// spanning tariff changes already works correctly - agreements are matched
// by date overlap either way.

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

    const axleVppProfitGBP = getAxleVppProfitGBP(env, londonDateKey(monthStart).slice(0, 7));

    // Average daily cost nets off solar export only, not Axle VPP profit.
    const averageDailyCostGBP = days.length
      ? round((totalCostPence / 100 - totalExportProfitGBP) / days.length, 2)
      : 0;
    const daysInMonth = getDaysInLondonMonth(monthStart);
    // The forecast is estimated from electricity alone first, then Axle VPP
    // profit entered for the month is subtracted once as a flat amount -
    // not extrapolated to a daily rate, since Axle income isn't assumed to
    // accrue evenly through the month the way electricity cost is.
    const electricityForecastGBP = round(averageDailyCostGBP * daysInMonth, 2);
    const forecastCostGBP = round(electricityForecastGBP - axleVppProfitGBP, 2);

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

// Finds when the account switched (and stuck with) an Intelligent Octopus
// Go-family tariff, and whatever tariff was active immediately before that -
// based on the account's raw agreement history, independent of whatever date
// range is being queried/priced. This means it gives the same answer whether
// called for a one-month or a 24-month window, which matters now that
// history is computed in separate historical/current-month chunks.
function detectTariffSwitch(agreements) {
  const candidates = (agreements || [])
    .filter((a) => a.tariff_code)
    .map((a) => ({
      tariffCode: a.tariff_code,
      productCode: parseProductCode(a.tariff_code),
      validFrom: new Date(a.valid_from),
      validTo: a.valid_to ? new Date(a.valid_to) : null,
    }))
    .filter((a) => a.productCode)
    .sort((a, b) => a.validFrom - b.validFrom);

  // Walk backward from the most recent agreement through the unbroken
  // trailing run of Intelligent Octopus Go-family tariffs, to find when the
  // switch that's still in effect actually happened - not just the
  // first-ever match, which could be an earlier trial that was later
  // abandoned (e.g. switching to Intelligent, back to Agile, then to
  // Intelligent for good).
  let switchAgreement = null;
  for (let i = candidates.length - 1; i >= 0; i--) {
    if (/INTELLI|IOG/i.test(candidates[i].productCode)) {
      switchAgreement = candidates[i];
    } else {
      break;
    }
  }
  if (!switchAgreement) return null;

  const switchDate = switchAgreement.validFrom;
  const baseline = candidates
    .filter((a) => a.validTo && a.validTo.getTime() <= switchDate.getTime())
    .sort((a, b) => b.validTo - a.validTo)[0];
  if (!baseline) return null;

  return { switchDate, baselineTariffCode: baseline.tariffCode };
}

// Compares actual cost since switching to an Intelligent Octopus Go-family
// tariff against what the exact same real usage would have cost on whatever
// tariff was active immediately before, using that tariff's real published
// rates for the same period (it's still a live product on Octopus's side
// even though this account has moved off it). Returns null if no such
// switch is found in the account's history. `consumption` only needs to
// cover whatever range is being priced by the caller - the switch/baseline
// detection itself always looks at the full agreement history regardless.
async function computeSwitchSavings(agreements, consumption, authHeader, rangeEnd, evThresholdKwh) {
  const switchInfo = detectTariffSwitch(agreements);
  if (!switchInfo) return null;
  const { switchDate, baselineTariffCode } = switchInfo;

  const fakeAgreement = {
    tariff_code: baselineTariffCode,
    valid_from: switchDate.toISOString(),
    valid_to: null,
  };
  const baselineContext = await buildRateContext(
    [fakeAgreement],
    switchDate,
    rangeEnd,
    authHeader,
    { includeProductMeta: true }
  );

  const hypotheticalByDate = new Map(); // londonDateKey -> costPence
  const slotCoverageByMonth = new Map(); // monthKey -> { total, missing }

  for (const slot of consumption) {
    const slotInstant = new Date(slot.interval_start);
    if (slotInstant < switchDate || slotInstant >= rangeEnd) continue;
    const kwh = slot.consumption;
    const dateKey = londonDateKey(slotInstant);
    const monthKey = dateKey.slice(0, 7);
    const coverage = slotCoverageByMonth.get(monthKey) || { total: 0, missing: 0 };
    coverage.total++;

    const rate = lookupRate(slotInstant, kwh, baselineContext, [], evThresholdKwh);
    if (rate == null) {
      coverage.missing++;
    } else {
      hypotheticalByDate.set(dateKey, (hypotheticalByDate.get(dateKey) || 0) + kwh * rate);
    }
    slotCoverageByMonth.set(monthKey, coverage);
  }

  const hypotheticalByMonth = new Map(); // monthKey -> costPence
  for (const [dateKey, costPence] of hypotheticalByDate) {
    const dayStartUTC = londonDateKeyToUTC(dateKey);
    const standingChargePence = findStandingCharge(baselineContext.standingSegments, dayStartUTC);
    const monthKey = dateKey.slice(0, 7);
    hypotheticalByMonth.set(
      monthKey,
      (hypotheticalByMonth.get(monthKey) || 0) + costPence + (standingChargePence ?? 0)
    );
  }

  // Only the first FULL calendar month after switching gives a fair
  // like-for-like comparison - a partial transition month's actual cost
  // reflects both tariffs, but the hypothetical only covers the part spent
  // on the new one.
  const switchDateKey = londonDateKey(switchDate);
  const switchedOnFirstOfMonth = switchDateKey.slice(8, 10) === "01";
  let firstSavingsMonthKey = switchDateKey.slice(0, 7);
  if (!switchedOnFirstOfMonth) {
    const [y, m] = firstSavingsMonthKey.split("-").map(Number);
    const next = m === 12 ? { y: y + 1, m: 1 } : { y, m: m + 1 };
    firstSavingsMonthKey = `${next.y}-${String(next.m).padStart(2, "0")}`;
  }

  return {
    switchDate: switchDate.toISOString(),
    baselineTariffCode,
    firstSavingsMonthKey,
    hypotheticalByMonth,
    slotCoverageByMonth,
  };
}

function checkConfigured(env) {
  if (!env.OCTOPUS_API_KEY || !env.OCTOPUS_ACCOUNT_NUMBER) {
    return json(
      {
        error: "not_configured",
        message:
          "Missing OCTOPUS_API_KEY and/or OCTOPUS_ACCOUNT_NUMBER. Set them as Worker secrets (see README).",
      },
      500
    );
  }
  return null;
}

// Totals for a set of calendar months (Europe/London) over [rangeStart,
// rangeEnd). Shared by the historical (many closed months, long-cached) and
// current-month (one open month, always fresh) history views - both need
// the same per-day pricing, monthly grouping, tariff-name lookup, and
// switch-savings logic, just over different ranges. `priorRunningSavingGBP`
// lets the current-month caller carry forward the running total left off by
// the historical block, so the two can be computed and cached separately
// while still producing one continuous running total.
async function computeMonthsBlock(
  env,
  monthKeys,
  rangeStart,
  rangeEnd,
  { includeProductMeta = false, priorRunningSavingGBP = 0 } = {}
) {
  const apiKey = env.OCTOPUS_API_KEY;
  const authHeader = "Basic " + btoa(`${apiKey}:`);

  const breakdown = await computeDailyBreakdown(env, rangeStart, rangeEnd, { includeProductMeta });
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
  // Look up each distinct product's real display name from Octopus rather
  // than showing raw codes like "E-1R-IOG-SMB-FIX-12M-26-04-18-A".
  const allTariffSegments = [
    ...(breakdown.debug.tariffSegments || []),
    ...(breakdown.debug.export?.tariffSegments || []),
  ];
  const uniqueProductCodes = [...new Set(allTariffSegments.map((s) => s.productCode).filter(Boolean))];
  const displayNames = await fetchProductDisplayNames(uniqueProductCodes, authHeader);

  for (const key of monthKeys) {
    const { start, end } = monthKeyToLondonRange(key);
    const effectiveEnd = minDate(end, rangeEnd);
    const overlapping = allTariffSegments.filter(
      (s) => new Date(s.segStart) < effectiveEnd && new Date(s.segEnd) > start
    );
    monthTotals.get(key).tariffs = [
      ...new Set(overlapping.map((s) => displayNames.get(s.productCode) || s.tariffCode)),
    ];
  }

  // Saving per month since switching to Intelligent Octopus Go (or a
  // sibling IOG-family tariff), versus what the same real usage would
  // have cost on whichever tariff was active immediately before. Switch
  // detection itself always looks at the full agreement history, so it
  // gives the same answer regardless of how narrow this block's range is.
  const switchSavings = await computeSwitchSavings(
    breakdown.agreements,
    breakdown.consumption,
    authHeader,
    rangeEnd,
    breakdown.debug.evThresholdKwh
  );

  let runningSavingGBP = priorRunningSavingGBP;
  const months = monthKeys.map((key) => {
    const e = monthTotals.get(key);
    const axleVppProfitGBP = getAxleVppProfitGBP(env, key);

    let savingGBP = null;
    if (switchSavings && key >= switchSavings.firstSavingsMonthKey) {
      const coverage = switchSavings.slotCoverageByMonth.get(key);
      const hypotheticalPence = switchSavings.hypotheticalByMonth.get(key);
      // Only trust the comparison if every slot that month got priced - a
      // partial miss (e.g. the old tariff's rates ran out) would otherwise
      // understate the hypothetical cost and overstate savings.
      if (coverage && coverage.missing === 0 && hypotheticalPence != null) {
        savingGBP = round(hypotheticalPence / 100 - e.costGBP, 2);
        runningSavingGBP = round(runningSavingGBP + savingGBP, 2);
      }
    }

    return {
      month: key,
      kwh: round(e.kwh, 2),
      costGBP: round(e.costGBP, 2),
      offPeakCostGBP: round(e.offPeakCostGBP, 2),
      onPeakCostGBP: round(e.onPeakCostGBP, 2),
      standingChargeGBP: round(e.standingChargeGBP, 2),
      exportProfitGBP: round(e.exportProfitGBP, 2),
      axleVppProfitGBP: round(axleVppProfitGBP, 2),
      netCostGBP: round(e.costGBP - e.exportProfitGBP - axleVppProfitGBP, 2),
      daysWithData: e.daysWithData,
      estimatedDays: e.estimatedDays,
      tariffs: e.tariffs,
      savingGBP,
      runningSavingGBP: savingGBP != null ? runningSavingGBP : null,
    };
  });

  return { breakdown, months, switchSavings, finalRunningSavingGBP: runningSavingGBP };
}

function switchSavingsDebug(switchSavings) {
  return switchSavings
    ? {
        switchDate: switchSavings.switchDate,
        baselineTariffCode: switchSavings.baselineTariffCode,
        firstSavingsMonthKey: switchSavings.firstSavingsMonthKey,
        coverageByMonth: Object.fromEntries(switchSavings.slotCoverageByMonth),
      }
    : null;
}

// All calendar months before the current one, out of the last HISTORY_MONTHS
// (default 24, Europe/London). These months are closed and their data never
// changes again, so the caller can cache this response for a long time and
// only recompute the (much cheaper) current month on every load.
export async function computeHistoricalMonths(env) {
  const notConfigured = checkConfigured(env);
  if (notConfigured) return notConfigured;

  const historyMonths = env.HISTORY_MONTHS ? Number(env.HISTORY_MONTHS) : 24;
  const allMonthKeys = getLastNMonthKeys(historyMonths);
  const monthKeys = allMonthKeys.slice(0, -1); // exclude the current (partial) month
  const { monthStart: rangeEnd } = getCurrentLondonMonthRange();

  if (monthKeys.length === 0) {
    return json({
      accountNumber: null,
      mpan: null,
      meterSerial: null,
      months: [],
      finalRunningSavingGBP: 0,
      periodFrom: rangeEnd.toISOString(),
      periodTo: rangeEnd.toISOString(),
      generatedAt: new Date().toISOString(),
      debug: {},
    });
  }

  const rangeStart = monthKeyToLondonRange(monthKeys[0]).start;

  try {
    // Skip per-agreement product-metadata lookups here: a multi-year range
    // can span many more tariff changes than a single month, and each extra
    // lookup is an extra outbound request - not worth it for a summary view.
    const { breakdown, months, switchSavings, finalRunningSavingGBP } = await computeMonthsBlock(
      env,
      monthKeys,
      rangeStart,
      rangeEnd,
      { includeProductMeta: false }
    );

    return json({
      accountNumber: breakdown.accountNumber,
      mpan: breakdown.mpan,
      meterSerial: breakdown.meterSerial,
      months,
      finalRunningSavingGBP,
      periodFrom: rangeStart.toISOString(),
      periodTo: rangeEnd.toISOString(),
      generatedAt: new Date().toISOString(),
      debug: { ...breakdown.debug, switchSavings: switchSavingsDebug(switchSavings) },
    });
  } catch (err) {
    if (err.responseBody) return json(err.responseBody, err.status);
    return json(
      { error: "upstream_error", message: err.message || String(err) },
      err.status || 502
    );
  }
}

// Just the current (still open) calendar month, computed fresh - far cheaper
// than the historical block since it's one month of consumption/rates
// instead of up to 24. `priorRunningSavingGBP` is the historical block's
// running total so far, so this month's runningSavingGBP continues from it.
export async function computeCurrentMonthHistory(env, priorRunningSavingGBP) {
  const notConfigured = checkConfigured(env);
  if (notConfigured) return notConfigured;

  const { monthStart: rangeStart, periodEnd: rangeEnd } = getCurrentLondonMonthRange();
  const monthKey = londonDateKey(rangeStart).slice(0, 7);

  try {
    const { breakdown, months, switchSavings, finalRunningSavingGBP } = await computeMonthsBlock(
      env,
      [monthKey],
      rangeStart,
      rangeEnd,
      { includeProductMeta: false, priorRunningSavingGBP: priorRunningSavingGBP ?? 0 }
    );

    return json({
      accountNumber: breakdown.accountNumber,
      mpan: breakdown.mpan,
      meterSerial: breakdown.meterSerial,
      months,
      finalRunningSavingGBP,
      periodFrom: rangeStart.toISOString(),
      periodTo: rangeEnd.toISOString(),
      generatedAt: new Date().toISOString(),
      debug: { ...breakdown.debug, switchSavings: switchSavingsDebug(switchSavings) },
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

  const consumption = await fetchConsumptionInMonthlyChunks(
    `${OCTOPUS_BASE}/electricity-meter-points/${mpan}/meters/${serial}/consumption/`,
    authHeader,
    rangeStart,
    rangeEnd
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

  // Used both as the last-resort global heuristic (see isOffPeak) and,
  // more reliably, as a local signal confirming which slots inside a real
  // vehicle charging session were the actual draw (see
  // attributeVehicleSessionSlots) - tune via OCTOPUS_EV_THRESHOLD_KWH if
  // 2 kWh/slot (~4kW) is wrong for this household's charger/appliances.
  const evThresholdKwh = env.OCTOPUS_EV_THRESHOLD_KWH ? Number(env.OCTOPUS_EV_THRESHOLD_KWH) : 2;

  // Intelligent Octopus Go's real off-peak eligibility isn't just the
  // advertised 23:30-05:30 window: Octopus grants extra "smart charge"
  // dispatch windows on top of it, which vary night to night. Fetch the
  // account's actual completed dispatches via the (separate) GraphQL API
  // so those bonus windows count as off-peak too.
  const { dispatchWindows, vehicleSessions, dispatchDebug, vehicleSessionsDebug, evDataStartsAt } =
    await fetchDispatchWindows(apiKey, accountNumber, rangeStart, rangeEnd);
  const evSessionSlotTimes = attributeVehicleSessionSlots(consumption, vehicleSessions, evThresholdKwh);
  // Per-slot, not a single flag for the whole request: a multi-month
  // history can straddle the point real session data actually starts
  // (see fetchDispatchWindows), so a slot before that point still needs
  // the heuristic even though later slots in the same request shouldn't.
  const useEvThresholdFor = (slotInstant) => !evDataStartsAt || slotInstant < evDataStartsAt;

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
        const rate = lookupRate(
          slotInstant,
          kwh,
          exportRateContext,
          dispatchWindows,
          evThresholdKwh,
          useEvThresholdFor(slotInstant)
        );
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
    const useEvThreshold = useEvThresholdFor(slotInstant);
    const offPeak = isOffPeak(slotInstant, kwh, dispatchWindows, evThresholdKwh, useEvThreshold, evSessionSlotTimes);
    if (offPeak && !standardOffPeak && useEvThreshold && kwh >= evThresholdKwh) {
      evThresholdReclassifiedKwh += kwh;
      evThresholdReclassifiedSlots++;
    }
    const rate = lookupRate(
      slotInstant,
      kwh,
      rateContext,
      dispatchWindows,
      evThresholdKwh,
      useEvThreshold,
      evSessionSlotTimes
    );
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
        slotCount: 0,
      };
    entry.slotCount++;
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
    // Drop days that don't have a full set of half-hourly readings yet
    // (usually today, or the most recent day, due to Octopus's normal
    // reporting lag) - otherwise they'd show a misleadingly low cost and
    // skew "days so far" / totals / the chart.
    .filter(([date, e]) => e.slotCount >= expectedSlotsForDay(date))
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
    agreements, // raw import-meter agreements, for internal use (e.g. tariff-switch detection) - not serialized to callers
    consumption, // raw slots, for internal use (e.g. tariff-switch savings) - not serialized to callers
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
      vehicleSessions: vehicleSessionsDebug,
      evSessionAttributedSlots: evSessionSlotTimes.size,
      evDataStartsAt: evDataStartsAt?.toISOString() ?? null,
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
function lookupRate(
  slotInstant,
  kwh,
  rateContext,
  dispatchWindows,
  evThresholdKwh,
  useEvThreshold = true,
  evSessionSlotTimes = null
) {
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
      !isStandardOffPeakWindow(slotInstant) &&
      rateSeg.minRate < rate &&
      (evSessionSlotTimes?.has(slotInstant.getTime()) || (useEvThreshold && kwh >= evThresholdKwh))
    ) {
      return rateSeg.minRate;
    }
    return rate;
  }

  const dayNightSeg = rateContext.dayNightSegments.find(
    (s) => slotInstant >= s.segStart && slotInstant < s.segEnd
  );
  if (!dayNightSeg) return null;
  const rates = isOffPeak(slotInstant, kwh, dispatchWindows, evThresholdKwh, useEvThreshold, evSessionSlotTimes)
    ? dayNightSeg.nightRates
    : dayNightSeg.dayRates;
  return findActiveRate(rates, slotInstant);
}

// Maps product code -> Octopus's own friendly display name (e.g.
// "IOG-SMB-FIX-12M-26-04-18" -> "Intelligent Octopus Go 12M Fixed"), falling
// back to null (caller substitutes the raw tariff code) if the lookup fails.
async function fetchProductDisplayNames(productCodes, authHeader) {
  const map = new Map();
  await Promise.all(
    productCodes.map(async (code) => {
      const product = await octopusGet(`${OCTOPUS_BASE}/products/${code}/`, authHeader).catch(
        () => null
      );
      map.set(code, product?.display_name ?? null);
    })
  );
  return map;
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
    const dispatchWindowsOnly = raw
      .filter((d) => d.start && d.end)
      .map((d) => ({ start: new Date(d.start), end: new Date(d.end) }))
      .filter((w) => w.end > rangeStart && w.start < rangeEnd);

    // completedDispatches only covers Octopus's own smart-charge scheduling,
    // not a registered EV's own reported charging (e.g. a Tesla that Octopus
    // bills at the off-peak rate unconditionally whenever it actually
    // charges, via its native vehicle integration rather than a dispatch it
    // issued). Unlike a dispatch window, a charging session's start/end
    // can't be trusted as a pricing window on its own (see
    // fetchVehicleChargingSessions) - the caller attributes its energy to
    // specific slots instead, via attributeVehicleSessionSlots.
    const vehicleSessionsResult = await fetchVehicleChargingSessions(token, accountNumber, rangeStart, rangeEnd);

    return {
      dispatchWindows: dispatchWindowsOnly,
      dispatchDebug: {
        totalDispatchesEver: raw.length,
        dispatchesInRange: dispatchWindowsOnly.length,
        sample: raw.slice(0, 3),
      },
      vehicleSessions: vehicleSessionsResult.sessions,
      vehicleSessionsDebug: vehicleSessionsResult.debug,
      // Real session data is strictly better ground truth than the
      // magnitude guess for any slot it actually covers - but "the API
      // call worked" doesn't mean every period in a multi-year history has
      // real coverage: this account's Tesla integration evidently only
      // started partway through (July 2026's off-peak share came out far
      // lower than every surrounding month, right around when the tariff
      // switched product codes). A slot before the earliest session ever
      // seen has no real data to trust either way, so it still needs the
      // heuristic; null means no sessions exist at all (API failed, or a
      // genuinely non-EV account), so every slot falls back.
      evDataStartsAt: vehicleSessionsResult.succeeded ? vehicleSessionsResult.earliestSessionStart : null,
    };
  } catch (err) {
    return {
      dispatchWindows: [],
      vehicleSessions: [],
      dispatchDebug: { step: "exception", error: err.message },
      evDataStartsAt: null,
    };
  }
}

// Fetches each registered EV's own reported charging sessions (e.g. via
// Octopus's native Tesla integration) for the given range. This is ground
// truth for "this much energy was EV-routed and bills at the off-peak rate" -
// but NOT ground truth for "this whole time span was off-peak": a live
// sample session reported 8.75kWh added across a 13.5 hour start/end window,
// which a real home charger (~7kW) would deliver in about 75 minutes. The
// window is "plugged in" to "ready by", not the actual draw, so the caller
// must attribute energyAdded to specific slots (see attributeVehicleSessionSlots)
// rather than treating the whole window as off-peak. Degrades gracefully
// (empty sessions, succeeded: false) if this account has no such device or
// the call fails - the standard off-peak window and dispatch windows still
// apply either way, and the caller falls back to the magnitude heuristic.
// Confirmed live against the real API: chargingSessions rejects after/before
// combined with first/last ("Invalid pagination parameters") and rejects
// omitting both first and last ("You must provide a first or last value to
// properly paginate the connection"). `first` alone is the only combination
// that works, so the date range is applied client-side below instead.
const CHARGING_SESSIONS_PAGE_SIZE = 100;

function energyToKwh(energy) {
  if (!energy || energy.value == null) return null;
  const value = Number(energy.value);
  if (Number.isNaN(value)) return null;
  if (energy.unit === "WATT_HOUR") return value / 1000;
  if (energy.unit === "MEGAWATT_HOUR") return value * 1000;
  return value; // KILOWATT_HOUR, or an unrecognised unit - best guess as-is
}

async function fetchVehicleChargingSessions(token, accountNumber, rangeStart, rangeEnd) {
  try {
    const res = await fetch(KRAKEN_GRAPHQL_URL, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: token },
      body: JSON.stringify({
        query:
          "query getChargingSessions($accountNumber: String!, $first: Int!) { " +
          "devices(accountNumber: $accountNumber) { id name " +
          "... on SmartFlexVehicle { chargingSessions(first: $first) { " +
          "edges { node { start end energyAdded { value unit } cost { amount currency } } } } } } }",
        variables: { accountNumber, first: CHARGING_SESSIONS_PAGE_SIZE },
      }),
    });
    const data = await res.json();
    if (data.errors?.length) {
      return {
        sessions: [],
        succeeded: false,
        debug: { step: "chargingSessions", errors: data.errors.map((e) => e.message) },
      };
    }

    const devices = data.data?.devices ?? [];
    const sessions = [];
    const sample = [];
    let sessionCountBeforeRangeFilter = 0;
    let earliestSessionStart = null;
    for (const device of devices) {
      for (const edge of device.chargingSessions?.edges ?? []) {
        const node = edge.node;
        if (!node?.start || !node?.end) continue;
        sessionCountBeforeRangeFilter++;
        const start = new Date(node.start);
        const end = new Date(node.end);
        // Tracked across the account's whole session history (not just this
        // request's range) - this is what tells the caller how far back
        // real coverage actually goes, so it knows not to trust an absence
        // of sessions before that point as "no charging happened" rather
        // than "this integration didn't exist yet".
        if (!earliestSessionStart || start < earliestSessionStart) earliestSessionStart = start;
        if (end <= rangeStart || start >= rangeEnd) continue;
        sessions.push({ start, end, energyKwh: energyToKwh(node.energyAdded) });
        if (sample.length < 5) {
          sample.push({
            deviceName: device.name,
            start: node.start,
            end: node.end,
            energyAdded: node.energyAdded,
            cost: node.cost,
          });
        }
      }
    }

    return {
      sessions,
      succeeded: true,
      earliestSessionStart,
      debug: {
        vehicleDeviceCount: devices.filter((d) => d.chargingSessions != null).length,
        // If this ever lands exactly on CHARGING_SESSIONS_PAGE_SIZE per
        // device, older sessions may be getting truncated - worth raising
        // the page size then.
        sessionCountBeforeRangeFilter,
        sessionCountInRange: sessions.length,
        earliestSessionStart: earliestSessionStart?.toISOString() ?? null,
        sample,
      },
    };
  } catch (err) {
    return { sessions: [], succeeded: false, debug: { step: "exception", error: err.message } };
  }
}

// A charging session's [start, end) window is "plugged in" to "ready by",
// not the actual draw (see fetchVehicleChargingSessions), so pricing the
// whole window as off-peak would misclassify ordinary background
// consumption throughout the afternoon/evening too.
//
// It's also not just the vehicle's own energy: this household's separate
// home battery charges overnight AND whenever a Tesla is actually charging
// (confirmed directly by the user) - riding along in the same half-hour
// slots, on the same meter, with no device/session data of its own. Capping
// attribution at the session's own energyAdded (as this used to) stops
// selecting slots before accounting for the battery's extra draw stacked on
// top of the Tesla's in those same slots, which is exactly what made a real
// comparison against the user's bill show on-peak cost at ~3x its true
// share.
//
// So within a session's window - and ONLY within a window Octopus has
// already confirmed real charging activity happened in, never globally -
// treat magnitude as a reliable confirming signal: any slot drawing at
// least evThresholdKwh is almost certainly the Tesla, the battery, or both
// charging together, not an unrelated appliance (the false-positive that
// made the old global heuristic unsound doesn't apply here, since every
// window checked is already known-real). energyAdded still guards the
// opposite failure mode - a quiet top-up that never crosses the
// threshold - via the previous greedy-top-slots fallback. Returns a Set of
// slot epoch-ms timestamps.
function attributeVehicleSessionSlots(consumption, sessions, evThresholdKwh) {
  const attributed = new Set();
  const slotTimes = consumption.map((slot) => ({
    time: new Date(slot.interval_start).getTime(),
    kwh: slot.consumption,
  }));
  for (const session of sessions) {
    if (session.energyKwh == null) continue;
    const startMs = session.start.getTime();
    const endMs = session.end.getTime();
    const overlapping = slotTimes.filter((s) => s.time >= startMs && s.time < endMs);

    const elevated = overlapping.filter((s) => s.kwh >= evThresholdKwh);
    if (elevated.length > 0) {
      for (const slot of elevated) attributed.add(slot.time);
      continue;
    }

    // Fallback for a session that never crosses the threshold (e.g. a
    // small top-up): attribute just enough of its highest-draw slots to
    // cover its own reported energy.
    let remaining = session.energyKwh;
    for (const slot of [...overlapping].sort((a, b) => b.kwh - a.kwh)) {
      if (remaining <= 0) break;
      attributed.add(slot.time);
      remaining -= slot.kwh;
    }
  }
  return attributed;
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

// A multi-year history range comfortably exceeds one page (page_size=25000
// is ~1440 days of half-hourly readings; 24 months is ~33500 records for
// this account), which live results confirmed is unreliable here: two
// identical requests seconds apart returned the same total record count but
// scrambled per-day/per-month distributions - most months differed by up to
// 2x. Fetching one calendar month at a time instead keeps every request
// comfortably under a single page (at most ~1500 half-hourly records), so
// cursor-following across pages - the one part of this call that could
// plausibly behave inconsistently against a live, frequently-corrected
// dataset - never has to happen at all for a single month's request.
async function fetchConsumptionInMonthlyChunks(baseUrl, authHeader, rangeStart, rangeEnd) {
  const results = [];
  let chunkStart = rangeStart;
  while (chunkStart < rangeEnd) {
    const [y, m] = londonDateKey(chunkStart).split("-").map(Number);
    let ny = y;
    let nm = m + 1;
    if (nm > 12) {
      nm = 1;
      ny += 1;
    }
    const nextMonthStart = londonWallTimeToUTC(ny, nm, 1, 0, 0, 0);
    const chunkEnd = minDate(nextMonthStart, rangeEnd);

    const page = await fetchAllPages(
      `${baseUrl}?period_from=${chunkStart.toISOString()}&period_to=${chunkEnd.toISOString()}` +
        `&page_size=25000&order_by=period`,
      authHeader
    );
    results.push(...page);
    chunkStart = chunkEnd;
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

// A slot is off-peak if it's within the standard baseline window, or within
// one of the account's actual off-peak dispatch windows for that night
// (Octopus's own smart-charge scheduling), or a slot an EV charging
// session's own reported energy was attributed to (see
// attributeVehicleSessionSlots - NOT the session's whole start/end window,
// which spans "plugged in" to "ready by" rather than the actual draw).
// useEvThreshold gates the magnitude guess (treating any unusually large
// slot as EV charging) - it's only meant as a fallback for accounts
// fetchVehicleChargingSessions couldn't get real session data for, since
// otherwise it would misclassify a genuine large non-EV appliance draw as
// off-peak.
function isOffPeak(date, kwh, dispatchWindows, evThresholdKwh, useEvThreshold = true, evSessionSlotTimes = null) {
  if (isStandardOffPeakWindow(date)) return true;
  if (evSessionSlotTimes?.has(date.getTime())) return true;
  if (useEvThreshold && kwh >= evThresholdKwh) return true;
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

export function londonWallTimeToUTC(y, m, d, h = 0, mi = 0, s = 0) {
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

// Number of half-hour slots a London calendar day actually has: normally
// 48, but 46 or 50 on the two clock-change days each year. Date.UTC (inside
// londonWallTimeToUTC) normalizes an overflowing day-of-month automatically,
// so d + 1 correctly rolls into the next month/year too.
function expectedSlotsForDay(dateKey) {
  const [y, m, d] = dateKey.split("-").map(Number);
  const dayStart = londonWallTimeToUTC(y, m, d, 0, 0, 0);
  const nextDayStart = londonWallTimeToUTC(y, m, d + 1, 0, 0, 0);
  return (nextDayStart.getTime() - dayStart.getTime()) / (30 * 60 * 1000);
}

function getDaysInLondonMonth(monthStart) {
  const [y, m] = londonDateKey(monthStart).split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

// Axle Energy's VPP earnings aren't available via a personal API token (only
// a partner/business-level "organisational token" can reach their rewards
// endpoint), so this is entered manually as a month-keyed map you add one
// line to each month, e.g. {"2026-08": 18.20, "2026-09": 4.01}.
function getAxleVppProfitMap(env) {
  if (!env.AXLE_VPP_PROFIT_JSON) return {};
  try {
    const parsed = JSON.parse(env.AXLE_VPP_PROFIT_JSON);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function getAxleVppProfitGBP(env, monthKey) {
  const map = getAxleVppProfitMap(env);
  if (Object.prototype.hasOwnProperty.call(map, monthKey)) {
    const v = Number(map[monthKey]);
    return Number.isFinite(v) ? v : 0;
  }
  // Backward compatible fallback for the older flat secret, applied only to
  // the current month (it predates per-month tracking).
  const currentMonthKey = londonDateKey(new Date()).slice(0, 7);
  if (monthKey === currentMonthKey && env.AXLE_VPP_PROFIT_GBP) {
    const v = Number(env.AXLE_VPP_PROFIT_GBP);
    return Number.isFinite(v) ? v : 0;
  }
  return 0;
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
