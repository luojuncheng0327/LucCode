const { pathToFileUrl } = require("./path-to-file-url.cjs");

const EXPLICIT_PROTOCOL_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const SAFE_IMAGE_URL_PROTOCOLS = new Set(["http:", "https:", "file:", "data:"]);
const FRONT_MATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/"/g, "&quot;");
}

function normalizePathSeparators(value) {
  return String(value).replace(/\\/g, "/");
}

function dirnamePortable(filePath) {
  const normalized = normalizePathSeparators(filePath);
  const slash = normalized.lastIndexOf("/");
  if (slash < 0) return null;
  if (slash === 0) return "/";
  return normalized.slice(0, slash);
}

function isAbsoluteLocalPath(value) {
  return value.startsWith("/")
    || /^[A-Za-z]:[\\/]/.test(value)
    || value.startsWith("\\\\")
    || value.startsWith("//");
}

function normalizeJoinedPath(pathname) {
  const normalized = normalizePathSeparators(pathname);
  const prefixMatch = normalized.match(/^(?:[A-Za-z]:|\/\/[^/]+\/[^/]+|\/)?/);
  const prefix = prefixMatch?.[0] || "";
  const rest = normalized.slice(prefix.length);
  const parts = [];

  for (const part of rest.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length > 0 && parts[parts.length - 1] !== "..") {
        parts.pop();
      } else if (!prefix) {
        parts.push(part);
      }
      continue;
    }
    parts.push(part);
  }

  if (!prefix) return parts.join("/");
  if (prefix.endsWith("/")) return `${prefix}${parts.join("/")}`;
  return parts.length ? `${prefix}/${parts.join("/")}` : prefix;
}

function decodeMarkdownPath(rawPath) {
  try {
    return decodeURI(rawPath);
  } catch {
    return rawPath;
  }
}

function splitResourceSuffix(raw) {
  const hash = raw.indexOf("#");
  const query = raw.indexOf("?");
  const indexes = [hash, query].filter(index => index >= 0);
  const splitAt = indexes.length ? Math.min(...indexes) : -1;
  if (splitAt < 0) return { pathname: raw, suffix: "" };
  return { pathname: raw.slice(0, splitAt), suffix: raw.slice(splitAt) };
}

function sanitizeImageUrl(raw) {
  const value = String(raw || "").trim();
  if (!value || !EXPLICIT_PROTOCOL_RE.test(value)) return null;
  try {
    const parsed = new URL(value);
    return SAFE_IMAGE_URL_PROTOCOLS.has(parsed.protocol) ? value : null;
  } catch {
    return null;
  }
}

function resolveLocalImagePath(rawPath, sourceFilePath) {
  const decodedPath = decodeMarkdownPath(String(rawPath || "").trim());
  if (!decodedPath) return null;
  if (isAbsoluteLocalPath(decodedPath)) return normalizeJoinedPath(decodedPath);

  const baseDir = dirnamePortable(sourceFilePath);
  if (!baseDir) return null;
  return normalizeJoinedPath(`${baseDir}/${decodedPath}`);
}

function resolveScreenshotMarkdownImageSrc(src, options = {}) {
  const trimmed = String(src || "").trim();
  if (!trimmed) return src;

  const safeUrl = sanitizeImageUrl(trimmed);
  if (safeUrl) return safeUrl;
  if (EXPLICIT_PROTOCOL_RE.test(trimmed)) return "";
  if (!options.sourceFilePath) return src;

  const { pathname, suffix } = splitResourceSuffix(trimmed);
  const resolvedPath = resolveLocalImagePath(pathname, options.sourceFilePath);
  if (!resolvedPath) return src;
  return `${pathToFileUrl(resolvedPath)}${suffix}`;
}

