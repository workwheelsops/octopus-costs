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

// Derives the design's minimal state shape from the two existing API
// responses - no backend changes needed, this dashboard just displays a
// slice of what /api/costs and /api/history already compute.
function deriveData(costs, history) {
  const daysElapsed = costs.days.length;
  const daysInMonth = costs.daysInMonth;
  // Nets off export only (not Axle), matching the netting rule already used
  // for averageDailyCostGBP - Axle only ever nets into the forecast figure.
  const spendToDate = round2(costs.totalCostGBP - costs.totalExportProfitGBP);
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
    dailyCosts,
    daysElapsed,
    daysInMonth,
    monthStart: costs.monthStart,
    updatedAt: costs.generatedAt,
    // Newest first - a history list reads top-down most-recent-first.
    historyMonths: [...months].reverse(),
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
  const prefix = data.savingsThisMonth < 0 ? "" : "+";
  document.getElementById("savings-caption").innerHTML =
    `<strong>${prefix}${gbp.format(data.savingsThisMonth)}</strong> this month`;
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

function renderDailyAxis(daysInMonth, y, m) {
  const container = document.getElementById("daily-axis");
  container.innerHTML = "";
  const fractions = [0, 0.25, 0.5, 0.75, 1];
  fractions.forEach((f, i) => {
    const day = Math.round(f * (daysInMonth - 1)) + 1;
    const span = document.createElement("span");
    span.textContent = dayLabel(y, m, day, i === 0 || i === fractions.length - 1);
    container.appendChild(span);
  });
}

function renderDailyChart(data) {
  const container = document.getElementById("daily-chart");
  container.innerHTML = "";
  const max = Math.max(...data.dailyCosts, 0.01);
  const { y, m } = getLondonYearMonth(data.monthStart);

  data.dailyCosts.forEach((cost, i) => {
    const isActual = i < data.daysElapsed;
    const bar = document.createElement("div");
    bar.className = `day-bar ${isActual ? "is-actual" : "is-forecast"}`;
    bar.style.height = `${Math.max((cost / max) * 100, 1)}%`;
    attachBarTooltip(bar, dayLabel(y, m, i + 1, true), cost);
    container.appendChild(bar);
  });

  renderDailyAxis(data.daysInMonth, y, m);
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

function renderSkeletonAxis() {
  const container = document.getElementById("daily-axis");
  container.innerHTML = "";
  for (let i = 0; i < 5; i++) {
    container.appendChild(document.createElement("span"));
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
  renderSkeletonBars("daily-chart", "day-bar", 30, 55);
  renderSkeletonAxis();
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
      fetch("/api/costs"),
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
