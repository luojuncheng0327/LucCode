import { Hono } from "hono";
import { SESSION_COLLAB_DECISION_RECORD_TYPE, buildSessionCollabDecision } from "../../lib/session-collab/decision-record.ts";
import { isSessionCollabPartialSuccessError } from "../../lib/session-collab/draft-store.ts";

/**
 * 把草稿卡决策写进源 session 的 JSONL（custom entry）。决策记录失败不该让已经
 * 成功的投递/忽略报错——投递本体已经发生，回滚会更糟——但必须在响应里显式
 * 带出 decisionPersisted:false，不静默吞掉。
 */
async function recordDecision(engine: any, sourceSessionId: string, decision: any): Promise<boolean> {
  try {
    if (typeof engine?.getSessionManifest !== "function" || typeof engine?.ensureSessionLoaded !== "function") {
      console.warn(`[session-collab] decision not persisted (engine missing manifest/session APIs) for source session ${sourceSessionId}`);
      return false;
    }
    const manifest = engine.getSessionManifest(sourceSessionId);
    const sessionPath = manifest?.currentLocator?.path;
    if (typeof sessionPath !== "string" || !sessionPath) {
      console.warn(`[session-collab] decision not persisted (no session manifest) for source session ${sourceSessionId}`);
      return false;
    }
    const session = await engine.ensureSessionLoaded(sessionPath);
    if (typeof session?.sessionManager?.appendCustomEntry !== "function") {
      console.warn(`[session-collab] decision not persisted (no appendCustomEntry) for source session ${sourceSessionId}`);
      return false;
    }
    session.sessionManager.appendCustomEntry(SESSION_COLLAB_DECISION_RECORD_TYPE, decision);
    return true;
  } catch (err: any) {
    console.warn(`[session-collab] decision persist failed for source session ${sourceSessionId}: ${err?.message || err}`);
    return false;
  }
}

export function createSessionCollabRoute(engine: any) {
  const route = new Hono();
  route.post("/session-collab/apply", async (c) => {
    const store = engine.sessionCollabDraftStore || null;
    if (!store) return c.json({ error: "draft store unavailable" }, 500);
    let body: any = null;
    try { body = await c.req.json(); } catch { return c.json({ error: "invalid json" }, 400); }
    const suggestionId = typeof body?.suggestionId === "string" ? body.suggestionId.trim() : "";
    if (!suggestionId) return c.json({ error: "suggestionId required" }, 400);
    // apply 成功后条目已删，需在 apply 前先快照拿 sourceSessionId。
    const snapshot = store.get(suggestionId);
    try {
      const applied = await store.apply(suggestionId, body?.draft || {});
      if (!applied.ok && applied.reason === "in-flight") {
        return c.json({ error: "draft is being applied", code: "draft_in_flight" }, 409);
      }
      if (!applied.ok) return c.json({ error: "draft not found or already applied", code: "draft_expired" }, 404);
      let decisionPersisted = false;
      if (snapshot?.sourceSessionId) {
        decisionPersisted = await recordDecision(engine, snapshot.sourceSessionId, buildSessionCollabDecision({
          suggestionId,
          status: "approved",
          resultSessionId: (applied.result as any)?.sessionId || null,
        }));
      }
      return c.json({ ok: true, result: applied.result ?? null, decisionPersisted });
    } catch (err: any) {
      const message = err?.message || String(err);
      if (isSessionCollabPartialSuccessError(err)) {
        let decisionPersisted = false;
        if (snapshot?.sourceSessionId) {
          decisionPersisted = await recordDecision(engine, snapshot.sourceSessionId, buildSessionCollabDecision({
            suggestionId,
            status: "approved",
            resultSessionId: err.sessionId,
          }));
        }
        return c.json({
          ok: false,
          partialSuccess: true,
          error: message,
          code: err.code,
          sessionId: err.sessionId,
          result: err.result,
          decisionPersisted,
        }, 500);
      }
      // 兼容旧式字符串错误；新代码统一使用上面的结构化部分成功错误。
      const half = /^first_message_failed:([^:]+):/.exec(message);
      return c.json({
        error: message,
        code: half ? "first_message_failed" : "apply_failed",
        ...(half ? {
          partialSuccess: true,
          sessionId: half[1],
          result: { sessionId: half[1], sessionCreated: true, firstMessageAccepted: false },
        } : {}),
      }, 500);
    }
  });

  route.post("/session-collab/reject", async (c) => {
    const store = engine.sessionCollabDraftStore || null;
    if (!store) return c.json({ error: "draft store unavailable" }, 500);
    let body: any = null;
    try { body = await c.req.json(); } catch { return c.json({ error: "invalid json" }, 400); }
    const suggestionId = typeof body?.suggestionId === "string" ? body.suggestionId.trim() : "";
    if (!suggestionId) return c.json({ error: "suggestionId required" }, 400);
    const bodySourceSessionId = typeof body?.sourceSessionId === "string" ? body.sourceSessionId.trim() : "";

    let sourceSessionId: string;
    const existing = store.get(suggestionId);
    if (existing) {
      const discarded = store.discard(suggestionId);
      if (!discarded) {
        return c.json({ error: "draft is being applied", code: "draft_in_flight" }, 409);
      }
      sourceSessionId = discarded.sourceSessionId;
    } else {
      if (!bodySourceSessionId) {
        return c.json({ error: "expired draft reject requires sourceSessionId" }, 400);
      }
      sourceSessionId = bodySourceSessionId;
    }

    const decisionPersisted = await recordDecision(engine, sourceSessionId, buildSessionCollabDecision({
      suggestionId,
      status: "rejected",
    }));
    return c.json({ ok: true, decisionPersisted });
  });

  return route;
}
