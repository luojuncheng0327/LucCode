/**
 * 子进程工作目录的显式契约。
 *
 * Node spawn 在 cwd 不存在时同样报 ENOENT，且 err.path 可能指向可执行文件；
 * node-pty 在 Windows 上会直接暴露 ERROR_DIRECTORY(267)。执行入口先走这里，
 * 把工作目录失效作为自己的错误暴露，避免误导到 shell/helper 缺失。
 */

import { statSync as fsStatSync } from "fs";
import path from "path";

const MISSING_CODES = new Set(["ENOENT", "ENOTDIR"]);

const ERROR_CODES = {
  invalid: "LUC_EXEC_CWD_INVALID",
  relative: "LUC_EXEC_CWD_RELATIVE",
  missing: "LUC_EXEC_CWD_MISSING",
  "not-directory": "LUC_EXEC_CWD_NOT_DIRECTORY",
};

function messageFor(status, cwd) {
  switch (status) {
    case "invalid":
      return "Working directory is required for command execution but was empty.";
    case "relative":
      return `Working directory must be an absolute path, got: ${cwd}`;
    case "missing":
      return `Working directory does not exist: ${cwd}. ` +
        "The folder may have been deleted, renamed, moved, or its drive disconnected. " +
        "Pick an existing working directory (re-select the agent home folder in settings, " +
        "or pass a valid cwd), then retry.";
    case "not-directory":
      return `Working directory is not a directory: ${cwd}`;
    default:
      return `Working directory check failed for: ${cwd}`;
  }
}

/**
 * @param {unknown} cwd
 * @param {{ statSync?: typeof fsStatSync }} [deps]
 * @returns {{ status: "ok"|"invalid"|"relative"|"missing"|"not-directory"|"unreadable", cwd: string, errorCode: string|null }}
 */
export function classifyExecutionCwd(cwd, { statSync = fsStatSync } = {}) {
  const raw = typeof cwd === "string" ? cwd.trim() : "";
  if (!raw) return { status: "invalid", cwd: raw, errorCode: null };
  if (!path.isAbsolute(raw) && !path.win32.isAbsolute(raw)) {
    return { status: "relative", cwd: raw, errorCode: null };
  }

  try {
    const stat = statSync(raw);
    return stat.isDirectory()
      ? { status: "ok", cwd: raw, errorCode: null }
      : { status: "not-directory", cwd: raw, errorCode: null };
  } catch (err) {
    const errorCode = typeof err?.code === "string" ? err.code : null;
    return {
      status: MISSING_CODES.has(errorCode) ? "missing" : "unreadable",
      cwd: raw,
      errorCode,
    };
  }
}

/**
 * spawn 前的工作目录断言。确定性失败抛 LUC_EXEC_CWD_*；
 * unreadable 放行，交给 spawn 层保留原始系统行为。
 */
export function assertExecutionCwd(cwd, deps = {}) {
  const result = classifyExecutionCwd(cwd, deps);
  if (result.status === "ok" || result.status === "unreadable") return result.cwd;
  const err: any = new Error(messageFor(result.status, result.cwd));
  err.code = ERROR_CODES[result.status];
  err.cwd = result.cwd;
  throw err;
}
