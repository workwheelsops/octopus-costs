# Octopus Costs

A small dashboard that shows your Octopus Energy electricity spend for the
current calendar month: total cost so far, total kWh used, average daily
cost, and a day-by-day breakdown/chart.

It's a Cloudflare Worker with static assets: a static frontend
(`public/index.html` / `public/style.css` / `public/app.js`) served
directly, plus a small Worker (`src/worker.js` / `src/costs.js`) that
handles `GET /api/costs` by talking to the Octopus API server-side, so your
API key never reaches the browser.

## How it works

- The Worker reads your account from `GET /v1/accounts/{account_number}/`
  to find your electricity meter point (MPAN), meter serial number, and the
  tariff agreements that were/are active this month.
- It fetches half-hourly consumption for the month, plus the half-hourly
  unit rates and standing charges that applied for each agreement (this
  works for flat tariffs too — the rate is just constant).
- It multiplies consumption by the rate in force for each 30-minute slot,
  adds the standing charge once per day, and groups the result by calendar
  day (Europe/London).

This is an **estimate** — it uses published unit rates/standing charges, not
your actual bill, so small rounding or billing-period differences are
possible.

By default the import (non-export) electricity meter point is used, and the
most recently listed meter on it — which covers the common case, including
a solar export meter point existing alongside it. If your account has an
unusual setup (e.g. a meter exchange where auto-detection picks the wrong
one), set these optional secrets to pin the exact meter:

- `OCTOPUS_MPAN` — the exact meter point (MPAN) to use.
- `OCTOPUS_METER_SERIAL` — the exact meter serial number to use.

If your account also has a solar export meter point, it's auto-detected
(`is_export: true`) and priced the same way to show export profit per day.
Override with `OCTOPUS_EXPORT_MPAN` / `OCTOPUS_EXPORT_METER_SERIAL` if
auto-detection picks the wrong one.

Gas is not included.

## Prerequisites

- An Octopus Energy account.
- An API key: log in at [octopus.energy](https://octopus.energy), go to
  **Personal details → API access**, and generate/copy your API key
  (starts with `sk_live_`).
- Your account number (format `A-XXXXXXXX`), shown on the same page or on
  any bill.

## Local development

```bash
npm install
cp .dev.vars.example .dev.vars
# edit .dev.vars with your real API key and account number
npm run dev
```

This runs the Worker locally with Wrangler's dev server at
`http://localhost:8787`, serving the static files from `public/` and
handling `/api/costs` with live reload.

## Deploy to Cloudflare

### Option A: Git integration (recommended)

1. Push this repo to GitHub/GitLab.
2. In the Cloudflare dashboard, go to **Workers & Pages → Create → Import a
   repository**, and pick this repo. It will detect `wrangler.toml` and use
   `npx wrangler deploy` as the deploy command automatically.
3. After the first deploy, go to the project's **Settings → Variables and
   Secrets** and add these as **secrets** (not plain text variables):
   - `OCTOPUS_API_KEY`
   - `OCTOPUS_ACCOUNT_NUMBER`
   - `OCTOPUS_MPAN` / `OCTOPUS_METER_SERIAL` (optional, see above)
4. Redeploy (or trigger a new deployment) so the Worker picks up the
   secrets.

### Option B: Wrangler CLI

```bash
npx wrangler login
npm run secret:key       # paste your Octopus API key when prompted
npm run secret:account   # paste your account number when prompted
npm run deploy
```

## Notes

- The Octopus API key and account number are only ever read server-side in
  `src/costs.js` via Cloudflare's secret environment variables — they're
  never committed to the repo and never sent to the browser.
- `.dev.vars` (used for local dev) is git-ignored; only
  `.dev.vars.example` is committed.
- Static files in `public/` are served directly by Cloudflare's asset
  handling; only requests to `/api/costs` reach the Worker script.
