const gbp = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" });
const monthFormatter = new Intl.DateTimeFormat("en-GB", { month: "short", year: "numeric", timeZone: "UTC" });
const canHoverBars = window.matchMedia("(hover: hover) and (pointer: fine)").matches;

let lastGoodData = null;
let lastGoodAt = null;

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// Splits an amount into the three pieces the design's figure markup wants:
// a leading minus sign (if negative), whole pounds, and 2dp pence - computed
// from total pence so float rounding never produces e.g. "84.199999".
function splitAmount(value) {
  const negative = value < 0;
  const totalPence = Math.round(Math.abs(value) * 100);
  return {
    negative,
    pounds: Math.floor(totalPence / 100).toLocaleString("en-GB"),
    pence: String(totalPence % 100).padStart(2, "0"),
  };
}

function getLondonYearMonth(iso) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "numeric",
  })
    .formatToParts(new Date(iso))
    .reduce((acc, p) => {
      acc[p.type] = p.value;
      return acc;
    }, {});
  return { y: +parts.year, m: +parts.month };
}

// Only used to format a "day N" label, never for pricing - a plain UTC date
// carrying the right calendar y/m/day is all a label needs.
function dayLabel(y, m, day, withMonth) {
  const d = new Date(Date.UTC(y, m - 1, day));
  if (!withMonth) return String(d.getUTCDate());
  const monthAbbrev = d.toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" });
  return `${d.getUTCDate()} ${monthAbbrev}`;
}

// "2026-05" -> "1 May 2026" - the first full calendar month the running
// savings total counts from.
function firstOfMonthLabel(monthKey) {
  const [y, m] = monthKey.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1, 1));
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(d);
}

// Derives the design's minimal state shape from the two existing API
// responses - no backend changes needed, this dashboard just displays a
// slice of what /api/costs and /api/history already compute.
function deriveData(costs, history) {
  const daysElapsed = costs.days.length;
  const daysInMonth = costs.daysInMonth;
  // Nets off both export and Axle profit, same as the forecast and last
  // month's net cost - so the progress bar (spendToDate / forecast) compares
  // like with like, and the two stacked captions in this cell aren't netted
  // differently from each other.
  const spendToDate = round2(costs.totalCostGBP - costs.totalExportProfitGBP - costs.axleVppProfitGBP);
  const forecast = costs.forecastCostGBP;

  const months = history.months || [];
  const currentMonthEntry = months[months.length - 1] || null;

  let savingsTotal = 0;
  for (let i = months.length - 1; i >= 0; i--) {
    if (months[i].runningSavingGBP != null) {
      savingsTotal = months[i].runningSavingGBP;
      break;
    }
  }
  const savingsThisMonth =
    currentMonthEntry && currentMonthEntry.savingGBP != null ? currentMonthEntry.savingGBP : 0;

  const savingsByMonth = months
    .filter((m) => m.runningSavingGBP != null)
    .slice(-12)
    .map((m) => m.runningSavingGBP);

  const switchSavingsInfo =
    history.debug?.current?.switchSavings || history.debug?.historical?.switchSavings || null;
  const savingsSinceLabel = switchSavingsInfo
    ? firstOfMonthLabel(switchSavingsInfo.firstSavingsMonthKey)
    : null;

  // The month before the current one - null if there's less than a full
  // month of history yet (a brand new account).
  const lastMonthEntry = months.length >= 2 ? months[months.length - 2] : null;
  const lastMonthNetCostGBP =
    lastMonthEntry && lastMonthEntry.daysWithData > 0 ? lastMonthEntry.netCostGBP : null;

  const dailyCosts = [];
  for (let i = 0; i < daysInMonth; i++) {
    if (i < daysElapsed) {
      const d = costs.days[i];
      dailyCosts.push(round2(d.costGBP - d.exportProfitGBP));
    } else {
      dailyCosts.push(costs.averageDailyCostGBP);
    }
  }

  return {
    spendToDate,
    forecast,
    savingsTotal,
    savingsThisMonth,
    savingsByMonth,
    savingsSinceLabel,
    dailyCosts,
    averageDailyCostGBP: costs.averageDailyCostGBP,
    lastMonthNetCostGBP,
    daysElapsed,
    daysInMonth,
    monthStart: costs.monthStart,
    updatedAt: costs.generatedAt,
    // Newest first - a history list reads top-down most-recent-first.
    historyMonths: [...months].reverse(),
    // Oldest first, capped to 12 - a chart reads left-to-right chronologically.
    monthlyChartMonths: months.slice(-12),
  };
}

