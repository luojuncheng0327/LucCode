import fs from "fs";
import path from "path";
import { canonicalFilesystemPathSync, filesystemIdentityKeySync } from "../../shared/link-aware-fs.ts";
import { createManagedConfigWriteGuard } from "../sandbox/managed-config-guard.ts";
import { PathGuard } from "../sandbox/path-guard.ts";
import { deriveSandboxPolicy } from "../sandbox/policy.ts";

type Operation = "read" | "write" | "delete";

export type ResourceAccessAllowed = {
  allowed: true;
};

export type ResourceAccessDenied = {
  allowed: false;
  code:
    | "path_outside_authorized_roots"
    | "protected_metadata"
    | "managed_config_denied"
    | "invalid_resource_path"
    | "sandbox_denied";
  reason: string;
  safeMessage: string;
};

export type ResourceAccessDecision = ResourceAccessAllowed | ResourceAccessDenied;

type Options = {
  cwd: string;
  agentDir: string;
  workspace?: string | null;
  workspaceFolders?: string[];
  lucHome: string;
  getAuthorizedFolders?: () => string[];
  getSandboxEnabled?: () => boolean;
  getExternalReadPaths?: () => string[];
};

export class ResourceAccessPolicy {
  declare cwd: string;
  declare agentDir: string;
  declare workspace: string | null;
  declare workspaceFolders: string[];
  declare luccodeHome: string;
  declare getAuthorizedFolders: () => string[];
  declare getSandboxEnabled: () => boolean;
  declare getExternalReadPaths?: () => string[];
  declare checkManagedConfigWrite: (absolutePath: string, operation: Operation) => { allowed: boolean; reason?: string };

  constructor({
    cwd,
    agentDir,
    workspace = null,
    workspaceFolders = [],
    lucHome,
    getAuthorizedFolders = () => [],
    getSandboxEnabled = () => false,
    getExternalReadPaths,
  }: Options) {
    this.cwd = cwd;
    this.agentDir = agentDir;
    this.workspace = workspace;
    this.workspaceFolders = Array.isArray(workspaceFolders) ? workspaceFolders : [];
    this.luccodeHome = lucHome;
    this.getAuthorizedFolders = getAuthorizedFolders;
    this.getSandboxEnabled = getSandboxEnabled;
    this.getExternalReadPaths = getExternalReadPaths;
    this.checkManagedConfigWrite = createManagedConfigWriteGuard({ lucHome });
  }

  check(absolutePath: string, operation: Operation): ResourceAccessDecision {
    if (!absolutePath || typeof absolutePath !== "string" || absolutePath.includes("\0")) {
      return denied("invalid_resource_path");
    }
    if (isProtectedMetadataPath(absolutePath, this.protectedRoots())) {
      return denied("protected_metadata");
    }
    const managedConfigCheck = this.checkManagedConfigWrite(absolutePath, operation);
    if (!managedConfigCheck.allowed) return denied("managed_config_denied");
    if (!this.getSandboxEnabled()) return { allowed: true };
    const result = new PathGuard(this.makeSandboxPolicy()).check(absolutePath, operation);
    if (result.allowed) return { allowed: true };
    if (operation === "read" && this.hasExternalReadGrant(absolutePath)) {
      return { allowed: true };
    }
    return denied(codeForSandboxDenial(absolutePath, operation, this.protectedRoots()));
  }

  makeSandboxPolicy() {
    return deriveSandboxPolicy({
      agentDir: this.agentDir,
      cwd: this.cwd,
      workspace: this.workspace,
      workspaceFolders: [
        ...this.workspaceFolders,
        ...this.resolveAuthorizedFolders(),
      ],
      lucHome: this.luccodeHome,
      mode: "standard",
    });
  }

  resolveAuthorizedFolders() {
    try {
      const folders = this.getAuthorizedFolders();
      return Array.isArray(folders) ? folders : [];
    } catch {
      return [];
    }
  }

