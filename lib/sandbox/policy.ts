/**
 * policy.js — 沙盒策略单一来源
 *
 * 所有 ACL 常量在这里定义一份。
 * PathGuard 和 OS 沙盒（seatbelt/bwrap）都从这里导入。
 */

import path from "path";
import { workspaceRootsForSandbox } from "../../shared/workspace-scope.ts";

// ─── 常量 ─────────────────────────────────────

/** lucHome 根级别被屏蔽的文件 */
export const BLOCKED_FILES = ["auth.json", "models.json", "added-models.yaml", "crash.log"];

/** lucHome 根级别被屏蔽的目录 */
export const BLOCKED_DIRS = ["browser-data", "playwright-browsers"];

/** agentDir 下只读的文件 */
export const READ_ONLY_AGENT_FILES = [
  "AGENTS.md",
  // 人格文件的旧名字。启动时会把它改名成 AGENTS.md，但改名可能因为权限或文件
  // 被占用而失败；那种情况下旧文件还躺在 agent 目录里，这里留着它，免得一份
  // 本该只读的人格文件因为改名没成功就变成可写的。
  "ishiki.md",
  "config.yaml",
  "identity.md",
  "yuan.md",
];

/** lucHome 根级别只读的目录 */
export const READ_ONLY_HOME_DIRS = ["user", "skills", "session-files"];

/** agentDir 下可读写的目录 */
export const READ_WRITE_AGENT_DIRS = [
  "memory",
  "sessions",
  "desk",
  "heartbeat",
  "book",
  "activity",
  "avatars",
];

/** agentDir 下只读的目录（通用机制；.skill-snapshots 已随 pointer 化移除，当前为空） */
export const READ_ONLY_AGENT_DIRS = [];

/** agentDir 下可读写的文件 */
export const READ_WRITE_AGENT_FILES = ["pinned.md", "channels.md"];

/** lucHome 根级别可读写的目录 */
export const READ_WRITE_HOME_DIRS = ["channels", "logs", "uploads", ".ephemeral"];

export const SANDBOX_ACCESS_CONTRACT = Object.freeze({
  read: "all",
  write: "scoped",
  network: "on",
});
export const SANDBOX_MODE_LABEL =
  `read-${SANDBOX_ACCESS_CONTRACT.read}_write-${SANDBOX_ACCESS_CONTRACT.write}_network-${SANDBOX_ACCESS_CONTRACT.network}`;

function uniqueTruthy(paths) {
  const out = [];
  const seen = new Set();
  for (const raw of paths || []) {
    if (!raw) continue;
    const value = path.resolve(raw);
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

// ─── 策略推导 ──────────────────────────────────

/**
 * 从 agent 配置推导沙盒策略
 *
 * @param {object} opts
 * @param {string} opts.agentDir
 * @param {string|null} [opts.cwd]
 * @param {string|null} opts.workspace
 * @param {string[]} [opts.workspaceFolders]
 * @param {string} opts.luccodeHome
 * @param {string[]} [opts.runtimeWritablePaths]
 * @param {"standard"|"full-access"} opts.mode
 * @returns {object} policy
 */
export function deriveSandboxPolicy({
  agentDir,
  cwd = null,
  workspace,
  workspaceFolders = [],
  lucHome,
  runtimeWritablePaths = [],
  mode,
}) {
  if (mode === "full-access") {
    return { mode: "full-access" };
  }
  const workspaceRoots = uniqueTruthy([
    ...workspaceRootsForSandbox(workspace, workspaceFolders),
    ...workspaceRootsForSandbox(cwd, []),
  ]);

  return {
    mode: "standard",
    access: SANDBOX_ACCESS_CONTRACT,
    lucHome,
    agentDir,
    cwd,
    workspace,
    workspaceRoots,
    allowExternalReads: true,

    // OS 沙盒用：可写路径
    writablePaths: [
      ...READ_WRITE_AGENT_DIRS.map((d) => path.join(agentDir, d)),
      ...READ_WRITE_HOME_DIRS.map((d) => path.join(lucHome, d)),
      ...workspaceRoots,
      ...runtimeWritablePaths,
    ].filter(Boolean),

    // macOS/Linux OS 沙盒仍使用显式只读路径。Windows restricted-token
    // 后端按当前用户权限自然读取，不再把读权限投影成 ACL grant。
    readablePaths: [
      ...READ_ONLY_AGENT_FILES.map((f) => path.join(agentDir, f)),
      ...READ_ONLY_AGENT_DIRS.map((d) => path.join(agentDir, d)),
      ...READ_ONLY_HOME_DIRS.map((d) => path.join(lucHome, d)),
    ].filter(Boolean),

    // OS 沙盒用：拒绝读取（文件 + 目录）
    denyReadPaths: [
      ...BLOCKED_FILES.map((f) => path.join(lucHome, f)),
      ...BLOCKED_DIRS.map((d) => path.join(lucHome, d)),
    ],

    // OS 沙盒用：写保护（在可写范围内再限制）
    protectedPaths: [
      ...workspaceRoots.map((root) => path.join(root, ".git")),
      path.join(lucHome, "session-files"),
    ].filter(Boolean),
  };
}
