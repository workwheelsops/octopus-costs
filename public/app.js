const gbp = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" });
const dateFormatter = new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short" });

async function main() {
  const statusEl = document.getElementById("status");

  let data;
  try {
    const res = await fetch("/api/costs");
    data = await res.json();
    if (!res.ok) {
      showError(data);
      return;
    }
  } catch (err) {
    showError({ message: `Could not reach the API: ${err.message}` });
    return;
  }

  if (!data.days || data.days.length === 0) {
    statusEl.hidden = false;
    const d = data.debug || {};
    statusEl.innerHTML =
      "No consumption data is available yet for this month.<br>" +
      `<small>MPAN <code>${data.mpan ?? "?"}</code>, meter <code>${
        data.meterSerial ?? "?"
      }</code> &middot; queried ${d.periodFrom ?? "?"} &rarr; ${d.periodTo ?? "?"} ` +
      `&middot; Octopus returned ${d.rawConsumptionRecordCount ?? "?"} readings ` +
      `&middot; ${d.meterPointCount ?? "?"} electricity meter point(s) on account` +
      (d.meterPointMpans
        ? ": " + d.meterPointMpans.map((mp) => `${mp.mpan}${mp.isExport ? " (export)" : ""}`).join(", ")
        : "") +
      (d.mostRecentReadingAt
        ? `<br>Most recent reading Octopus has for this meter: ${new Date(
            d.mostRecentReadingAt
          ).toLocaleString("en-GB")}`
        : d.mostRecentReadingAt === null
        ? "<br>Octopus has no readings at all for this meter via the API."
        : "") +
      "</small>";
    return;
  }

  document.getElementById("subtitle").textContent = `Electricity spend since ${dateFormatter.format(
    new Date(data.monthStart)
  )}`;

  document.getElementById("total-cost").textContent = gbp.format(data.totalCostGBP);
  document.getElementById("total-kwh").textContent = `${data.totalKwh.toFixed(1)} kWh`;
  document.getElementById("avg-cost").textContent = gbp.format(data.averageDailyCostGBP);
  document.getElementById("day-count").textContent = data.days.length;
  document.getElementById("forecast-cost").textContent = gbp.format(data.forecastCostGBP ?? 0);
  document.getElementById("forecast-sub").textContent = `over ${data.daysInMonth ?? "?"} days`;
  document.getElementById("offpeak-cost").textContent = gbp.format(data.totalOffPeakCostGBP ?? 0);
  document.getElementById("offpeak-kwh").textContent = `${(data.totalOffPeakKwh ?? 0).toFixed(1)} kWh`;
  document.getElementById("onpeak-cost").textContent = gbp.format(data.totalOnPeakCostGBP ?? 0);
  document.getElementById("onpeak-kwh").textContent = `${(data.totalOnPeakKwh ?? 0).toFixed(1)} kWh`;

  const hasExport = !!data.debug?.export;
  document.getElementById("export-card").hidden = !hasExport;
  document.getElementById("export-header").hidden = !hasExport;
  if (hasExport) {
    document.getElementById("export-profit").textContent = gbp.format(data.totalExportProfitGBP ?? 0);
  }

  const hasAxle = !!data.axleVppProfitGBP;
  document.getElementById("axle-card").hidden = !hasAxle;
  if (hasAxle) {
    document.getElementById("axle-profit").textContent = gbp.format(data.axleVppProfitGBP);
  }

  document.getElementById("summary").hidden = false;

  renderChart(data.days);
  document.getElementById("chart-section").hidden = false;

  renderTable(data.days, hasExport);
  document.getElementById("table-section").hidden = false;

  document.getElementById("generated-at").textContent = new Date(data.generatedAt).toLocaleString(
    "en-GB"
  );
  document.getElementById("footer").hidden = false;

  const estimatedDays = data.days.filter((d) => d.estimated).length;
  const dispatchIssue = data.debug?.dispatches?.error || data.debug?.dispatches?.errors;
  if (estimatedDays > 0 || data.debug?.dispatches) {
    statusEl.hidden = false;
    let html = estimatedDays > 0 ? renderRateDebug(data, estimatedDays) : "";
    if (dispatchIssue) {
      const d = data.debug.dispatches;
      html +=
        (html ? "<br><br>" : "") +
        `Couldn't fetch smart-charge dispatch history (step: ${d.step ?? "?"}): ` +
        `${Array.isArray(dispatchIssue) ? dispatchIssue.join("; ") : dispatchIssue}. ` +
        "Off-peak pricing is using the standard 23:30–05:30 window only, so on nights with a bonus " +
        "smart-charge dispatch the peak/off-peak split (and total cost) may be less accurate than usual.";
    } else if (data.debug?.dispatches?.dispatchesThisMonth != null) {
      html +=
        (html ? "<br><br>" : "") +
        `Found ${data.debug.dispatches.dispatchesThisMonth} smart-charge dispatch window(s) this month, ` +
        "applied on top of the standard off-peak window.";
    }
    if (data.debug?.evThresholdReclassifiedSlots) {
      html +=
        (html ? "<br><br>" : "") +
        `Also treated ${data.debug.evThresholdReclassifiedSlots} half-hour slot(s) totalling ` +
        `${data.debug.evThresholdReclassifiedKwh} kWh as off-peak EV charging (drawing over ` +
        `${data.debug.evThresholdKwh} kWh/slot outside the standard window).`;
    }
    statusEl.innerHTML = html;
  }
}

