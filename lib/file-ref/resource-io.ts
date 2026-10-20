import fs from "fs";
import path from "path";
import { canonicalFilesystemPathSync, filesystemIdentityKeySync } from "../../shared/link-aware-fs.ts";
import { detectMime, extOfName, inferFileKind } from "../file-metadata.ts";

const DEFAULT_CONFLICT_POLICY = "fail";

type PathFileRef = { type: "path"; path: string };
type SessionFileRef = { type: "session_file"; fileId: string; sessionId?: string; sessionPath?: string };
type FileRef = PathFileRef | SessionFileRef;

// 目标还不存在时（copy 的落点），把已存在的那一段祖先解析掉再把剩下的接回去。
// 共享原语只认存在的路径，所以这个上溯逻辑留在本地，底层归一交给它。
function normalizePossiblyMissingPath(filePath) {
  const resolved = path.resolve(filePath);
  if (fs.existsSync(resolved)) return canonicalFilesystemPathSync(resolved);
  const parts = [];
  let cursor = resolved;
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    parts.unshift(path.basename(cursor));
    cursor = parent;
  }
  const base = canonicalFilesystemPathSync(cursor);
  return parts.length ? path.join(base, ...parts) : base;
}

/** 两侧都必须是身份键。 */
function isInsideRoot(filePath, root) {
  const rel = path.relative(root, filePath);
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

function normalizeRoot(root, cwd) {
  if (!root || typeof root !== "string") return null;
  const absolute = path.isAbsolute(root) ? root : path.resolve(cwd || process.cwd(), root);
  return canonicalFilesystemPathSync(absolute);
}

function allowedRootsFor(allowedRoots, cwd) {
  const roots = (Array.isArray(allowedRoots) ? allowedRoots : [])
    .map((root) => normalizeRoot(root, cwd))
    .filter(Boolean);
  if (!roots.length) return [];
  return roots;
}

function assertParentInsideAllowedRoots(targetPath, allowedRoots, cwd) {
  const roots = allowedRootsFor(allowedRoots, cwd);
  if (!roots.length) throw new Error("copy target has no allowed roots");
  const targetKey = filesystemIdentityKeySync(normalizePossiblyMissingPath(path.dirname(targetPath)));
  if (roots.some((root) => isInsideRoot(targetKey, filesystemIdentityKeySync(root)))) return;
  throw new Error(`copy target is outside allowed roots: ${targetPath}`);
}

function assertExistingPathInsideAllowedRoots(filePath, allowedRoots, cwd, label) {
  const roots = allowedRootsFor(allowedRoots, cwd);
  if (!roots.length) throw new Error(`${label} has no allowed roots`);
  const pathKey = filesystemIdentityKeySync(filePath);
  if (roots.some((root) => isInsideRoot(pathKey, filesystemIdentityKeySync(root)))) return;
  throw new Error(`${label} is outside allowed roots: ${filePath}`);
}

function readSample(filePath) {
  const fd = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(8192);
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    fs.closeSync(fd);
  }
}

function normalizeFileRef(ref): FileRef {
  if (!ref || typeof ref !== "object") throw new Error("FileRef is required");
  if (ref.type === "path") {
    if (!ref.path || typeof ref.path !== "string") throw new Error("path FileRef requires path");
    return { type: "path", path: ref.path };
  }
  if (ref.type === "session_file") {
    const fileId = ref.fileId || ref.id;
    if (!fileId || typeof fileId !== "string") throw new Error("session_file FileRef requires fileId");
    return {
      type: "session_file",
      fileId,
      ...(ref.sessionId ? { sessionId: ref.sessionId } : {}),
      ...(ref.sessionPath ? { sessionPath: ref.sessionPath } : {}),
    };
  }
  throw new Error(`unsupported FileRef type: ${ref.type || "unknown"}`);
}

