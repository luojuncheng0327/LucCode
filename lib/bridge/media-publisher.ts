import crypto from "node:crypto";
import fs from "fs";
import path from "path";
import { canonicalFilesystemPathSync, filesystemIdentityKeySync } from "../../shared/link-aware-fs.ts";

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_DOWNLOADS = 5;

export class MediaPublisher {
  declare baseUrl: string;
  declare allowedRoots: any[];
  declare ttlMs: number;
  declare maxDownloads: number;
  declare now: () => number;
  declare randomToken: () => string;
  declare _tokens: Map<string, any>;

  constructor({
    baseUrl = "",
    allowedRoots = [],
    ttlMs = DEFAULT_TTL_MS,
    maxDownloads = DEFAULT_MAX_DOWNLOADS,
    now = () => Date.now(),
    randomToken = () => crypto.randomBytes(32).toString("base64url"),
  } = {}) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.allowedRoots = normalizeAllowedRoots(allowedRoots);
    this.ttlMs = ttlMs;
    this.maxDownloads = normalizeMaxDownloads(maxDownloads);
    this.now = now;
    this.randomToken = randomToken;
    this._tokens = new Map();
  }

  setBaseUrl(baseUrl: any) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    return this.baseUrl;
  }

  setAllowedRoots(allowedRoots: any) {
    this.allowedRoots = normalizeAllowedRoots(allowedRoots);
    return this.allowedRoots;
  }

  publish(sessionFile: any) {
    if (!this.baseUrl) {
      throw new Error("public media base URL is not configured");
    }
    if (!sessionFile?.id && !sessionFile?.fileId) {
      throw new Error("session file id is required");
    }

    const requestedPath = sessionFile.realPath || sessionFile.filePath;
    if (!requestedPath) throw new Error("session file local path is required");

    const realPath = realFilePath(requestedPath);
    this._assertAllowed(realPath);

    const stat = fs.statSync(realPath);
    if (!stat.isFile()) throw new Error("session file media source is not a file");

    const token = this._uniqueToken();
    const expiresAt = this.now() + this.ttlMs;
    const filename = sessionFile.filename || sessionFile.label || path.basename(realPath);
    const entry = Object.freeze({
      token,
      fileId: sessionFile.id || sessionFile.fileId,
      filePath: sessionFile.filePath || realPath,
      realPath,
      filename,
      mime: sessionFile.mime || sessionFile.contentType || "application/octet-stream",
      size: Number.isFinite(sessionFile.size) ? sessionFile.size : stat.size,
      expiresAt,
    });
    this._tokens.set(token, { entry, downloads: 0 });

    return {
      token,
      publicUrl: `${this.baseUrl}/api/bridge/media/${encodeURIComponent(token)}`,
      expiresAt,
    };
  }

  resolve(token: any) {
    const record = this._tokens.get(token);
    if (!record) return null;
    const entry = record.entry;
    if (entry.expiresAt <= this.now()) {
      this._tokens.delete(token);
      return null;
    }
    if (record.downloads >= this.maxDownloads) {
      this._tokens.delete(token);
      return null;
    }
    try {
      const realPath = realFilePath(entry.realPath);
      if (realPath !== entry.realPath) return null;
      this._assertAllowed(realPath);
      const stat = fs.statSync(realPath);
      if (!stat.isFile()) return null;
    } catch {
      return null;
    }
    record.downloads += 1;
    return entry;
  }

  revoke(token: any) {
    return this._tokens.delete(token);
  }

  _assertAllowed(realPath: any) {
    if (!this.allowedRoots.length) {
      throw new Error("media file is outside allowed roots");
    }
    const targetKey = filesystemIdentityKeySync(realPath);
    const allowed = this.allowedRoots.some(root => isInsideRoot(targetKey, filesystemIdentityKeySync(root)));
    if (!allowed) throw new Error("media file is outside allowed roots");
  }

  _uniqueToken() {
    for (let i = 0; i < 5; i++) {
      const token = String(this.randomToken() || "");
      if (token && !this._tokens.has(token)) return token;
    }
    throw new Error("failed to generate unique media token");
  }
}

function normalizeBaseUrl(baseUrl: any) {
  const value = String(baseUrl || "").trim();
  if (!value) return "";
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("public media base URL must be http or https");
  }
  return value.replace(/\/+$/, "");
}

function normalizeAllowedRoots(roots: any) {
  return [...new Set((roots || []).filter(Boolean).map((root) => {
    // 存下来的是真实路径，用 canonical；折大小写只在比较时做。
    const realRoot = canonicalFilesystemPathSync(root);
    if (realRoot === path.parse(realRoot).root) {
      throw new Error(`media allowed root refuses filesystem root: ${root}`);
    }
    return realRoot;
  }))];
}

function normalizeMaxDownloads(maxDownloads: any) {
  const value = Number(maxDownloads);
  if (!Number.isFinite(value) || value < 1) return DEFAULT_MAX_DOWNLOADS;
  return Math.floor(value);
}

function realFilePath(filePath: any) {
  // "文件不在就抛" 是这里的契约：token 解析靠它判定源文件已经消失，
  // 所以先真实探一次，再交给共享原语做 native 归一。
  const resolved = path.resolve(filePath);
  fs.realpathSync(resolved);
  return canonicalFilesystemPathSync(resolved);
}

/** 两侧都必须是身份键。 */
function isInsideRoot(filePath: any, root: any) {
  if (filePath === root) return true;
  const relative = path.relative(root, filePath);
  return !!relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}
