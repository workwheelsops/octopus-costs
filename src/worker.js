import { computeCosts, computeHistory } from "./costs.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/costs" && request.method === "GET") {
      return computeCosts(env);
    }
    if (url.pathname === "/api/history" && request.method === "GET") {
      return computeHistory(env);
    }
    return env.ASSETS.fetch(request);
  },
};