function renderFigure(prefix, value) {
  const { negative, pounds, pence } = splitAmount(value);
  const sign = document.getElementById(`${prefix}-sign`);
  const currency = document.getElementById(`${prefix}-currency`);
  const poundsEl = document.getElementById(`${prefix}-pounds`);
  const penceEl = document.getElementById(`${prefix}-pence`);

  sign.textContent = negative ? "−" : "";
  currency.classList.remove("is-loading");
  poundsEl.classList.remove("is-loading");
  penceEl.classList.remove("is-loading");
  poundsEl.textContent = pounds;
  penceEl.textContent = `.${pence}`;
}

function renderProgress(data) {
  const pct = data.forecast > 0 ? Math.max(0, Math.min(1, data.spendToDate / data.forecast)) * 100 : 0;
  document.getElementById("forecast-progress-fill").style.width = `${pct}%`;
}

function sparklineColor(index, total) {
  // Four-step ramp oldest -> newest (matches the reference design's
  // 3-bars-per-step grouping over 12 months, scaled to however many
  // months are actually available so far).
  const ramp = ["#d2c7f5", "#a893ea", "#7f5ce0", "#5c2bd6"];
  const step = Math.min(ramp.length - 1, Math.floor((index / total) * ramp.length));
  return ramp[step];
}

function renderSparkline(savingsByMonth) {
  const container = document.getElementById("savings-sparkline");
  container.innerHTML = "";
  if (savingsByMonth.length === 0) return;
  const max = Math.max(...savingsByMonth, 0.01);
  savingsByMonth.forEach((v, i) => {
    const bar = document.createElement("div");
    bar.className = "sparkline__bar";
    bar.style.height = `${Math.max((v / max) * 100, 2)}%`;
    bar.style.background = sparklineColor(i, savingsByMonth.length);
    container.appendChild(bar);
  });
}

function renderCaptions(data) {
  document.getElementById("forecast-caption").innerHTML =
    `<strong>${gbp.format(data.spendToDate)}</strong> spent so far`;

  const lastMonthEl = document.getElementById("last-month-caption");
  if (data.lastMonthNetCostGBP != null) {
    lastMonthEl.innerHTML = `<strong>${gbp.format(data.lastMonthNetCostGBP)}</strong> last month`;
  } else {
    lastMonthEl.innerHTML = "&nbsp;";
  }

  const prefix = data.savingsThisMonth < 0 ? "" : "+";
  let savingsCaption = `<strong>${prefix}${gbp.format(data.savingsThisMonth)}</strong> this month`;
  if (data.savingsSinceLabel) {
    savingsCaption += ` · since ${data.savingsSinceLabel}`;
  }
  document.getElementById("savings-caption").innerHTML = savingsCaption;
}

const tooltip = document.getElementById("bar-tooltip");

function positionTooltip(bar) {
  const rect = bar.getBoundingClientRect();
  tooltip.style.left = `${rect.left + rect.width / 2}px`;
  tooltip.style.top = `${rect.top - 6}px`;
}

function attachBarTooltip(bar, label, cost) {
  if (!canHoverBars) return;
  bar.addEventListener("mouseenter", () => {
    tooltip.textContent = `${label} — ${gbp.format(cost)}`;
    tooltip.hidden = false;
    positionTooltip(bar);
  });
  bar.addEventListener("mousemove", () => positionTooltip(bar));
  bar.addEventListener("mouseleave", () => {
    tooltip.hidden = true;
  });
}

