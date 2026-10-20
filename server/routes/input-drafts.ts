/**
 * 输入框草稿持久化路由
 *
 * GET /api/input-drafts?surface=electron — 读取该 surface 全量草稿（启动 hydrate 用）
 * PUT /api/input-drafts — upsert 一条草稿；text 为空即删除
 *   body: { surface, scope: "home", text, doc? }
 *       | { surface, sessionId, text, doc? }
 *       | { surface, sessionPath, text, doc? }  // 边界立即解析为 sessionId，失败 400
 *
 * 鉴权与 /api/preferences/* 同级（认证 principal 即可）。sessionPath 只作为兼容
 * 输入，route 必须先解析为 sessionId，持久层不接受 path 作为身份键。
 */
import { Hono } from "hono";
import { safeJson } from "../hono-helpers.ts";
import { normalizeInputDraftSurface } from "../../shared/input-drafts.ts";

export function createInputDraftsRoute(engine) {
  const route = new Hono();

  route.get("/input-drafts", (c) => {
    try {
      const surface = normalizeInputDraftSurface(c.req.query("surface"));
      if (!surface) return c.json({ error: "input draft surface is invalid" }, 400);
      return c.json(engine.getInputDrafts(surface));
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  route.put("/input-drafts", async (c) => {
    try {
      const body = await safeJson(c);
      if (!body || typeof body !== "object") {
        return c.json({ error: "invalid JSON body" }, 400);
      }
      const surface = normalizeInputDraftSurface(body.surface);
      if (!surface) return c.json({ error: "input draft surface is invalid" }, 400);
      const entry = {
        text: typeof body.text === "string" ? body.text : "",
        doc: body.doc,
        updatedAt: Date.now(),
      };
      if (body.scope === "home") {
        engine.setHomeInputDraft(surface, entry);
        return c.json({ ok: true });
      }
      // session 身份：sessionId 直取；sessionPath 在边界解析，失败显式报错（底线：禁止拿 path 当键）
      let sessionId = typeof body.sessionId === "string" && body.sessionId.trim() ? body.sessionId.trim() : null;
      if (!sessionId && typeof body.sessionPath === "string" && body.sessionPath.trim()) {
        sessionId = engine.getSessionIdForPath?.(body.sessionPath) || null;
        if (!sessionId) return c.json({ error: "sessionPath does not resolve to a session" }, 400);
      }
      if (!sessionId) {
        return c.json({ error: "draft scope requires 'home', a sessionId, or a resolvable sessionPath" }, 400);
      }
      engine.setSessionInputDraft(surface, sessionId, entry);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err.message }, 400);
    }
  });

  return route;
}
