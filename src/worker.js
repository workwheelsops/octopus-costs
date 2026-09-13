import { computeCosts, computeHistoricalMonths, computeCurrentMonthHistory } from "./costs.js";

// Closed historical months never change once the month ends, so they're
// cached for a long time - there's no reason to re-fetch ~34k consumption
// records plus every historical tariff's rates just because the cache
// expired. The current (still open) month - both the /api/costs view and
// history's current-month slice - only actually changes once a day, when
// Octopus publishes the previous day's half-hourly consumption (typically
// by evening), so there's no need to recompute it from scratch on every
// page load either; it's cached for a shorter time than the historical
// months, just long enough to make repeat loads fast without going stale
// for long. Append ?refresh=1 to force all of it to recompute (e.g. right
// after adding a secret that changes how something is priced, or to pick
// up today's data as soon as it lands rather than waiting for the cache to
// expire).
const HISTORICAL_CACHE_SECONDS = 24 * 60 * 60;
const CURRENT_MONTH_CACHE_SECONDS = 30 * 60;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/costs" && request.method === "GET") {
      const forceRefresh = url.searchParams.has("refresh");
      return withEdgeCache(request, env, forceRefresh, () => computeCosts(env), CURRENT_MONTH_CACHE_SECONDS, "costs");
    }
    if (url.pathname === "/api/history" && request.method === "GET") {
      const forceRefresh = url.searchParams.has("refresh");
      return handleHistory(request, env, forceRefresh);
    }
    return env.ASSETS.fetch(request);
  },
};

async function handleHistory(request, env, forceRefresh) {
  const historicalRes = await withEdgeCache(
    request,
    env,
    forceRefresh,
    () => computeHistoricalMonths(env),
    HISTORICAL_CACHE_SECONDS,
    "historical"
  );
  if (historicalRes.status !== 200) return historicalRes;
  const historical = await historicalRes.clone().json();

  const currentRes = await withEdgeCache(
    request,
    env,
    forceRefresh,
    () => computeCurrentMonthHistory(env, historical.finalRunningSavingGBP ?? 0),
    CURRENT_MONTH_CACHE_SECONDS,
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

async function withEdgeCache(request, env, forceRefresh, computeFn, ttlSeconds, keySuffix) {
  const cache = caches.default;
  // caches.default is per-datacenter and has no idea the Worker's code
  // changed between deploys, so a stale response from the previous version
  // can keep being served from whatever edge location handles a request for
  // up to ttlSeconds after a fix ships. Fold in the deployment version so
  // every deploy gets a fresh cache key automatically - old entries are
  // simply never looked up again rather than needing manual invalidation.
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
  headers.set("Cache-Control", `public, max-age=${ttlSeconds}`);
  headers.set("X-Cache-Generated-At", new Date().toISOString());

  const toCache = new Response(bodyText, { status: response.status, headers });
  await cache.put(cacheKey, toCache.clone());
  return toCache;
}