function renderDailyChart(data) {
  const container = document.getElementById("daily-chart");
  container.removeAttribute("style"); // clear any skeleton inline styles
  container.innerHTML = "";
  const { y, m } = getLondonYearMonth(data.monthStart);

  const width = 900;
  const height = 200;
  const margin = { top: 8, right: 8, bottom: 22, left: 46 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;

  const values = data.dailyCosts;
  const dataMin = Math.min(0, ...values);
  const dataMax = Math.max(0, ...values, 0.01);
  const ticks = niceTicks(dataMin, dataMax, 4);
  const yMin = ticks[0];
  const yMax = ticks[ticks.length - 1];

  const yScale = (v) => margin.top + plotHeight - ((v - yMin) / (yMax - yMin)) * plotHeight;
  const zeroY = yScale(0);

  const slotWidth = plotWidth / values.length;
  const barWidth = Math.min(20, slotWidth * 0.6);
  const xCenter = (i) => margin.left + slotWidth * i + slotWidth / 2;

  let svg = `<svg viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">`;

  for (const tick of ticks) {
    const ty = yScale(tick);
    svg +=
      `<line class="mc-gridline" x1="${margin.left}" x2="${width - margin.right}" y1="${ty}" y2="${ty}"></line>` +
      `<text class="mc-tick-label" x="${margin.left - 6}" y="${ty + 3}" text-anchor="end">${gbp.format(tick)}</text>`;
  }

  svg += `<line class="mc-axis" x1="${margin.left}" x2="${width - margin.right}" y1="${zeroY}" y2="${zeroY}"></line>`;

  values.forEach((cost, i) => {
    const isActual = i < data.daysElapsed;
    const cx = xCenter(i);
    const barY = Math.min(yScale(cost), zeroY);
    const barHeight = Math.max(Math.abs(yScale(cost) - zeroY), 1);
    svg +=
      `<rect class="dc-bar${isActual ? "" : " is-forecast"}" ` +
      `x="${cx - barWidth / 2}" y="${barY}" width="${barWidth}" height="${barHeight}"></rect>`;
  });

  // Average daily cost - the same figure forecast days are already
  // projected at, drawn as a reference line so actual days can be read
  // against it too.
  const avgY = yScale(data.averageDailyCostGBP);
  svg += `<line class="dc-average" x1="${margin.left}" y1="${avgY}" x2="${width - margin.right}" y2="${avgY}"></line>`;

  const fractions = [0, 0.25, 0.5, 0.75, 1];
  fractions.forEach((f, i) => {
    const day = Math.round(f * (data.daysInMonth - 1)) + 1;
    const label = dayLabel(y, m, day, i === 0 || i === fractions.length - 1);
    const anchor = i === 0 ? "start" : i === fractions.length - 1 ? "end" : "middle";
    svg += `<text class="mc-tick-label" x="${margin.left + plotWidth * f}" y="${height - margin.bottom + 15}" text-anchor="${anchor}">${label}</text>`;
  });

  svg += `</svg>`;
  container.innerHTML = svg;

  const bars = container.querySelectorAll(".dc-bar");
  values.forEach((cost, i) => {
    attachBarTooltip(bars[i], dayLabel(y, m, i + 1, true), cost);
  });
}

// A handful of "nice" round numbers to pick axis ticks from, at each order
// of magnitude - keeps gridline labels like £20/£40 instead of £23.7/£47.4.
function niceTicks(min, max, targetCount) {
  if (min === max) {
    min = Math.min(0, min);
    max = max === 0 ? 1 : max;
  }
  const range = max - min;
  const roughStep = range / targetCount;
  const magnitude = 10 ** Math.floor(Math.log10(roughStep));
  const residual = roughStep / magnitude;
  const step = (residual > 5 ? 10 : residual > 2 ? 5 : residual > 1 ? 2 : 1) * magnitude;

  const niceMin = Math.floor(min / step) * step;
  const niceMax = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = niceMin; v <= niceMax + step / 2; v += step) ticks.push(Math.round(v * 100) / 100);
  return ticks;
}

// Least-squares fit over whatever { x, y } points are given - used to draw a
// trend line through months that actually have data, skipping any zero
// months before the account existed so they don't drag the line down.
function linearRegression(points) {
  const n = points.length;
  if (n < 2) return null;
  const xMean = points.reduce((s, p) => s + p.x, 0) / n;
  const yMean = points.reduce((s, p) => s + p.y, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of points) {
    num += (p.x - xMean) * (p.y - yMean);
    den += (p.x - xMean) ** 2;
  }
  if (den === 0) return null;
  const slope = num / den;
  return { slope, intercept: yMean - slope * xMean };
}

