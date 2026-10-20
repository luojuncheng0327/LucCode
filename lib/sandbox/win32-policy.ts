import fs from "fs";
import path from "path";
import { canonicalFilesystemPathSync, filesystemIdentityKeySync } from "../../shared/link-aware-fs.ts";

const EXTERNAL_READ_STORAGE_KINDS = new Set(["external", "install_source"]);

// 这个模块产出的路径会被 Windows 沙盒 helper 当成授权目标使用，
// 一律保持 canonical（不折大小写）；折大小写只在包含判定里做。
function normalizeExistingOrResolved(p) {
  if (!p) return null;
  return canonicalFilesystemPathSync(p);
}

// 保留本地实现：共享原语没有"路径不存在就整条丢掉"这一档，
// 而可选写授权和保护路径必须把不存在的条目剔干净。
function normalizeExisting(p) {
  if (!p) return null;
  try {
    fs.realpathSync(p);
  } catch (err) {
    return err?.code === "ENOENT" ? null : path.resolve(p);
  }
  return canonicalFilesystemPathSync(p);
}

function uniqueNormalized(paths) {
  return uniqueByIdentity(paths, normalizeExistingOrResolved);
}

function uniqueExistingNormalized(paths) {
  return uniqueByIdentity(paths, normalizeExisting);
}

function uniqueByIdentity(paths, normalize) {
  const out = [];
  const seen = new Set();
  for (const raw of paths || []) {
    const normalized = normalize(raw);
    if (!normalized) continue;
    const key = filesystemIdentityKeySync(normalized);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

/** 两侧都必须已经是身份键。 */
function isInside(target, root) {
  if (!target || !root) return false;
  const rel = path.relative(root, target);
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

function isInsideAnyKey(targetKey, rootKeys) {
  return rootKeys.some((root) => isInside(targetKey, root));
}

function identityKeys(paths) {
  return paths.map((p) => filesystemIdentityKeySync(p));
}

function basenameForPlatformPath(target) {
  const raw = String(target || "");
  return /^[a-z]:[\\/]|^\\\\/i.test(raw) ? path.win32.basename(raw) : path.basename(raw);
}

export function externalReadPathsFromSessionFiles(files = [], { workspaceRoots = [], lucHome }: { workspaceRoots?: any[]; lucHome?: any } = {}) {
  const workspaceRootKeys = identityKeys(uniqueNormalized(workspaceRoots));
  const homeKey = lucHome ? filesystemIdentityKeySync(lucHome) : null;
  const out = [];

  for (const file of files || []) {
    if (!file || file.status === "missing" || file.status === "expired") continue;
    if (!EXTERNAL_READ_STORAGE_KINDS.has(file.storageKind || "external")) continue;
    const target = normalizeExistingOrResolved(file.realPath || file.filePath);
    if (!target) continue;
    const targetKey = filesystemIdentityKeySync(target);
    if (homeKey && isInside(targetKey, homeKey)) continue;
    if (isInsideAnyKey(targetKey, workspaceRootKeys)) continue;
    out.push(target);
  }

  return uniqueNormalized(out);
}

export function buildWin32SandboxGrants({
  policy,
}: { policy?: any; cwd?: any } = {}) {
  if (!policy || policy.mode === "full-access") {
    return { readPaths: [], optionalReadPaths: [], writePaths: [], optionalWritePaths: [], denyReadPaths: [], denyWritePaths: [] };
  }

  const workspaceRoots = uniqueNormalized(policy.workspaceRoots || [policy.workspace].filter(Boolean));
  const workspaceRootKeys = identityKeys(workspaceRoots);
  const isWorkspaceGitDir = (target) =>
    basenameForPlatformPath(target) === ".git"
    && isInsideAnyKey(filesystemIdentityKeySync(target), workspaceRootKeys);

  // `cwd` only selects where the child process starts. Write authority comes
  // from the session policy (workspace roots / explicitly authorized folders),
  // never from a per-command working-directory override.
  const writePaths = workspaceRoots;
  const optionalWritePaths = uniqueExistingNormalized(policy.writablePaths || [])
    .filter((p) => !isInsideAnyKey(filesystemIdentityKeySync(p), workspaceRootKeys));
  const writeGrantRootKeys = [...workspaceRootKeys, ...identityKeys(optionalWritePaths)];
  const denyWritePaths = uniqueExistingNormalized(policy.protectedPaths || [])
    .filter((p) => isInsideAnyKey(filesystemIdentityKeySync(p), writeGrantRootKeys));
  const functionalityFirstDenyWritePaths = denyWritePaths
    .filter((p) => !isWorkspaceGitDir(p));

  return {
    readPaths: [],
    optionalReadPaths: [],
    writePaths,
    optionalWritePaths,
    denyReadPaths: [],
    denyWritePaths: functionalityFirstDenyWritePaths,
  };
}
