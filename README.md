# Octopus Costs

A small dashboard that shows your Octopus Energy electricity spend for the
current calendar month: total cost so far, total kWh used, average daily
cost, and a day-by-day breakdown/chart.

It's a static frontend (`index.html` / `style.css` / `app.js`) plus one
Cloudflare Pages Function (`functions/api/costs.js`) that talks to the
Octopus API server-side, so your API key never reaches the browser.

## How it works

- The function reads your account from `GET /v1/accounts/{account_number}/`
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

Only the first electricity meter point and first meter on the account are
used. Gas is not included.

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

This runs the site with Wrangler's local Pages emulator at
`http://localhost:8788`, including the `/api/costs` function.

## Deploy to Cloudflare Pages

### Option A: Git integration (recommended)

1. Push this repo to GitHub/GitLab.
2. In the Cloudflare dashboard, go to **Workers & Pages → Create → Pages →
   Connect to Git**, and pick this repo.
3. Build settings: leave the **build command** empty and set the **build
   output directory** to `/` (this is a static site with no build step).
4. After the first deploy, go to the project's **Settings → Environment
   variables** and add these as **secrets** (not plain variables), for both
   Production and Preview:
   - `OCTOPUS_API_KEY`
   - `OCTOPUS_ACCOUNT_NUMBER`
5. Redeploy (or trigger a new deployment) so the function picks up the
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
  `functions/api/costs.js` via Cloudflare's secret environment variables —
  they're never committed to the repo and never sent to the browser.
- `.dev.vars` (used for local dev) is git-ignored; only
  `.dev.vars.example` is committed.
