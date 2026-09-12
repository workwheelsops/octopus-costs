import { computeCosts } from "./costs.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/costs" && request.method === "GET") {
      return computeCosts(env);
    }
    return env.ASSETS.fetch(request);
  },
};
