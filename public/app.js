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
  document.getElementById("summary").hidden = false;

  renderChart(data.days);
  document.getElementById("chart-section").hidden = false;

  renderTable(data.days);
  document.getElementById("table-section").hidden = false;

  document.getElementById("generated-at").textContent = new Date(data.generatedAt).toLocaleString(
    "en-GB"
  );
  document.getElementById("footer").hidden = false;
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

function renderTable(days) {
  const tbody = document.querySelector("#days-table tbody");
  tbody.innerHTML = "";
  for (const day of [...days].reverse()) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${dateFormatter.format(new Date(day.date + "T00:00:00"))}</td>
      <td>${day.kwh.toFixed(2)}</td>
      <td>${gbp.format(day.standingChargeGBP)}</td>
      <td>${gbp.format(day.costGBP)}${day.estimated ? " *" : ""}</td>
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
