import { Hono } from "hono";
import { isDreamErrorCode, type DreamErrorCode } from "../../lib/memory/dream/state-store.ts";
import { denyWithoutScope } from "../http/capability-guard.ts";
import { AgentNotFoundError, resolveAgentStrict } from "../utils/resolve-agent.ts";

function unavailable(c: any, message = "Memory Dream is unavailable for this agent") {
  return c.json({ code: "dream_unavailable", error: message }, 503);
}

function dreamErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string") {
    return (error as { message: string }).message;
  }
  return String(error);
}

function dreamErrorCode(error: unknown, fallback: DreamErrorCode): DreamErrorCode {
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  if (isDreamErrorCode(code)) return code;
  if (code === "DREAM_ALREADY_RUNNING") return "dream_already_running";
  if (code === "DREAM_MEMORY_BUSY") return "dream_memory_busy";
  return fallback;
}

function dreamErrorStatus(code: DreamErrorCode) {
  switch (code) {
    case "dream_revision_not_found":
      return 404;
    case "dream_memory_disabled":
    case "dream_memory_busy":
    case "dream_already_running":
    case "dream_no_memory":
    case "dream_memory_changed":
      return 409;
    case "dream_unavailable":
      return 503;
    case "dream_restore_failed":
    case "dream_run_failed":
      return 500;
  }
}

function dreamErrorResponse(c: any, error: unknown, fallback: DreamErrorCode) {
  const code = dreamErrorCode(error, fallback);
  return c.json({ code, error: dreamErrorMessage(error) }, dreamErrorStatus(code));
}

export function createMemoryDreamRoute(engine: any) {
  const route = new Hono();

  route.get("/memories/dream/status", async (c) => {
    try {
      const agent = resolveAgentStrict(engine, c);
      const ticker = agent.memoryTicker;
      if (!ticker?.getDreamStatus) return unavailable(c);
      return c.json({ agentId: agent.id, ...ticker.getDreamStatus() });
    } catch (err: any) {
      if (err instanceof AgentNotFoundError) return c.json({ error: err.message }, 404);
      return dreamErrorResponse(c, err, "dream_unavailable");
    }
  });

  route.post("/memories/dream/runs", async (c) => {
    try {
      const denied = denyWithoutScope(c, "settings.write");
      if (denied) return denied;
      const agent = resolveAgentStrict(engine, c);
      const ticker = agent.memoryTicker;
      if (!ticker?.startDream) return unavailable(c);
      if (agent.memoryMasterEnabled === false) {
        return c.json({
          code: "dream_memory_disabled",
          error: "Memory is disabled for this agent",
        }, 409);
      }
      const started = ticker.startDream({ trigger: "manual" });
      return c.json({ agentId: agent.id, ...started }, 202);
    } catch (err: any) {
      if (err instanceof AgentNotFoundError) return c.json({ error: err.message }, 404);
      return dreamErrorResponse(c, err, "dream_run_failed");
    }
  });

  route.get("/memories/dream/revisions", async (c) => {
    try {
      const agent = resolveAgentStrict(engine, c);
      const ticker = agent.memoryTicker;
      if (!ticker?.listDreamRevisions) return unavailable(c);
      return c.json({ agentId: agent.id, revisions: ticker.listDreamRevisions() });
    } catch (err: any) {
      if (err instanceof AgentNotFoundError) return c.json({ error: err.message }, 404);
      return dreamErrorResponse(c, err, "dream_unavailable");
    }
  });

  route.get("/memories/dream/revisions/:revisionId", async (c) => {
    try {
      const agent = resolveAgentStrict(engine, c);
      const ticker = agent.memoryTicker;
      if (!ticker?.getDreamRevision) return unavailable(c);
      return c.json({ agentId: agent.id, revision: ticker.getDreamRevision(c.req.param("revisionId")) });
    } catch (err: any) {
      if (err instanceof AgentNotFoundError) return c.json({ error: err.message }, 404);
      if (/not found/i.test(dreamErrorMessage(err))) {
        return dreamErrorResponse(c, err, "dream_revision_not_found");
      }
      return dreamErrorResponse(c, err, "dream_unavailable");
    }
  });

  route.post("/memories/dream/revisions/:revisionId/restore", async (c) => {
    try {
      const denied = denyWithoutScope(c, "settings.write");
      if (denied) return denied;
      const agent = resolveAgentStrict(engine, c);
      const ticker = agent.memoryTicker;
      if (!ticker?.restoreDreamRevision) return unavailable(c);
      const result = await ticker.restoreDreamRevision(c.req.param("revisionId"));
      return c.json({ agentId: agent.id, ok: true, ...result });
    } catch (err: any) {
      if (err instanceof AgentNotFoundError) return c.json({ error: err.message }, 404);
      if (/not found/i.test(dreamErrorMessage(err))) {
        return dreamErrorResponse(c, err, "dream_revision_not_found");
      }
      return dreamErrorResponse(c, err, "dream_restore_failed");
    }
  });

  return route;
}
