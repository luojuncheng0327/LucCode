/**
 * confirm.js — 阻塞式确认 REST API
 *
 * 前端渲染确认卡片后，用户通过此 API resolve pending confirmation。
 */

import { Hono } from "hono";
import { safeJson } from "../hono-helpers.ts";
import { createRequestContext } from "../http/boundary.ts";

export function createConfirmRoute(confirmStore, engine) {
  const route = new Hono();

  route.post("/confirm/:confirmId", async (c) => {
    const confirmId = c.req.param("confirmId");
    const body = await safeJson(c);
    const { action, value } = body;

    if (!action || !["confirmed", "rejected"].includes(action)) {
      return c.json({ error: "action must be 'confirmed' or 'rejected'" }, 400);
    }

    const pending = typeof confirmStore.get === "function" ? confirmStore.get(confirmId) : null;
    if (!pending) {
      return c.json({ error: "confirmation not found or already resolved" }, 404);
    }

    const auth = authorizeConfirmation(c, engine, pending);
    if (!auth.allowed) {
      return c.json({
        error: "insufficient_scope",
        reason: auth.reason,
        capability: auth.capability,
      }, 403);
    }

    const found = confirmStore.resolve(confirmId, action, value);
    if (!found) {
      return c.json({ error: "confirmation not found or already resolved" }, 404);
    }

    // 广播状态变更，让前端更新卡片
    engine.emitEvent({
      type: "confirmation_resolved",
      confirmId,
      action,
      value,
    }, null);

    return c.json({ ok: true });
  });

  return route;
}

function authorizeConfirmation(c, engine, pending) {
  const requestContext = createRequestContext(c, engine);
  const capability = capabilityForConfirmation(pending);
  const target = targetForConfirmation(pending, requestContext);
  if (!target) {
    return {
      allowed: false,
      reason: "missing_confirmation_target",
      capability,
    };
  }
  const decision = requestContext.authorize(capability, target);
  return {
    allowed: !!decision.allowed,
    reason: decision.reason || (decision.allowed ? "allowed" : "insufficient_capability"),
    capability,
  };
}

function capabilityForConfirmation(pending) {
  if (pending?.kind === "settings") return "settings.write";
  return "sessions.write";
}

function targetForConfirmation(pending, requestContext) {
  if (pending?.kind === "settings") {
    return {
      kind: "studio",
      studioId: requestContext.studioId,
    };
  }
  if (!pending?.sessionPath) return null;
  return {
    kind: "session",
    studioId: requestContext.studioId,
    sessionId: pending.sessionId || null,
    sessionPath: pending.sessionPath,
  };
}