  hasExternalReadGrant(absolutePath: string) {
    if (!absolutePath || typeof this.getExternalReadPaths !== "function") return false;
    try {
      const grants = this.getExternalReadPaths() || [];
      return Array.isArray(grants) && grants.some((grantPath) => (
        grantPath && externalReadGrantCovers(absolutePath, grantPath)
      ));
    } catch {
      return false;
    }
  }

  protectedRoots() {
    return [
      this.cwd,
      this.workspace,
      ...this.workspaceFolders,
      ...this.resolveAuthorizedFolders(),
    ].filter((root): root is string => typeof root === "string" && root.length > 0);
  }
}

// 本地实现保留：被检查的路径可能还不存在（写入 / 删除的目标），这里要把已存在的那
// 一段祖先解析掉再把剩下的接回去，共享原语只认存在的路径，表达不了这个上溯。
// 解析成功的那一段仍然交给共享原语做 native 归一。
function normalizeExistingOrResolvedPath(filePath: string) {
  const resolved = path.resolve(filePath);
  try {
    fs.realpathSync(resolved);
    return canonicalFilesystemPathSync(resolved);
  } catch (err) {
    if ((err as any)?.code !== "ENOENT") return resolved;
  }

  const pending: string[] = [];
  let current = resolved;
  while (true) {
    const parent = path.dirname(current);
    if (parent === current) {
      return resolved;
    }
    pending.push(path.basename(current));
    try {
      fs.realpathSync(parent);
      const realParent = canonicalFilesystemPathSync(parent);
      pending.reverse();
      return path.join(realParent, ...pending);
    } catch (err) {
      if ((err as any)?.code !== "ENOENT") return resolved;
      current = parent;
    }
  }
}

/** 两侧都必须是身份键。 */
function isInsideRoot(filePath: string, root: string) {
  const rel = path.relative(root, filePath);
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

function externalReadGrantCovers(targetPath: string, grantPath: string) {
  // 判定是比较，走身份键；statSync 要落到真实路径，所以另留一份 canonical。
  const target = filesystemIdentityKeySync(normalizeExistingOrResolvedPath(targetPath));
  const grantCanonical = canonicalFilesystemPathSync(grantPath);
  const grant = filesystemIdentityKeySync(grantCanonical);
  if (target === grant) return true;
  try {
    return fs.statSync(grantCanonical).isDirectory() && isInsideRoot(target, grant);
  } catch {
    return false;
  }
}

function denied(code: ResourceAccessDenied["code"]): ResourceAccessDenied {
  return {
    allowed: false,
    code,
    reason: code,
    safeMessage: safeMessageForCode(code),
  };
}

function safeMessageForCode(code: ResourceAccessDenied["code"]): string {
  switch (code) {
    case "protected_metadata":
      return "Resource is protected metadata";
    case "managed_config_denied":
      return "Managed config files must be changed through settings APIs";
    case "path_outside_authorized_roots":
      return "Resource is outside authorized roots";
    case "invalid_resource_path":
      return "Resource path is invalid";
    case "sandbox_denied":
      return "Resource access is denied by sandbox policy";
  }
}

function codeForSandboxDenial(absolutePath: string, operation: Operation, roots: string[]): ResourceAccessDenied["code"] {
  if (isProtectedMetadataPath(absolutePath, roots)) return "protected_metadata";
  if (operation === "write" || operation === "delete") return "path_outside_authorized_roots";
  return "sandbox_denied";
}

function isProtectedMetadataPath(filePath: string, roots: string[]): boolean {
  const target = filesystemIdentityKeySync(normalizeExistingOrResolvedPath(filePath));
  for (const root of roots) {
    const normalizedRoot = filesystemIdentityKeySync(normalizeExistingOrResolvedPath(root));
    if (!isInsideRoot(target, normalizedRoot)) continue;
    const relParts = path.relative(normalizedRoot, target).split(path.sep).filter(Boolean);
    if (relParts.includes(".git")) return true;
  }
  return false;
}
