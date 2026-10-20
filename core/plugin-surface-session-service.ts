import crypto from "crypto";
import fs from "fs";
import path from "path";
import { atomicWriteSync } from "../shared/safe-fs.ts";
import { securityDirPath } from "./security-dir.ts";

/**
 * Plugin surface session — 插件 iframe 表面的请求级入口凭证。
 *
 * 与 plugin-iframe-ticket（一次性、绑定单个 surfacePath 的加载凭证）和
 * plugin-asset-session（仅覆盖 /assets/ 静态文件 GET 的 cookie）相区分：
 * surface session 由宿主在签发 iframe ticket 时一并签发，随 iframe URL 下发，
 * 页面脚本在调用插件自己的 route handler 时通过 header / query 显式携带，
 * 服务端验证后铸造 plugin principal（kind: "plugin"），只授权该插件自身的
 * route 代理路径，不携带任何 studio scope。
 */
export const PLUGIN_SURFACE_SESSION_KEY_FILE = "plugin-surface-session-key";
export const PLUGIN_SURFACE_SESSION_ACTION = "plugins.surface";
export const DEFAULT_PLUGIN_SURFACE_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export class PluginSurfaceSessionError extends Error {
  declare code: string;
  declare status: number;

  constructor(message, { code = "plugin_surface_session_invalid", status = 403 } = {}) {
    super(message);
    this.name = "PluginSurfaceSessionError";
    this.code = code;
    this.status = status;
  }
}

export function issuePluginSurfaceSession({
  lucHome,
  pluginId,
  principalId,
  now = new Date().toISOString(),
  ttlMs = DEFAULT_PLUGIN_SURFACE_SESSION_TTL_MS,
}: { lucHome?: string; pluginId?: string; principalId?: string; now?: string; ttlMs?: number } = {}) {
  assertNonEmpty(lucHome, "lucHome");
  assertNonEmpty(pluginId, "pluginId");
  assertNonEmpty(principalId, "principalId");
  const issuedAtMs = Date.parse(now);
  if (!Number.isFinite(issuedAtMs)) throw new Error("now must be an ISO timestamp");
  const safeTtlMs = Math.max(1, Math.min(Number(ttlMs) || DEFAULT_PLUGIN_SURFACE_SESSION_TTL_MS, DEFAULT_PLUGIN_SURFACE_SESSION_TTL_MS));
  const payload = {
    schemaVersion: 1,
    sessionId: `pss_${crypto.randomUUID()}`,
    pluginId,
    action: PLUGIN_SURFACE_SESSION_ACTION,
    principalId,
    issuedAt: new Date(issuedAtMs).toISOString(),
    expiresAt: new Date(issuedAtMs + safeTtlMs).toISOString(),
  };
  const body = base64UrlEncode(JSON.stringify(payload));
  const signature = signBody(lucHome, body);
  return {
    ...payload,
    token: `${body}.${signature}`,
  };
}

export function verifyPluginSurfaceSession({
  lucHome,
  pluginId,
  token,
  now = new Date().toISOString(),
}: { lucHome?: string; pluginId?: string; token?: string; now?: string } = {}) {
  assertNonEmpty(lucHome, "lucHome");
  assertNonEmpty(pluginId, "pluginId");
  if (typeof token !== "string" || !token.trim()) {
    throw new PluginSurfaceSessionError("plugin surface session required", {
      code: "plugin_surface_session_required",
    });
  }
  const [body, signature, extra] = token.split(".");
  if (!body || !signature || extra !== undefined) {
    throw new PluginSurfaceSessionError("plugin surface session malformed");
  }
  const expected = signBody(lucHome, body);
  if (!timingSafeEqual(signature, expected)) {
    throw new PluginSurfaceSessionError("plugin surface session signature invalid");
  }

  let payload;
  try {
    payload = JSON.parse(base64UrlDecode(body));
  } catch {
    throw new PluginSurfaceSessionError("plugin surface session payload invalid");
  }
  if (payload?.schemaVersion !== 1 || payload.action !== PLUGIN_SURFACE_SESSION_ACTION) {
    throw new PluginSurfaceSessionError("plugin surface session action invalid");
  }
  if (payload.pluginId !== pluginId) {
    throw new PluginSurfaceSessionError("plugin surface session plugin mismatch");
  }
  const expiresAtMs = Date.parse(payload.expiresAt);
  const nowMs = Date.parse(now);
  if (!Number.isFinite(expiresAtMs) || !Number.isFinite(nowMs)) {
    throw new PluginSurfaceSessionError("plugin surface session timestamp invalid");
  }
  if (expiresAtMs <= nowMs) {
    throw new PluginSurfaceSessionError("plugin surface session expired", {
      code: "plugin_surface_session_expired",
    });
  }
  return Object.freeze({
    schemaVersion: 1,
    sessionId: payload.sessionId,
    pluginId: payload.pluginId,
    action: payload.action,
    principalId: payload.principalId,
    issuedAt: payload.issuedAt,
    expiresAt: payload.expiresAt,
  });
}

function pluginSurfaceSessionKeyPath(lucHome) {
  assertNonEmpty(lucHome, "lucHome");
  return path.join(securityDirPath(lucHome), PLUGIN_SURFACE_SESSION_KEY_FILE);
}

function signBody(lucHome, body) {
  return crypto
    .createHmac("sha256", readOrCreateSessionKey(lucHome))
    .update(body)
    .digest("base64url");
}

function readOrCreateSessionKey(lucHome) {
  const filePath = pluginSurfaceSessionKeyPath(lucHome);
  try {
    const existing = fs.readFileSync(filePath, "utf-8").trim();
    if (existing) return existing;
  } catch (err: any) {
    if (err.code !== "ENOENT") throw err;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const key = crypto.randomBytes(32).toString("base64url");
  atomicWriteSync(filePath, `${key}\n`, { mode: 0o600 });
  return key;
}

function base64UrlEncode(value) {
  return Buffer.from(value, "utf-8").toString("base64url");
}

function base64UrlDecode(value) {
  return Buffer.from(value, "base64url").toString("utf-8");
}

function timingSafeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function assertNonEmpty(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} required`);
  }
}