function renderMonthlyChart(months) {
  const container = document.getElementById("monthly-chart");
  container.removeAttribute("style"); // clear any skeleton inline styles
  container.innerHTML = "";
  if (months.length === 0) return;

  const width = 900;
  const height = 200;
  const margin = { top: 8, right: 8, bottom: 22, left: 46 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;

  const values = months.map((m) => m.netCostGBP);
  const dataMin = Math.min(0, ...values);
  const dataMax = Math.max(0, ...values, 0.01);
  const ticks = niceTicks(dataMin, dataMax, 4);
  const yMin = ticks[0];
  const yMax = ticks[ticks.length - 1];

  const y = (v) => margin.top + plotHeight - ((v - yMin) / (yMax - yMin)) * plotHeight;
  const zeroY = y(0);

  const slotWidth = plotWidth / months.length;
  const barWidth = Math.min(36, slotWidth * 0.55);
  const xCenter = (i) => margin.left + slotWidth * i + slotWidth / 2;

  const trendPoints = months
    .map((m, i) => ({ x: i, y: m.netCostGBP, hasData: m.daysWithData > 0 }))
    .filter((p) => p.hasData);
  const trend = linearRegression(trendPoints);

  let svg = `<svg viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">`;

  for (const tick of ticks) {
    const ty = y(tick);
    svg +=
      `<line class="mc-gridline" x1="${margin.left}" x2="${width - margin.right}" y1="${ty}" y2="${ty}"></line>` +
      `<text class="mc-tick-label" x="${margin.left - 6}" y="${ty + 3}" text-anchor="end">${gbp.format(tick)}</text>`;
  }

  svg += `<line class="mc-axis" x1="${margin.left}" x2="${width - margin.right}" y1="${zeroY}" y2="${zeroY}"></line>`;

  months.forEach((month, i) => {
    const cx = xCenter(i);
    const v = month.netCostGBP;
    const barY = Math.min(y(v), zeroY);
    const barHeight = Math.max(Math.abs(y(v) - zeroY), 1);
    svg +=
      `<rect class="mc-bar${month.daysWithData === 0 ? " is-empty" : ""}" ` +
      `x="${cx - barWidth / 2}" y="${barY}" width="${barWidth}" height="${barHeight}"></rect>`;
  });

  if (trend) {
    const x1 = 0;
    const x2 = months.length - 1;
    const trendY1 = y(trend.intercept + trend.slope * x1);
    const trendY2 = y(trend.intercept + trend.slope * x2);
    svg += `<line class="mc-trend" x1="${xCenter(x1)}" y1="${trendY1}" x2="${xCenter(x2)}" y2="${trendY2}"></line>`;
  }

  months.forEach((month, i) => {
    const label = monthFormatter.format(new Date(`${month.month}-01T00:00:00Z`)).split(" ")[0];
    svg += `<text class="mc-tick-label" x="${xCenter(i)}" y="${height - margin.bottom + 15}" text-anchor="middle">${label}</text>`;
  });

  svg += `</svg>`;
  container.innerHTML = svg;

  // Wire up the same hover tooltip the daily chart uses - desktop only,
  // gated inside attachBarTooltip itself.
  const bars = container.querySelectorAll(".mc-bar");
  months.forEach((month, i) => {
    const label = monthFormatter.format(new Date(`${month.month}-01T00:00:00Z`));
    attachBarTooltip(bars[i], label, month.netCostGBP);
  });
}

// Renders a plain-amount cell, en-dash for null (a month with no data or
// not yet eligible for a saving/running-total comparison), "+" prefix for
// a positive saving/running-total so it reads as an accumulation.
function amountCell(value, { signed = false } = {}) {
  if (value == null) return `<td class="is-muted">–</td>`;
  const prefix = signed && value >= 0 ? "+" : "";
  return `<td>${prefix}${gbp.format(value)}</td>`;
}

function renderHistoryTable(months) {
  const tbody = document.getElementById("history-table-body");
  tbody.innerHTML = "";
  for (const month of months) {
    const tr = document.createElement("tr");
    const monthLabel = monthFormatter.format(new Date(`${month.month}-01T00:00:00Z`));
    const tariffLabel = month.tariffs && month.tariffs.length ? month.tariffs.join(", ") : "–";
    tr.innerHTML =
      `<td class="is-left">${monthLabel}</td>` +
      `<td>${month.daysWithData ? month.kwh.toFixed(1) : "–"}</td>` +
      `<td>${month.daysWithData ? gbp.format(month.costGBP) : "–"}</td>` +
      `<td>${month.exportProfitGBP ? gbp.format(month.exportProfitGBP) : "–"}</td>` +
      `<td>${month.axleVppProfitGBP ? gbp.format(month.axleVppProfitGBP) : "–"}</td>` +
      `<td>${month.daysWithData ? gbp.format(month.netCostGBP) : "–"}</td>` +
      amountCell(month.savingGBP, { signed: true }) +
      amountCell(month.runningSavingGBP) +
      `<td class="is-left">${tariffLabel}</td>`;
    tbody.appendChild(tr);
  }
}

function renderContext(data) {
  const month = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    month: "long",
    year: "numeric",
  }).format(new Date(data.monthStart));
  document.getElementById("context-month").textContent = month;

  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(data.updatedAt));
  document.getElementById("context-meta").textContent =
    `Day ${data.daysElapsed} of ${data.daysInMonth} · updated ${time}`;
}