function sessionFilePath(file, fileId) {
  if (!file || typeof file !== "object") throw new Error(`SessionFile not found: ${fileId}`);
  if (file.status === "expired") throw new Error(`SessionFile expired: ${fileId}`);
  const filePath = file.realPath || file.filePath || file.path || null;
  if (!filePath || !path.isAbsolute(filePath)) {
    throw new Error(`SessionFile has no readable absolute path: ${fileId}`);
  }
  return filePath;
}

function sourceFilename(source) {
  return source.filename || source.label || path.basename(source.filePath);
}

async function resolveFileRef(ref, {
  cwd = process.cwd(),
  resolveSessionFile,
  sessionId = null,
  sessionPath = null,
}: any = {}) {
  const normalized = normalizeFileRef(ref);
  if (normalized.type === "path") {
    const filePath = path.isAbsolute(normalized.path) ? normalized.path : path.resolve(cwd, normalized.path);
    return {
      ref: normalized,
      filePath,
      filename: path.basename(filePath),
      sourceFile: null,
    };
  }

  if (typeof resolveSessionFile !== "function") {
    throw new Error("SessionFile resolver unavailable");
  }
  const lookupSessionId = normalized.sessionId || sessionId || null;
  const lookupSessionPath = normalized.sessionPath || sessionPath || null;
  const file = resolveSessionFile(
    normalized.fileId,
    lookupSessionId ? { sessionId: lookupSessionId } : { sessionPath: lookupSessionPath },
  );
  const filePath = sessionFilePath(file, normalized.fileId);
  return {
    ref: normalized,
    filePath,
    filename: sourceFilename({ ...file, filePath }),
    sourceFile: file,
  };
}

function metadataForFile(filePath, overrides: any = {}) {
  const stat = fs.statSync(filePath);
  const filename = path.basename(filePath);
  const ext = extOfName(filename);
  const isDirectory = stat.isDirectory();
  const sample = isDirectory ? Buffer.alloc(0) : readSample(filePath);
  const mime = isDirectory
    ? "inode/directory"
    : detectMime(sample, "application/octet-stream", filename);
  return {
    filename,
    ext,
    mime,
    size: isDirectory ? null : stat.size,
    kind: inferFileKind({ mime, ext, isDirectory }),
    isDirectory,
    mtimeMs: stat.mtimeMs,
    ...overrides,
  };
}

export async function statFileRef(ref, deps: any = {}) {
  const resolved = await resolveFileRef(ref, deps);
  if (!fs.existsSync(resolved.filePath)) throw new Error(`file not found: ${resolved.filePath}`);
  const sourceFile = resolved.sourceFile || {};
  const meta = metadataForFile(resolved.filePath, {
    ...(sourceFile.mime ? { mime: sourceFile.mime } : {}),
    ...(sourceFile.kind ? { kind: sourceFile.kind } : {}),
    ...(sourceFile.size !== undefined ? { size: sourceFile.size } : {}),
  });
  return {
    type: resolved.ref.type,
    ...(resolved.ref.type === "session_file" ? { fileId: resolved.ref.fileId } : {}),
    ...(resolved.ref.type === "path" ? { path: resolved.filePath } : {}),
    filePath: resolved.filePath,
    filename: sourceFile.filename || resolved.filename || meta.filename,
    label: sourceFile.label || sourceFile.displayName || sourceFile.filename || resolved.filename || meta.filename,
    mime: meta.mime,
    kind: meta.kind,
    size: meta.size,
    mtimeMs: meta.mtimeMs,
    version: { mtimeMs: meta.mtimeMs, size: meta.size },
    isDirectory: meta.isDirectory,
    status: sourceFile.status || "available",
  };
}

/**
 * 所有"要拿到文件本体"的操作（复制源、抽取源）共用的前置：解析 FileRef、确认文件真实存在、
 * 对裸路径做授权根校验，并把 stat 一并交回调用方判断类型。
 *
 * 授权校验只保留这一份实现。新增读取入口一律走这里，不要在调用侧另写一条取文件路径，
 * 否则授权目录的约束会随着入口数量慢慢漏掉。
 */
