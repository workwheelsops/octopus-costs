import {
  computeCosts,
  computeHistoricalMonths,
  computeCurrentMonthHistory,
  londonWallTimeToUTC,
} from "./costs.js";

// Everything cached here only actually changes once a day, when Octopus
// publishes the previous day's half-hourly consumption - typically by
// evening. Rather than a fixed TTL (which just counts down from whenever a
// cache entry happened to be written, drifting out of sync with that daily
// update), every cache entry's max-age is set to "seconds until the next
// occurrence of this cutoff" - so a cache entry never lives longer than a
// day, and a page load shortly after the cutoff always sees fresh figures
// rather than waiting out a fixed window. Append ?refresh=1 to force an
// immediate recompute regardless (e.g. right after adding a secret that
// changes how something is priced).
const REFRESH_CUTOFF_HOUR_LONDON = 19;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/costs" && request.method === "GET") {
      const forceRefresh = url.searchParams.has("refresh");
      return withEdgeCache(request, env, forceRefresh, () => computeCosts(env), "costs");
    }
    if (url.pathname === "/api/history" && request.method === "GET") {
      const forceRefresh = url.searchParams.has("refresh");
      return handleHistory(request, env, forceRefresh);
    }

    // The static files (index.html/app.js/style.css) aren't fingerprinted,
    // so nothing in their URL changes when a deploy updates them - whatever
    // caching header Cloudflare's asset serving defaults to is what decides
    // whether a browser notices a new deploy at all. Force revalidation
    // instead of trusting that default, so a fix shipped here is never
    // masked by a browser quietly running yesterday's app.js.
    const assetResponse = await env.ASSETS.fetch(request);
    const headers = new Headers(assetResponse.headers);
    headers.set("Cache-Control", "no-cache");
    return new Response(assetResponse.body, { status: assetResponse.status, headers });
  },
};

async function handleHistory(request, env, forceRefresh) {
  const historicalRes = await withEdgeCache(
    request,
    env,
    forceRefresh,
    () => computeHistoricalMonths(env),
    "historical"
  );
  if (historicalRes.status !== 200) return historicalRes;
  const historical = await historicalRes.clone().json();

  const currentRes = await withEdgeCache(
    request,
    env,
    forceRefresh,
    () => computeCurrentMonthHistory(env, historical.finalRunningSavingGBP ?? 0),
    "current"
  );
  if (currentRes.status !== 200) return currentRes;
  const current = await currentRes.clone().json();

  const merged = {
    accountNumber: current.accountNumber ?? historical.accountNumber,
    mpan: current.mpan ?? historical.mpan,
    meterSerial: current.meterSerial ?? historical.meterSerial,
    months: [...historical.months, ...current.months],
    periodFrom: historical.periodFrom,
    periodTo: current.periodTo,
    generatedAt: new Date().toISOString(),
    debug: { historical: historical.debug, current: current.debug },
  };

  const headers = new Headers({ "content-type": "application/json; charset=utf-8" });
  headers.set(
    "X-Cache-Generated-At",
    currentRes.headers.get("X-Cache-Generated-At") || new Date().toISOString()
  );
  return new Response(JSON.stringify(merged), { status: 200, headers });
}

async function withEdgeCache(request, env, forceRefresh, computeFn, keySuffix) {
  const cache = caches.default;
  // caches.default is per-datacenter and has no idea the Worker's code
  // changed between deploys, so a stale response from the previous version
  // can keep being served from whatever edge location handles a request
  // until it expires. Fold in the deployment version so every deploy gets a
  // fresh cache key automatically - old entries are simply never looked up
  // again rather than needing manual invalidation.
  const version = env.CF_VERSION_METADATA?.id ?? "dev";
  const url = new URL(request.url);
  const cacheKey = new Request(`${url.origin}${url.pathname}?v=${version}&part=${keySuffix}`, {
    method: "GET",
  });

  if (!forceRefresh) {
    const cached = await cache.match(cacheKey);
    if (cached) return cached;
  }

  const response = await computeFn();
  if (response.status !== 200) return response;

  const bodyText = await response.text();
  const headers = new Headers(response.headers);
  const ttlSeconds = secondsUntilNextLondonCutoff(REFRESH_CUTOFF_HOUR_LONDON);
  headers.set("Cache-Control", `public, max-age=${ttlSeconds}`);
  headers.set("X-Cache-Generated-At", new Date().toISOString());

  const toCache = new Response(bodyText, { status: response.status, headers });
  await cache.put(cacheKey, toCache.clone());
  return toCache;
}

// Seconds from now until the next occurrence of `cutoffHour`:00 Europe/London
// time - today's, if it hasn't happened yet, otherwise tomorrow's. Always
// somewhere between 0 and 24h, which is exactly what's wanted as a cache
// entry's max-age: it expires right when Octopus's daily update is expected,
// never later than a day after it was written.
function secondsUntilNextLondonCutoff(cutoffHour) {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
  })
    .formatToParts(now)
    .reduce((acc, p) => {
      acc[p.type] = p.value;
      return acc;
    }, {});

  const y = +parts.year;
  const mo = +parts.month;
  const d = +parts.day;
  const h = +parts.hour === 24 ? 0 : +parts.hour;

  const targetDay = h < cutoffHour ? d : d + 1;
  const cutoffInstant = londonWallTimeToUTC(y, mo, targetDay, cutoffHour, 0, 0);
  return Math.max(60, Math.round((cutoffInstant.getTime() - now.getTime()) / 1000));
}
