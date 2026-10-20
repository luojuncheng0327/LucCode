import path from "path";
import { Hono } from "hono";
import { safeJson } from "../hono-helpers.ts";
import { denyWithoutScope } from "../http/capability-guard.ts";
import {
  listResolvedExperiments,
  setExperimentValue,
} from "../../lib/experiments/registry.ts";
import {
  deleteCacheSnapshotObservation,
  readCacheSnapshotObservation,
} from "../../lib/memory/cache-snapshot-observation.ts";

function normalizeAgentId(value) {
  const id = String(value || "").trim();
  if (!id) throw new Error("agentId is required");
  if (id.includes("/") || id.includes("\\") || id === "." || id === "..") {
    throw new Error("agentId is invalid");
  }
  return id;
}

function resolveAgentDir(engine, rawAgentId) {
  const agentId = normalizeAgentId(rawAgentId);
  if (typeof engine.getAgentDir === "function") return engine.getAgentDir(agentId);
  if (!engine.agentsDir) throw new Error("agent directory resolver unavailable");
  return path.join(engine.agentsDir, agentId);
}

export function createExperimentsRoute(engine) {
  const route = new Hono();

  route.get("/experiments", async (c) => {
    try {
      return c.json({ experiments: listResolvedExperiments(engine.preferences) });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  route.patch("/experiments/:id", async (c) => {
    try {
      const denied = denyWithoutScope(c, "settings.write");
      if (denied) return denied;
      const body = await safeJson(c);
      const value = setExperimentValue(engine.preferences, c.req.param("id"), body?.value);
      return c.json({ ok: true, value });
    } catch (err) {
      return c.json({ error: err.message }, 400);
    }
  });

  route.get("/experiments/memory/cache-snapshot-reflection/observation", async (c) => {
    try {
      const agentDir = resolveAgentDir(engine, c.req.query("agentId"));
      return c.json({ observation: readCacheSnapshotObservation(agentDir) });
    } catch (err) {
      return c.json({ error: err.message }, 400);
    }
  });

  route.delete("/experiments/memory/cache-snapshot-reflection/observation", async (c) => {
    try {
      const denied = denyWithoutScope(c, "settings.write");
      if (denied) return denied;
      const agentDir = resolveAgentDir(engine, c.req.query("agentId"));
      return c.json({ ok: true, deleted: deleteCacheSnapshotObservation(agentDir) });
    } catch (err) {
      return c.json({ error: err.message }, 400);
    }
  });

  return route;
}