export async function resolveReadableFileRef(ref, {
  cwd = process.cwd(),
  allowedRoots = null,
  label = "source",
  sessionId = null,
  sessionPath = null,
  resolveSessionFile,
}: any = {}) {
  const resolved = await resolveFileRef(ref, { cwd, resolveSessionFile, sessionId, sessionPath });
  if (!fs.existsSync(resolved.filePath)) throw new Error(`file not found: ${resolved.filePath}`);
  // SessionFile 的归属由 session 自己把关；只有用户直接给的裸路径需要在这里对齐授权目录。
  if (resolved.ref.type === "path" && Array.isArray(allowedRoots)) {
    assertExistingPathInsideAllowedRoots(resolved.filePath, allowedRoots, cwd, label);
  }
  return { ...resolved, stat: fs.statSync(resolved.filePath) };
}

function resolveTargetPath({ targetPath, targetDir, filename, cwd, sourceFilename: fallbackFilename }) {
  if (targetPath && targetDir) throw new Error("Pass either targetPath or targetDir, not both");
  if (targetPath) {
    const raw = path.isAbsolute(targetPath) ? targetPath : path.resolve(cwd, targetPath);
    return raw;
  }
  if (!targetDir) throw new Error("copy requires targetPath or targetDir");
  const dir = path.isAbsolute(targetDir) ? targetDir : path.resolve(cwd, targetDir);
  return path.join(dir, filename || fallbackFilename);
}

function resolveConflictPath(targetPath, conflictPolicy) {
  const policy = conflictPolicy || DEFAULT_CONFLICT_POLICY;
  if (!fs.existsSync(targetPath)) return targetPath;
  if (policy === "overwrite") return targetPath;
  if (policy !== "rename") throw new Error(`copy target already exists: ${targetPath}`);

  const dir = path.dirname(targetPath);
  const ext = path.extname(targetPath);
  const base = path.basename(targetPath, ext);
  for (let i = 2; i < 10_000; i++) {
    const candidate = path.join(dir, `${base}-${i}${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`could not find available filename for: ${targetPath}`);
}

export async function copyFileRefToPath({
  from,
  targetPath = null,
  targetDir = null,
  filename = null,
  conflictPolicy = DEFAULT_CONFLICT_POLICY,
  cwd = process.cwd(),
  allowedRoots = [],
  sourceAllowedRoots = null,
  sessionId = null,
  sessionPath = null,
  resolveSessionFile,
  registerSessionFile,
}: any = {}) {
  const resolved = await resolveReadableFileRef(from, {
    cwd,
    allowedRoots: sourceAllowedRoots,
    label: "copy source",
    sessionId,
    sessionPath,
    resolveSessionFile,
  });
  if (resolved.stat.isDirectory()) {
    throw new Error("copying directory FileRefs is not supported in v0");
  }

  const rawTargetPath = resolveTargetPath({
    targetPath,
    targetDir,
    filename,
    cwd,
    sourceFilename: resolved.filename,
  });
  assertParentInsideAllowedRoots(rawTargetPath, allowedRoots, cwd);
  const finalTargetPath = resolveConflictPath(rawTargetPath, conflictPolicy);
  if (fs.existsSync(finalTargetPath)) {
    assertExistingPathInsideAllowedRoots(finalTargetPath, allowedRoots, cwd, "copy target");
  }
  fs.mkdirSync(path.dirname(finalTargetPath), { recursive: true });
  fs.copyFileSync(resolved.filePath, finalTargetPath);

  const label = path.basename(finalTargetPath);
  const registered = typeof registerSessionFile === "function" && sessionPath
    ? registerSessionFile({
      sessionPath,
      ...(sessionId ? { sessionId } : {}),
      filePath: finalTargetPath,
      label,
      origin: "session_file_copy",
      operation: "copied",
      storageKind: "external",
    })
    : null;

  return {
    filePath: finalTargetPath,
    filename: label,
    source: {
      type: resolved.ref.type,
      ...(resolved.ref.type === "session_file" ? { fileId: resolved.ref.fileId } : {}),
      filePath: resolved.filePath,
    },
    ...(registered ? { sessionFile: registered } : {}),
  };
}
