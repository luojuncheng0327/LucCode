import fs from "fs";
import path from "path";
import { parseCookie } from "../../core/web-session-store.ts";
import {
  PluginAssetSessionError,
  pluginAssetSessionCookieName,
  verifyPluginAssetSession,
} from "../../core/plugin-asset-session-service.ts";
import { serveFileContent } from "./file-content.ts";

const ALLOWED_PLUGIN_ASSET_EXTENSIONS = new Set([
  ".js",
  ".mjs",
  ".css",
  ".json",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".avif",
  ".svg",
  ".ico",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".wasm",
  ".mp4",
  ".webm",
  ".mov",
]);

class PluginAssetNotFoundError extends Error {
  constructor(message = "plugin asset not found") {
    super(message);
    this.name = "PluginAssetNotFoundError";
  }
}

export function isPluginAssetRequest(pathname) {
  return !!parsePluginAssetRoute(pathname, { validateAssetPath: false });
}

export function isMalformedPluginAssetRequest(rawUrl, normalizedPathname) {
  return isRawPluginAssetRequest(rawUrl) && !isPluginAssetRequest(normalizedPathname);
}

export function verifyPluginAssetSessionForHostRequest(c, engine, { requireSession = true } = {}) {
  const parsed = parsePluginAssetRoute(new URL(c.req.url).pathname, { validateAssetPath: false });
  if (!parsed) {
    if (!requireSession) return null;
    throw new PluginAssetSessionError("plugin asset route invalid", {
      code: "plugin_asset_route_invalid",
    });
  }
  const token = parseCookie(c.req.header("cookie"), pluginAssetSessionCookieName(parsed.pluginId));
  if (!token) {
    if (!requireSession) return null;
    throw new PluginAssetSessionError("plugin asset session required", {
      code: "plugin_asset_session_required",
    });
  }
  return verifyPluginAssetSession({
    lucHome: engine.luccodeHome,
    pluginId: parsed.pluginId,
    token,
  });
}

export function servePluginAsset(c, engine, headOnly = false) {
  let parsed;
  try {
    parsed = parsePluginAssetRoute(new URL(c.req.url).pathname, { validateAssetPath: true });
  } catch (err) {
    if (err instanceof PluginAssetNotFoundError) return notFound(c);
    throw err;
  }
  if (!parsed) return notFound(c);

  const plugin = getLoadedPluginEntry(engine, parsed.pluginId);
  if (!plugin?.pluginDir) return notFound(c);

  let filePath;
  try {
    filePath = resolvePluginAssetFile(plugin.pluginDir, parsed.assetPath);
  } catch (err) {
    if (err instanceof PluginAssetNotFoundError) return notFound(c);
    throw err;
  }

  c.header("X-Content-Type-Options", "nosniff");
  c.header("Cross-Origin-Resource-Policy", "same-origin");
  return serveFileContent(c, {
    filePath,
    cacheControl: "public, max-age=31536000, immutable",
    headOnly,
  });
}

function parsePluginAssetRoute(pathname, { validateAssetPath }) {
  const routePath = normalizePathname(pathname);
  const match = /^\/api\/plugins\/([^/]+)\/assets(?:\/(.*))?$/.exec(routePath);
  if (!match) return null;
  const pluginId = decodeRouteComponent(match[1]);
  if (!isSafePluginId(pluginId)) {
    if (validateAssetPath) throw new PluginAssetNotFoundError();
    return null;
  }
  const rawAssetPath = match[2] || "";
  if (!validateAssetPath) {
    return { pluginId, assetPath: rawAssetPath };
  }
  return {
    pluginId,
    assetPath: normalizePluginAssetPath(rawAssetPath),
  };
}

function isRawPluginAssetRequest(rawUrl) {
  return /^\/api\/plugins\/[^/]+\/assets(?:\/|$)/.test(rawPathname(rawUrl));
}

function normalizePathname(value) {
  try {
    return new URL(String(value || ""), "http://luc.local").pathname;
  } catch {
    return String(value || "").split("?")[0] || "/";
  }
}

function rawPathname(value) {
  const raw = String(value || "");
  const absoluteMatch = /^[a-z][a-z0-9+.-]*:\/\//i.exec(raw);
  const absolutePathStart = absoluteMatch ? raw.indexOf("/", absoluteMatch[0].length) : -1;
  const pathAndQuery = absoluteMatch
    ? (absolutePathStart >= 0 ? raw.slice(absolutePathStart) : "/")
    : raw;
  const queryIndex = pathAndQuery.search(/[?#]/);
  return (queryIndex >= 0 ? pathAndQuery.slice(0, queryIndex) : pathAndQuery) || "/";
}

function normalizePluginAssetPath(rawAssetPath) {
  if (typeof rawAssetPath !== "string" || rawAssetPath.length === 0) {
    throw new PluginAssetNotFoundError();
  }
  if (rawAssetPath.includes("\\") || rawAssetPath.includes("\0")) {
    throw new PluginAssetNotFoundError();
  }
  const decoded = decodeRouteComponent(rawAssetPath);
  if (!decoded || decoded.includes("\\") || decoded.includes("\0") || decoded.startsWith("/")) {
    throw new PluginAssetNotFoundError();
  }
  const segments = decoded.split("/");
  if (segments.some((segment) => !isSafeAssetSegment(segment))) {
    throw new PluginAssetNotFoundError();
  }
  const ext = path.extname(segments[segments.length - 1] || "").toLowerCase();
  if (ext === ".map" || !ALLOWED_PLUGIN_ASSET_EXTENSIONS.has(ext)) {
    throw new PluginAssetNotFoundError();
  }
  return segments.join("/");
}

function isSafeAssetSegment(segment) {
  return typeof segment === "string"
    && segment.length > 0
    && segment !== "."
    && segment !== ".."
    && !segment.startsWith(".");
}

function isSafePluginId(pluginId) {
  return typeof pluginId === "string"
    && pluginId.length > 0
    && !pluginId.includes("/")
    && !pluginId.includes("\\")
    && !pluginId.includes("\0");
}

function decodeRouteComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new PluginAssetNotFoundError();
  }
}

function getLoadedPluginEntry(engine, pluginId) {
  const pm = engine?.pluginManager;
  if (!pm) return null;
  const entry = typeof pm.getPlugin === "function"
    ? pm.getPlugin(pluginId)
    : null;
  const fallback = !entry && typeof pm.listPlugins === "function"
    ? pm.listPlugins().find((plugin) => plugin?.id === pluginId)
    : null;
  const plugin = entry || fallback;
  if (!plugin || plugin.status !== "loaded") return null;
  return plugin;
}

function resolvePluginAssetFile(pluginDir, assetPath) {
  const assetRoot = path.join(pluginDir, "assets");
  let rootReal;
  try {
    rootReal = fs.realpathSync(assetRoot);
  } catch {
    throw new PluginAssetNotFoundError();
  }
  const targetPath = path.join(rootReal, assetPath);
  let targetReal;
  let stat;
  try {
    targetReal = fs.realpathSync(targetPath);
    stat = fs.statSync(targetReal);
  } catch {
    throw new PluginAssetNotFoundError();
  }
  const relative = path.relative(rootReal, targetReal);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || !stat.isFile()) {
    throw new PluginAssetNotFoundError();
  }
  return targetReal;
}

function notFound(c) {
  return c.json({ error: "plugin_asset_not_found" }, 404);
}