function markdownTableScrollWrapper(md) {
  const defaultTableOpen = md.renderer.rules.table_open
    || ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
  const defaultTableClose = md.renderer.rules.table_close
    || ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));

  md.renderer.rules.table_open = (tokens, idx, options, env, self) => (
    `<div class="markdown-table-scroll">\n${defaultTableOpen(tokens, idx, options, env, self)}`
  );

  md.renderer.rules.table_close = (tokens, idx, options, env, self) => (
    `${defaultTableClose(tokens, idx, options, env, self)}</div>\n`
  );
}

function decorateScreenshotMarkdownIt(md) {
  markdownTableScrollWrapper(md);
  const defaultImage = md.renderer.rules.image
    || ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));

  md.renderer.rules.image = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const src = token.attrGet("src");
    if (src) {
      token.attrSet("src", resolveScreenshotMarkdownImageSrc(src, {
        sourceFilePath: env?.sourceFilePath || null,
      }));
    }
    return defaultImage(tokens, idx, options, env, self);
  };
}

function splitMarkdownFrontMatter(markdown) {
  const text = String(markdown || "");
  const match = text.match(FRONT_MATTER_RE);
  if (!match) return { frontMatter: "", body: text };
  return { frontMatter: match[1] || "", body: text.slice(match[0].length) };
}

function parseCoverScalar(value) {
  const trimmed = String(value || "").trim().replace(/^["']|["']$/g, "");
  if (!trimmed) return undefined;
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
    const number = Number(trimmed);
    if (Number.isFinite(number)) return number;
  }
  return trimmed;
}

function parseScreenshotMarkdownCover(markdown) {
  const { frontMatter } = splitMarkdownFrontMatter(markdown);
  if (!frontMatter) return null;
  const lines = frontMatter.split(/\r?\n/);
  const start = lines.findIndex(line => /^cover:\s*$/.test(line));
  if (start < 0) return null;
  const cover = {};
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() && !/^\s/.test(line)) break;
    const match = line.match(/^\s{2}([A-Za-z][A-Za-z0-9_]*):\s*(.*?)\s*$/);
    if (!match) continue;
    cover[match[1]] = parseCoverScalar(match[2]);
  }
  return typeof cover.image === "string" && cover.image.trim() ? cover : null;
}

function clampPercent(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(100, Math.max(0, number));
}

function clampHeight(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 320;
  return Math.min(720, Math.max(160, Math.round(number)));
}

function renderScreenshotMarkdownCover(cover, sourceFilePath) {
  if (!cover?.image) return "";
  const src = resolveScreenshotMarkdownImageSrc(cover.image, { sourceFilePath });
  if (!src) return "";
  const height = clampHeight(cover.displayHeight);
  const positionX = clampPercent(cover.positionX, 50);
  const positionY = clampPercent(cover.positionY, 50);
  return `<figure class="screenshot-cover screenshot-cover-bleed-x screenshot-cover-top" style="--screenshot-cover-height:${height}px"><div class="screenshot-cover-frame"><img src="${escapeAttr(src)}" style="object-position:${positionX}% ${positionY}%" /></div></figure>`;
}

function renderScreenshotMarkdownArticle(md, markdown, options = {}) {
  const parts = splitMarkdownFrontMatter(markdown);
  const cover = parseScreenshotMarkdownCover(markdown);
  const coverHTML = cover ? renderScreenshotMarkdownCover(cover, options.sourceFilePath || null) : "";
  return `${coverHTML}${md.render(parts.body, { sourceFilePath: options.sourceFilePath || null })}`;
}

function renderScreenshotCodeArticle(source, language) {
  const lang = typeof language === "string" && /^[A-Za-z0-9_+.-]+$/.test(language)
    ? ` class="language-${escapeAttr(language)}"`
    : "";
  return `<pre><code${lang}>${escapeHtml(source)}</code></pre>`;
}

module.exports = {
  decorateScreenshotMarkdownIt,
  escapeAttr,
  parseScreenshotMarkdownCover,
  renderScreenshotMarkdownArticle,
  renderScreenshotCodeArticle,
  resolveScreenshotMarkdownImageSrc,
};
