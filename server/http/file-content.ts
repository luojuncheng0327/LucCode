import fs from "fs";
import path from "path";
import { Readable } from "stream";

const MIME_BY_EXT = new Map([
  [".txt", "text/plain; charset=utf-8"],
  [".md", "text/markdown; charset=utf-8"],
  [".markdown", "text/markdown; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".cjs", "text/javascript; charset=utf-8"],
  [".ts", "text/typescript; charset=utf-8"],
  [".tsx", "text/typescript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".avif", "image/avif"],
  [".ico", "image/x-icon"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
  [".ttf", "font/ttf"],
  [".otf", "font/otf"],
  [".wasm", "application/wasm"],
  [".mp4", "video/mp4"],
  [".webm", "video/webm"],
  [".mov", "video/quicktime"],
  [".pdf", "application/pdf"],
]);

export function serveFileContent(c, {
  filePath,
  filename = path.basename(filePath || ""),
  mime = guessMime(filename),
  etag = null,
  cacheControl = "private, max-age=0, must-revalidate",
  headOnly = false,
}) {
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) {
    return c.json({ error: "not_a_file" }, 400);
  }
  const size = stat.size;
  const resolvedEtag = etag || weakEtag(stat);
  if (c.req.header("if-none-match") && c.req.header("if-none-match") === resolvedEtag) {
    c.header("ETag", resolvedEtag);
    return c.body(null, 304);
  }

  const range = parseRangeHeader(c.req.header("range"), size);
  if (range?.unsatisfiable) {
    c.header("Content-Range", `bytes */${size}`);
    c.header("Accept-Ranges", "bytes");
    return c.body(null, 416);
  }

  const start = range ? range.start : 0;
  const end = range ? range.end : size - 1;
  const length = size === 0 ? 0 : end - start + 1;
  const status = range ? 206 : 200;

  c.header("Content-Type", mime || "application/octet-stream");
  c.header("Accept-Ranges", "bytes");
  c.header("Content-Length", String(length));
  c.header("Cache-Control", cacheControl);
  c.header("ETag", resolvedEtag);
  c.header("X-Luc-File-MtimeMs", String(stat.mtimeMs));
  c.header("X-Luc-File-Size", String(size));
  if (range) c.header("Content-Range", `bytes ${start}-${end}/${size}`);
  if (filename) c.header("Content-Disposition", contentDisposition(filename));
  if (headOnly || size === 0) return c.body(null, status);

  const stream = fs.createReadStream(filePath, { start, end });
  return c.body(Readable.toWeb(stream), status);
}

export function parseRangeHeader(value, size) {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match) return { unsatisfiable: true };

  let start;
  let end;
  if (match[1] === "" && match[2] === "") return { unsatisfiable: true };
  if (match[1] === "") {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return { unsatisfiable: true };
    start = Math.max(size - suffixLength, 0);
    end = Math.max(size - 1, 0);
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? size - 1 : Number(match[2]);
  }

  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return { unsatisfiable: true };
  if (size <= 0 || start >= size || start > end) return { unsatisfiable: true };
  return { start, end: Math.min(end, size - 1) };
}

export function contentDisposition(filename) {
  const fallback = asciiFilenameFallback(filename);
  return `inline; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export function guessMime(filename) {
  return MIME_BY_EXT.get(path.extname(String(filename || "")).toLowerCase()) || "application/octet-stream";
}

function weakEtag(stat) {
  return `W/"${stat.size}-${Math.floor(stat.mtimeMs)}"`;
}

function asciiFilenameFallback(filename) {
  const source = typeof filename === "string" ? filename : "";
  const dot = source.lastIndexOf(".");
  const ext = dot >= 0 ? source.slice(dot + 1) : "";
  const safeExt = /^[A-Za-z0-9]{1,12}$/.test(ext) ? `.${ext}` : "";
  const stem = source
    .slice(0, dot >= 0 ? dot : source.length)
    .replace(/[^\x20-\x7E]/g, "_")
    .replace(/["\\\r\n;/]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
  return /^[A-Za-z0-9._-]+$/.test(stem)
    ? `${stem}${safeExt}`
    : `download${safeExt}`;
}
