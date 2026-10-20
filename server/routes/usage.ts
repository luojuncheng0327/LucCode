import { Hono } from "hono";

export function createUsageRoute(engine) {
  const route = new Hono();

  route.get("/usage/llm", (c) => {
    const query = c.req.query();
    const filter: Record<string, any> = {};
    for (const key of [
      "since",
      "until",
      "attributionKind",
      "sessionId",
      "sessionPath",
      "childSessionId",
      "childSessionPath",
      "agentId",
      "subsystem",
      "operation",
      "modelId",
      "provider",
      "status",
    ]) {
      if (typeof query[key] === "string" && query[key].trim()) filter[key] = query[key].trim();
    }
    const hasDateWindow = !!filter.since || !!filter.until;
    if (typeof query.limit === "string" && query.limit.trim()) {
      const rawLimit = query.limit.trim().toLowerCase();
      if (rawLimit !== "all") {
        const limit = Number(rawLimit);
        filter.limit = Number.isFinite(limit) && limit > 0
          ? Math.min(Math.floor(limit), 2_000)
          : 500;
      }
    } else if (!hasDateWindow) {
      filter.limit = 500;
    }
    return c.json(engine.usageLedger.list(filter));
  });

  return route;
}
