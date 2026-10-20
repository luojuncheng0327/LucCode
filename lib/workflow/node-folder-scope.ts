/**
 * node-folder-scope.ts — workflow agent() 节点级写作用域（writeFolders）：
 * shape 校验、写声明强制（default-deny）、attenuation 子集校验与 isoOpts 映射。
 *
 * 设计约束：
 * - 节点级声明：每个 agent() 调用自行声明 writeFolders，不做 workflow 调用级总范围。
 * - default-deny：写能力节点（显式 access:"write"，或省略 access 且父档可操作）必须
 *   声明 writeFolders，未声明在节点启动前拒绝；错误消息即纠正指引。
 *   不做脚本静态扫描——opts 只在 agent() 调用时刻完全已知，运行时判定才是精确的。
 * - attenuation 硬约束：节点权限不得超过父会话。writeFolders 的每一项经 realpath 解析后
 *   必须落在父会话 folder scope（cwd + workspaceFolders + authorizedFolders）之内，
 *   越界报错，不静默裁剪。
 * - 沙盒是"全局可读、范围内可写"模型（lib/sandbox/policy.ts 的 allowExternalReads: true），
 *   本机制只收窄写作用域；读一律沿用沙盒全局只读契约。
 * - fail-closed：父 scope 不可得、路径不存在、非目录、相对路径 → 全部显式报错。
 * - 声明列表第一项成为节点 cwd：cwd 本身就是沙盒写根（policy 会把 cwd 并入
 *   workspaceRoots），继承父 cwd 会泄漏父级写权限，必须一并收紧。
 */
import fs from "fs";
import path from "path";
import { isReadOnlyPermissionMode } from "../../core/session-permission-mode.ts";

export class WorkflowFolderScopeError extends Error {
  declare code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "WorkflowFolderScopeError";
    this.code = code;
  }
}

/** realpath 解析（跟踪符号链接）；目标不存在返回 null，由调用方按错误处理。 */
function realOrNull(p: string): string | null {
  try {
    return fs.realpathSync(path.resolve(p));
  } catch {
    return null;
  }
}

/** 与 PathGuard._isInside 同一约定：含相等的前缀包含判断。 */
function isInside(target: string, base: string): boolean {
  return target === base || target.startsWith(base + path.sep);
}

/**
 * 同步 shape 校验（无 fs 访问），供 host-api 在 agent() 调用点立即抛错。
 * writeFolders 为 null/undefined 时表示未声明，直接放行（是否必须声明由
 * assertNodeWriteScopeDeclared 判定）。
 */
export function assertNodeWriteFoldersShape(writeFolders: unknown, access: unknown): void {
  if (writeFolders == null) return;
  if (access === "read") {
    throw new WorkflowFolderScopeError(
      'workflow agent() writeFolders declares a write scope and cannot be combined with access:"read".',
      "WRITE_FOLDERS_CONFLICT_WITH_READ",
    );
  }
  if (!Array.isArray(writeFolders) || writeFolders.length === 0) {
    throw new WorkflowFolderScopeError(
      "workflow agent() writeFolders must be a non-empty array of absolute folder paths.",
      "WRITE_FOLDERS_INVALID",
    );
  }
  for (const raw of writeFolders) {
    if (typeof raw !== "string" || !raw.trim() || !path.isAbsolute(raw.trim())) {
      throw new WorkflowFolderScopeError(
        `workflow agent() writeFolders entries must be absolute paths; got: ${JSON.stringify(raw)}`,
        "WRITE_FOLDERS_INVALID",
      );
    }
  }
}

/**
 * default-deny：写能力节点必须声明 writeFolders。
 * 豁免：已声明 / access:"read" / 父会话只读（节点本来写不了）。
 * 错误消息是给编排模型的纠正指引：教修复方式与 resumeFromRunId 低成本续跑。
 */
export function assertNodeWriteScopeDeclared({ writeFolders, access, parentPermissionMode, nodeId, label }: {
  writeFolders: string[] | null | undefined;
  access: string | null | undefined;
  parentPermissionMode: string | null | undefined;
  nodeId: string;
  label: string | null | undefined;
}): void {
  if (writeFolders != null) return;
  if (access === "read") return;
  if (isReadOnlyPermissionMode(parentPermissionMode)) return;
  const nodeName = label || nodeId;
  throw new WorkflowFolderScopeError(
    `workflow node "${nodeName}" is write-capable but declares no writeFolders. ` +
    'Every node must either run read-only (access:"read") or declare writeFolders: ["/abs/folder", ...] — ' +
    "the narrowest existing folders the task writes to (the first entry becomes the node cwd). " +
    "Re-dispatch the workflow with the fixed script and pass resumeFromRunId to reuse completed nodes.",
    "WRITE_FOLDERS_REQUIRED",
  );
}

/**
 * 解析节点写作用域 → executeIsolated 的 folder 入参。
 * @returns {{ cwd: string, workspaceFolders: string[], authorizedFolders: string[] }}
 * @throws {WorkflowFolderScopeError} 父 scope 缺失 / 条目不存在 / 非目录 / 越界
 */
export function resolveNodeFolderScope({ writeFolders, parentFolderScope }: {
  writeFolders: string[];
  parentFolderScope: { sandboxFolders?: string[] } | null;
}) {
  // 父 roots 是引擎侧可信输入：realpath 失败（如目录被移走）时退回 resolve，
  // 只影响包含判断从而 fail-closed，不会放大权限。
  const parentRoots = (parentFolderScope?.sandboxFolders || [])
    .filter((root) => typeof root === "string" && root.trim())
    .map((root) => realOrNull(root) ?? path.resolve(root));
  if (!parentRoots.length) {
    throw new WorkflowFolderScopeError(
      "workflow agent() writeFolders requires the parent session folder scope, which is unavailable here.",
      "PARENT_SCOPE_UNAVAILABLE",
    );
  }

  const canonical: string[] = [];
  const seen = new Set<string>();
  for (const raw of writeFolders) {
    const real = realOrNull(raw.trim());
    if (!real) {
      throw new WorkflowFolderScopeError(
        `workflow agent() writeFolders entry does not exist: ${raw}`,
        "WRITE_FOLDER_NOT_FOUND",
      );
    }
    let isDir = false;
    try { isDir = fs.statSync(real).isDirectory(); } catch { isDir = false; }
    if (!isDir) {
      throw new WorkflowFolderScopeError(
        `workflow agent() writeFolders entry is not a directory: ${raw}`,
        "WRITE_FOLDER_NOT_DIRECTORY",
      );
    }
    if (!parentRoots.some((base) => isInside(real, base))) {
      throw new WorkflowFolderScopeError(
        `workflow agent() writeFolders entry escapes the parent session folder scope: ${raw}`,
        "WRITE_FOLDER_OUTSIDE_PARENT_SCOPE",
      );
    }
    if (!seen.has(real)) {
      seen.add(real);
      canonical.push(real);
    }
  }
  return {
    cwd: canonical[0],
    workspaceFolders: canonical.slice(1),
    authorizedFolders: [] as string[],
  };
}
