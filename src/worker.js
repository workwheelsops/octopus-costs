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
      return withEdgeCache(request, env, forceRefresh, () => computeHistory(env), HISTORY_CACHE_SECONDS);
    }
    return env.ASSETS.fetch(request);
  },
};

async function withEdgeCache(request, env, forceRefresh, computeFn, ttlSeconds) {
  const cache = caches.default;
  // caches.default is per-datacenter and has no idea the Worker's code
  // changed between deploys, so a stale response from the previous version
  // can keep being served from whatever edge location handles a request for
  // up to ttlSeconds after a fix ships. Fold in the deployment version so
  // every deploy gets a fresh cache key automatically - old entries are
  // simply never looked up again rather than needing manual invalidation.
  const version = env.CF_VERSION_METADATA?.id ?? "dev";
  const url = new URL(request.url);
  const cacheKey = new Request(`${url.origin}${url.pathname}?v=${version}`, { method: "GET" });

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
