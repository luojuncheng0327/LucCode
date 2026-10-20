/**
 * 头像管理 REST 路由
 *
 * GET    /api/avatar/:role  → 返回头像图片（role = agent | user）
 * POST   /api/avatar/:role  → 上传头像（base64）
 * DELETE /api/avatar/:role  → 删除自定义头像，恢复默认
 *
 * agent 头像存在 agentDir/avatars/，user 头像存在 userDir/avatars/
 *
 * user 头像与 agent 无关，agent 头像必须由请求显式给出 agentId：
 * 服务端不替调用方挑 agent，两个客户端各开一个 agent 时挑错就会读到
 * 或覆盖掉另一个 agent 的头像。
 */
import fs from "fs/promises";
import fsSync from "node:fs";
import path from "path";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { safeJson } from "../hono-helpers.ts";
import { AgentNotFoundError, resolveAgentStrict } from "../utils/resolve-agent.ts";

const VALID_ROLES = new Set(["agent", "user"]);

export function createAvatarRoute(engine) {
  const route = new Hono();

  const userAvatarDir = path.join(engine.userDir, "avatars");

  // 根据 role 选择存储目录；agent 目录由请求携带的 agentId 决定
  function avatarDirFor(role, c) {
    if (role === "user") return userAvatarDir;
    return path.join(resolveAgentStrict(engine, c).agentDir, "avatars");
  }

  // user 头像目录与请求无关，可以启动期建好（避免首个请求的 race condition）；
  // agent 头像目录要等请求说明是哪个 agent，写入前按需创建。
  fsSync.mkdirSync(userAvatarDir, { recursive: true });

  /**
   * 解析本次请求的头像目录。
   * agentId 缺失或指向不存在的 agent 时返回 404 —— 不回落到任何默认 agent。
   */
  function avatarDirOrNotFound(role, c) {
    try {
      return { dir: avatarDirFor(role, c), notFound: null };
    } catch (err) {
      if (err instanceof AgentNotFoundError) {
        return { dir: null, notFound: c.json({ error: err.message }, 404) };
      }
      throw err;
    }
  }

  /** 查找 role 对应的头像文件（支持 png/jpg/webp） */
  async function findAvatar(role, dir) {
    for (const ext of ["png", "jpg", "jpeg", "webp"]) {
      const p = path.join(dir, `${role}.${ext}`);
      try {
        await fs.access(p);
        return { path: p, ext };
      } catch {}
    }
    return null;
  }

  // ── 获取头像 ──
  route.get("/avatar/:role", async (c) => {
    const role = c.req.param("role");
    if (!VALID_ROLES.has(role)) {
      return c.json({ error: "role must be agent or user" }, 400);
    }

    const { dir, notFound } = avatarDirOrNotFound(role, c);
    if (notFound) return notFound;

    const found = await findAvatar(role, dir);
    if (!found) {
      return c.json({ error: "no custom avatar" }, 404);
    }

    const mimeMap = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" };
    const stat = await fs.stat(found.path);
    const etag = `"${stat.mtimeMs.toString(36)}-${stat.size.toString(36)}"`;

    // 条件请求：头像几乎不变，用 ETag 避免重复传输
    if (c.req.header("if-none-match") === etag) {
      return c.body(null, 304);
    }

    const buf = await fs.readFile(found.path);
    c.header("Content-Type", mimeMap[found.ext] || "image/png");
    c.header("Cache-Control", "max-age=3600, must-revalidate");
    c.header("ETag", etag);
    return c.body(buf);
  });

  // ── 上传头像（base64） ──
  route.post("/avatar/:role", bodyLimit({ maxSize: 15 * 1024 * 1024 }), async (c) => {
    const role = c.req.param("role");
    if (!VALID_ROLES.has(role)) {
      return c.json({ error: "role must be agent or user" }, 400);
    }

    const body = await safeJson(c);
    const { data } = body;
    if (!data || typeof data !== "string") {
      return c.json({ error: "data (base64) is required" }, 400);
    }

    const match = data.match(/^data:image\/(png|jpe?g|webp);base64,(.+)$/);
    if (!match) {
      return c.json({ error: "invalid data URL format" }, 400);
    }

    const ext = match[1] === "jpeg" ? "jpg" : match[1];
    const buf = Buffer.from(match[2], "base64");
    const { dir, notFound } = avatarDirOrNotFound(role, c);
    if (notFound) return notFound;
    await fs.mkdir(dir, { recursive: true });

    // 删除旧头像（可能是不同格式）
    for (const oldExt of ["png", "jpg", "jpeg", "webp"]) {
      try { await fs.unlink(path.join(dir, `${role}.${oldExt}`)); } catch {}
    }

    // 写入新头像
    await fs.writeFile(path.join(dir, `${role}.${ext}`), buf);
    return c.json({ ok: true, ext });
  });

  // ── 删除头像（恢复默认） ──
  route.delete("/avatar/:role", async (c) => {
    const role = c.req.param("role");
    if (!VALID_ROLES.has(role)) {
      return c.json({ error: "role must be agent or user" }, 400);
    }

    const { dir, notFound } = avatarDirOrNotFound(role, c);
    if (notFound) return notFound;
    for (const ext of ["png", "jpg", "jpeg", "webp"]) {
      try { await fs.unlink(path.join(dir, `${role}.${ext}`)); } catch {}
    }
    return c.json({ ok: true });
  });

  return route;
}