function renderRateDebug(data, estimatedDays) {
  const d = data.debug || {};
  const segments = (d.tariffSegments || [])
    .map((s) => {
      const bits = [`tariff <code>${s.tariffCode ?? "?"}</code>`, `product <code>${s.productCode ?? "?"}</code>`];
      if (s.error) bits.push(`error: ${s.error}`);
      if (s.rateError) bits.push(`rate fetch error: ${s.rateError}`);
      if (s.rateRecordCount != null) bits.push(`${s.rateRecordCount} rate records`);
      if (s.standingChargeError) bits.push(`standing charge fetch error: ${s.standingChargeError}`);
      let line = bits.join(", ");
      if (s.product) {
        line += s.product.error
          ? `<br>&nbsp;&nbsp;product lookup error: ${s.product.error}`
          : `<br>&nbsp;&nbsp;product: "${s.product.fullName ?? s.product.displayName ?? "?"}", ` +
            `business: ${s.product.isBusiness}, variable: ${s.product.isVariable}, ` +
            `available ${s.product.availableFrom ?? "?"} → ${s.product.availableTo ?? "ongoing"}`;
      }
      if (s.rateProbeError) {
        line += `<br>&nbsp;&nbsp;probe error: ${s.rateProbeError}`;
      } else if (s.rateProbe) {
        line +=
          `<br>&nbsp;&nbsp;probe (no date filter): ${s.rateProbe.totalCountEver ?? "?"} rate record(s) exist in total` +
          (s.rateProbe.sample.length
            ? ", most recent: " +
              s.rateProbe.sample
                .map((r) => `${r.valid_from}→${r.valid_to} @ ${r.value_inc_vat}p`)
                .join("; ")
            : "");
      }
      if (s.dayRateRecordCount != null || s.nightRateRecordCount != null) {
        line +=
          `<br>&nbsp;&nbsp;day/night rates used instead: ${s.dayRateRecordCount ?? 0} day, ` +
          `${s.nightRateRecordCount ?? 0} night record(s)`;
      }
      return line;
    })
    .join("<br>");

  return (
    `${estimatedDays} of ${data.days.length} day(s) are missing a unit rate match, so only the ` +
    "standing charge is included for them.<br>" +
    `<small>Rate map has ${d.rateMapSize ?? "?"} entries. ` +
    `Sample consumption interval_start: <code>${d.sampleConsumptionIntervalStart ?? "?"}</code>. ` +
    `Sample rate keys: <code>${(d.sampleRateKeys || []).join(", ") || "none"}</code>.<br>` +
    (segments ? segments + "<br>" : "") +
    "</small>"
  );
}

function renderChart(days) {
  const chart = document.getElementById("chart");
  chart.innerHTML = "";
  const maxCost = Math.max(...days.map((d) => d.costGBP), 0.01);

  for (const day of days) {
    const bar = document.createElement("div");
    bar.className = "chart__bar";

    const fill = document.createElement("div");
    fill.className = "chart__bar-fill" + (day.estimated ? " is-estimated" : "");
    const heightPct = Math.max((day.costGBP / maxCost) * 100, 1);
    fill.style.height = `${heightPct}%`;
    fill.title = `${day.date}: ${gbp.format(day.costGBP)}`;

    const label = document.createElement("span");
    label.className = "chart__bar-label";
    label.textContent = String(new Date(day.date + "T00:00:00").getDate());

    bar.appendChild(fill);
    bar.appendChild(label);
    chart.appendChild(bar);
  }
}

function renderTable(days, hasExport) {
  const tbody = document.querySelector("#days-table tbody");
  tbody.innerHTML = "";
  for (const day of [...days].reverse()) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${dateFormatter.format(new Date(day.date + "T00:00:00"))}</td>
      <td>${day.kwh.toFixed(2)}</td>
      <td>${gbp.format(day.offPeakCostGBP)}</td>
      <td>${gbp.format(day.onPeakCostGBP)}</td>
      <td>${gbp.format(day.standingChargeGBP)}</td>
      <td>${gbp.format(day.costGBP)}${day.estimated ? " *" : ""}</td>
      ${hasExport ? `<td>${gbp.format(day.exportProfitGBP)}</td>` : ""}
    `;
    tbody.appendChild(tr);
  }
}

function showError(data) {
  const statusEl = document.getElementById("status");
  statusEl.hidden = false;
  if (data.error === "not_configured") {
    statusEl.innerHTML =
      "This app isn't configured yet. Set <code>OCTOPUS_API_KEY</code> and " +
      "<code>OCTOPUS_ACCOUNT_NUMBER</code> as Cloudflare Pages secrets (see the README) and reload.";
  } else {
    statusEl.textContent = data.message || "Something went wrong loading your costs.";
  }
}

main();