function render(data) {
  renderContext(data);
  renderFigure("forecast", data.forecast);
  renderProgress(data);
  renderFigure("savings", data.savingsTotal);
  renderSparkline(data.savingsByMonth);
  renderCaptions(data);
  renderDailyChart(data);
  renderMonthlyChart(data.monthlyChartMonths);
  renderHistoryTable(data.historyMonths);
}

function renderSkeletonBars(containerId, barClass, count, heightPct) {
  const container = document.getElementById(containerId);
  container.innerHTML = "";
  for (let i = 0; i < count; i++) {
    const bar = document.createElement("div");
    bar.className = barClass;
    bar.style.height = `${heightPct}%`;
    container.appendChild(bar);
  }
}

// Shared skeleton for the two SVG bar charts (daily/monthly cost): flat
// flex-row divs standing in for the real chart until it renders - cleared
// via container.removeAttribute("style") once the real <svg> goes in.
function renderSkeletonSvgChart(containerId, count) {
  const container = document.getElementById(containerId);
  container.innerHTML = "";
  container.style.display = "flex";
  container.style.alignItems = "flex-end";
  container.style.gap = "4px";
  container.style.height = "160px";
  for (let i = 0; i < count; i++) {
    const bar = document.createElement("div");
    bar.style.flex = "1";
    bar.style.height = "55%";
    bar.style.background = "var(--purple-100)";
    container.appendChild(bar);
  }
}

function renderSkeletonHistoryTable() {
  const tbody = document.getElementById("history-table-body");
  tbody.innerHTML = "";
  for (let i = 0; i < 6; i++) {
    const tr = document.createElement("tr");
    tr.className = "is-loading-row";
    tr.innerHTML = "<td colspan=\"9\">&nbsp;</td>";
    tbody.appendChild(tr);
  }
}

function renderSkeleton() {
  renderSkeletonBars("savings-sparkline", "sparkline__bar", 12, 55);
  renderSkeletonSvgChart("daily-chart", 30);
  renderSkeletonSvgChart("monthly-chart", 12);
  renderSkeletonHistoryTable();
}

function showError(message) {
  const el = document.getElementById("error-line");
  el.hidden = false;
  if (lastGoodData) {
    const time = lastGoodAt.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
    el.textContent = `Couldn't reach Octopus — showing figures from ${time}`;
    render(lastGoodData);
  } else {
    el.textContent = `Couldn't reach Octopus — ${message}`;
  }
}

function hideError() {
  document.getElementById("error-line").hidden = true;
}

async function loadDashboard(forceRefresh) {
  try {
    const [costsRes, historyRes] = await Promise.all([
      fetch(forceRefresh ? "/api/costs?refresh=1" : "/api/costs"),
      fetch(forceRefresh ? "/api/history?refresh=1" : "/api/history"),
    ]);
    const costs = await costsRes.json();
    const history = await historyRes.json();
    if (!costsRes.ok || !costs.days) {
      throw new Error(costs.message || `Request failed (${costsRes.status})`);
    }
    if (!historyRes.ok || !history.months) {
      throw new Error(history.message || `Request failed (${historyRes.status})`);
    }

    lastGoodData = deriveData(costs, history);
    lastGoodAt = new Date();
    hideError();
    render(lastGoodData);
  } catch (err) {
    showError(err.message || String(err));
  }
}

async function main() {
  renderSkeleton();
  await loadDashboard(false);

  document.getElementById("refresh-btn").addEventListener("click", async () => {
    const btn = document.getElementById("refresh-btn");
    btn.classList.add("is-busy");
    await loadDashboard(true);
    btn.classList.remove("is-busy");
  });
}

main();
