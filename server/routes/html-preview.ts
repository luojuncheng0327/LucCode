import crypto from "crypto";
import fs from "fs";
import path from "path";
import { Hono } from "hono";
import { guessMime } from "../http/file-content.ts";

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_CONTENT_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_ASSET_BYTES = 50 * 1024 * 1024;

export const HTML_PREVIEW_CSP = buildHtmlPreviewCsp();

export function createHtmlPreviewRoute({
  ttlMs = DEFAULT_TTL_MS,
  maxContentBytes = DEFAULT_MAX_CONTENT_BYTES,
  maxAssetBytes = DEFAULT_MAX_ASSET_BYTES,
  now = () => Date.now(),
  randomId = () => `pv_${crypto.randomBytes(16).toString("hex")}`,
  randomToken = () => crypto.randomBytes(32).toString("base64url"),
} = {}) {
  const route = new Hono();
  const previews = new Map();

  route.post("/api/preview/html", async (c) => {
    cleanupExpired(previews, now());

    let body;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }

    const content = typeof body?.content === "string" ? body.content : null;
    if (content === null) return c.json({ error: "missing_content" }, 400);
    if (Buffer.byteLength(content, "utf-8") > maxContentBytes) {
      return c.json({ error: "html_preview_too_large" }, 413);
    }

    const id = randomId();
    const token = randomToken();
    const assetScope = resolvePreviewAssetScope(body?.sourceFilePath, body?.sourceRootPath);
    const requestUrl = new URL(c.req.url);
    const assetRootUrl = assetScope
      ? buildPreviewAssetUrl(requestUrl.origin, id, token, "", { trailingSlash: true })
      : null;
    const assetBaseUrl = assetScope
      ? buildPreviewAssetUrl(requestUrl.origin, id, token, assetScope.sourceRelativeDir, { trailingSlash: true })
      : null;
    const servedContent = assetScope && assetBaseUrl
      ? injectAssetBase(
        rewriteLocalAssetReferences(content, {
          assetRoot: assetScope.assetRoot,
          requestOrigin: requestUrl.origin,
          id,
          token,
        }),
        assetBaseUrl,
      )
      : content;
    const expiresAt = now() + ttlMs;
    previews.set(id, {
      token,
      content: servedContent,
      title: typeof body?.title === "string" ? body.title.slice(0, 240) : "",
      assetRoot: assetScope?.assetRoot || null,
      csp: buildHtmlPreviewCsp(assetRootUrl),
      expiresAt,
    });

    const previewUrl = new URL(`/preview/html/${encodeURIComponent(id)}`, requestUrl.origin);
    previewUrl.searchParams.set("previewToken", token);

    return c.json({
      id,
      previewUrl: previewUrl.toString(),
      expiresAt,
    });
  });

  route.get("/preview/html/:id", (c) => servePreview(c, previews, now()));
  route.on("HEAD", "/preview/html/:id", (c) => servePreview(c, previews, now(), true));
  route.get("/preview/html/:id/assets/:token/*", (c) => servePreviewAsset(c, previews, now(), maxAssetBytes));
  route.on("HEAD", "/preview/html/:id/assets/:token/*", (c) => servePreviewAsset(c, previews, now(), maxAssetBytes, true));

  return route;
}

function servePreview(c, previews, currentTime, headOnly = false) {
  cleanupExpired(previews, currentTime);

  const id = c.req.param("id");
  const token = c.req.query("previewToken") || "";
  const preview = previews.get(id);
  if (!preview || preview.token !== token) {
    return c.body(null, 404);
  }

  c.header("Content-Type", "text/html; charset=utf-8");
  c.header("Content-Security-Policy", preview.csp || HTML_PREVIEW_CSP);
  c.header("Referrer-Policy", "no-referrer");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Cache-Control", "no-store");
  c.header("Cross-Origin-Resource-Policy", "cross-origin");

  return c.body(headOnly ? null : preview.content);
}

function servePreviewAsset(c, previews, currentTime, maxAssetBytes, headOnly = false) {
  cleanupExpired(previews, currentTime);

  const id = c.req.param("id");
  const token = c.req.param("token") || "";
  const preview = previews.get(id);
  if (!preview || preview.token !== token || !preview.assetRoot) {
    return c.body(null, 404);
  }

  const relativePath = extractAssetPath(c.req.path, id, token);
  const assetPath = resolveAssetPath(preview.assetRoot, relativePath);
  if (!assetPath) return c.body(null, 404);

  const stat = fs.statSync(assetPath);
  if (!stat.isFile() || stat.size > maxAssetBytes) return c.body(null, 404);

  c.header("Content-Type", guessMime(assetPath));
  c.header("Cache-Control", "no-store");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Cross-Origin-Resource-Policy", "same-origin");
  return c.body(headOnly ? null : fs.readFileSync(assetPath));
}

