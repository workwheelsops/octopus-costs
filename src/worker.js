import { computeCosts, computeHistory } from "./costs.js";

// 24 months of history means ~34k consumption records plus rates for every
// historical tariff change - slow and wasteful to recompute on every load
// since everything before the current month is final. Cache it at the edge;
// append ?refresh=1 to force a recompute (e.g. right after adding a secret
// that changes how it's priced).
const HISTORY_CACHE_SECONDS = 30 * 60;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/costs" && request.method === "GET") {
      return computeCosts(env);
    }
    if (url.pathname === "/api/history" && request.method === "GET") {
      const forceRefresh = url.searchParams.has("refresh");
      return withEdgeCache(request, forceRefresh, () => computeHistory(env), HISTORY_CACHE_SECONDS);
    }
    return env.ASSETS.fetch(request);
  },
};

async function withEdgeCache(request, forceRefresh, computeFn, ttlSeconds) {
  const cache = caches.default;
  // Cache key ignores query params like ?refresh so a forced refresh also
  // overwrites the cached copy other requests will hit next.
  const cacheKey = new Request(new URL(request.url).origin + new URL(request.url).pathname, {
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