function cleanupExpired(previews, currentTime) {
  for (const [id, preview] of previews.entries()) {
    if (preview.expiresAt <= currentTime) previews.delete(id);
  }
}

function buildHtmlPreviewCsp(assetBaseUrl = null) {
  const assetSource = cspSourceFromAssetBase(assetBaseUrl);
  const baseSources = assetSource ? [assetSource] : ["'self'"];
  const scriptSources = ["'unsafe-inline'", "https:"];
  const styleSources = ["'unsafe-inline'", "https:"];
  const fontSources = ["https:", "data:"];
  const imageSources = assetSource ? [assetSource, "https:", "data:", "blob:"] : ["'self'", "https:", "data:", "blob:"];
  const mediaSources = assetSource ? [assetSource, "https:", "data:", "blob:"] : ["'self'", "https:", "data:", "blob:"];

  if (assetSource) {
    scriptSources.push(assetSource);
    styleSources.push(assetSource);
    fontSources.push(assetSource);
  }

  return [
    "default-src 'none'",
    `base-uri ${baseSources.join(" ")}`,
    "form-action 'none'",
    "object-src 'none'",
    "connect-src 'none'",
    `script-src ${scriptSources.join(" ")}`,
    `style-src ${styleSources.join(" ")}`,
    `font-src ${fontSources.join(" ")}`,
    `img-src ${imageSources.join(" ")}`,
    `media-src ${mediaSources.join(" ")}`,
    "frame-ancestors 'self' file: http://127.0.0.1:* http://localhost:*",
  ].join("; ");
}

function cspSourceFromAssetBase(assetBaseUrl) {
  if (!assetBaseUrl) return null;
  try {
    const url = new URL(assetBaseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.search = "";
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

function resolvePreviewAssetScope(sourceFilePath, sourceRootPath) {
  if (typeof sourceFilePath !== "string" || !path.isAbsolute(sourceFilePath)) return null;
  try {
    const stat = fs.statSync(sourceFilePath);
    if (!stat.isFile()) return null;
    const sourceDir = fs.realpathSync(path.dirname(sourceFilePath));
    const requestedRoot = resolveRequestedAssetRoot(sourceRootPath);
    const assetRoot = requestedRoot && isInsideRoot(sourceDir, requestedRoot)
      ? requestedRoot
      : sourceDir;
    return {
      assetRoot,
      sourceDir,
      sourceRelativeDir: toAssetRoutePath(path.relative(assetRoot, sourceDir)),
    };
  } catch {
    return null;
  }
}

function resolveRequestedAssetRoot(sourceRootPath) {
  if (typeof sourceRootPath !== "string" || !path.isAbsolute(sourceRootPath)) return null;
  try {
    const stat = fs.statSync(sourceRootPath);
    if (!stat.isDirectory()) return null;
    return fs.realpathSync(sourceRootPath);
  } catch {
    return null;
  }
}

function escapeHtmlAttr(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function injectAssetBase(content, assetBaseUrl) {
  const baseTag = `<base href="${escapeHtmlAttr(assetBaseUrl)}">`;
  if (/<head\b[^>]*>/i.test(content)) {
    return content.replace(/<head\b[^>]*>/i, (match) => `${match}${baseTag}`);
  }
  return `${baseTag}${content}`;
}

function encodeAssetRoutePath(relativePath) {
  return toAssetRoutePath(relativePath)
    .split("/")
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function toAssetRoutePath(filePath) {
  const normalized = String(filePath || "").split(path.sep).join("/");
  return normalized === "." ? "" : normalized.replace(/^\/+|\/+$/g, "");
}

function buildPreviewAssetUrl(origin, id, token, relativePath, { trailingSlash = false } = {}) {
  const encodedRelative = encodeAssetRoutePath(relativePath);
  const suffix = encodedRelative ? `/${encodedRelative}` : "";
  const url = new URL(
    `/preview/html/${encodeURIComponent(id)}/assets/${encodeURIComponent(token)}${suffix}${trailingSlash ? "/" : ""}`,
    origin,
  );
  return url.toString();
}

function rewriteLocalAssetReferences(content, scope) {
  return String(content || "").replace(
    /\b(src|href|poster)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi,
    (match, attrName, rawValue, doubleQuoted, singleQuoted, unquoted) => {
      const value = doubleQuoted ?? singleQuoted ?? unquoted ?? "";
      const rewritten = rewriteLocalAssetUrl(value, scope);
      if (!rewritten || rewritten === value) return match;
      if (doubleQuoted !== undefined) return `${attrName}="${escapeHtmlAttr(rewritten)}"`;
      if (singleQuoted !== undefined) return `${attrName}='${escapeHtmlAttr(rewritten)}'`;
      return `${attrName}=${escapeUnquotedAttr(rewritten)}`;
    },
  );
}

function escapeUnquotedAttr(value) {
  return escapeHtmlAttr(value).replace(/`/g, "&#96;").replace(/\s/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

function rewriteLocalAssetUrl(rawValue, scope) {
  const resolved = resolveLocalAssetReference(rawValue, scope.assetRoot);
  if (!resolved) return null;
  const relativePath = path.relative(scope.assetRoot, resolved.filePath);
  const assetUrl = buildPreviewAssetUrl(scope.requestOrigin, scope.id, scope.token, relativePath);
  return `${assetUrl}${resolved.suffix}`;
}

function resolveLocalAssetReference(rawValue, assetRoot) {
  const value = String(rawValue || "").trim();
  if (!value || value.startsWith("#") || value.startsWith("//")) return null;
  if (/^(?:https?|data|blob|mailto|tel):/i.test(value)) return null;

  if (/^file:/i.test(value)) {
    const file = fileUrlToPathAndSuffix(value);
    if (!file) return null;
    const filePath = resolveAssetFileForLocalPath(assetRoot, file.filePath);
    return filePath ? { filePath, suffix: file.suffix } : null;
  }

  const { pathname, suffix } = splitReferenceSuffix(value);
  const decodedPathname = decodePathname(pathname);
  if (!isAbsoluteLocalPath(decodedPathname)) return null;

  const filePath = resolveAssetFileForLocalPath(assetRoot, decodedPathname);
  return filePath ? { filePath, suffix } : null;
}

function splitReferenceSuffix(value) {
  const hash = value.indexOf("#");
  const query = value.indexOf("?");
  const indexes = [hash, query].filter((index) => index >= 0);
  const splitAt = indexes.length ? Math.min(...indexes) : -1;
  if (splitAt < 0) return { pathname: value, suffix: "" };
  return { pathname: value.slice(0, splitAt), suffix: value.slice(splitAt) };
}

function fileUrlToPathAndSuffix(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "file:") return null;
    const decodedPath = decodeURIComponent(url.pathname);
    const filePath = url.host
      ? `//${url.host}${decodedPath}`
      : decodedPath.replace(/^\/([A-Za-z]:\/)/, "$1");
    return { filePath, suffix: `${url.search || ""}${url.hash || ""}` };
  } catch {
    return null;
  }
}

function decodePathname(value) {
  try {
    return decodeURI(value);
  } catch {
    return value;
  }
}

function isAbsoluteLocalPath(value) {
  return path.isAbsolute(value) || path.win32.isAbsolute(value) || value.startsWith("//");
}

function resolveAssetFileForLocalPath(assetRoot, filePath) {
  const candidate = path.resolve(filePath);
  try {
    const stat = fs.lstatSync(candidate);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    const realPath = fs.realpathSync(candidate);
    if (!isInsideRoot(realPath, assetRoot)) return null;
    return realPath;
  } catch {
    return null;
  }
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractAssetPath(requestPath, id, token) {
  const prefix = new RegExp(`^/preview/html/${escapeRegExp(id)}/assets/${escapeRegExp(token)}/?`);
  const raw = String(requestPath || "").replace(prefix, "");
  try {
    return decodeURIComponent(raw);
  } catch {
    return "";
  }
}

function isInsideRoot(candidatePath, rootPath) {
  const candidate = path.resolve(candidatePath);
  const root = path.resolve(rootPath);
  return candidate === root || candidate.startsWith(root + path.sep);
}

function resolveAssetPath(sourceDir, relativePath) {
  if (!relativePath || relativePath.includes("\0") || relativePath.includes("\\")) return null;
  if (path.isAbsolute(relativePath)) return null;
  const parts = relativePath.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return null;

  const candidate = path.resolve(sourceDir, relativePath);
  if (!isInsideRoot(candidate, sourceDir)) return null;

  try {
    const stat = fs.lstatSync(candidate);
    if (stat.isSymbolicLink()) return null;
    const realPath = fs.realpathSync(candidate);
    if (!isInsideRoot(realPath, sourceDir)) return null;
    return realPath;
  } catch {
    return null;
  }
}
