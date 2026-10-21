/**
 * path-guard.js — 路径权限校验
 *
 * 定义四种访问级别：BLOCKED / READ_ONLY / READ_WRITE / FULL
 * 所有路径先经过 realpath 解析符号链接，再匹配区域。
 *
 * 常量从 policy.js 导入（单一来源）。
 */

import fs from "fs";
import path from "path";
import { t } from "../i18n.ts";
import {
  BLOCKED_FILES,
  BLOCKED_DIRS,
  READ_ONLY_AGENT_FILES,
  READ_ONLY_AGENT_DIRS,
  READ_ONLY_HOME_DIRS,
  READ_WRITE_AGENT_DIRS,
  READ_WRITE_AGENT_FILES,
  READ_WRITE_HOME_DIRS,
} from "./policy.ts";

export const AccessLevel = {
  BLOCKED: "blocked",
  READ_ONLY: "read_only",
  READ_WRITE: "read_write",
  FULL: "full",
};

/** 操作 → 所需最低级别 */
const OP_REQUIREMENTS = {
  read: new Set([AccessLevel.READ_ONLY, AccessLevel.READ_WRITE, AccessLevel.FULL]),
  write: new Set([AccessLevel.READ_WRITE, AccessLevel.FULL]),
  delete: new Set([AccessLevel.FULL]),
  stage: new Set([AccessLevel.FULL]),
};

export class PathGuard {
  declare _fullAccess: boolean;
  declare luccodeHome: string;
  declare agentDir: string;
  declare workspaceRoots: string[];
  declare policyWritablePaths: string[];
  declare allowExternalReads: boolean;

  /**
   * @param {object} policy  从 deriveSandboxPolicy() 得到，或兼容旧格式
   */
  constructor(policy) {
    if (policy.mode === "full-access") {
      this._fullAccess = true;
      return;
    }
    this._fullAccess = false;
    this.luccodeHome = this._resolveReal(policy.luccodeHome) || path.resolve(policy.luccodeHome);
    this.agentDir = this._resolveReal(policy.agentDir) || path.resolve(policy.agentDir);
    const roots = Array.isArray(policy.workspaceRoots) && policy.workspaceRoots.length > 0
      ? policy.workspaceRoots
      : [policy.workspace].filter(Boolean);
    this.workspaceRoots = roots.map((root) => this._resolveReal(root) || path.resolve(root));
    this.policyWritablePaths = (policy.writablePaths || [])
      .map((root) => this._resolveReal(root) || path.resolve(root));
    this.allowExternalReads = policy.allowExternalReads === true;
  }

  /**
   * 解析路径（跟踪符号链接）。
   * 文件不存在时递归往上找到最近的存在的祖先目录，
   * 对它做 realpath，然后把不存在的段拼回去。
   * 这样 mkdir -p 多层目录时也能正确判断权限。
   */
  _resolveReal(p) {
    const abs = path.resolve(p);
    try {
      return fs.realpathSync(abs);
    } catch (err) {
      if (err.code !== "ENOENT") return null;

      const pending = [];
      let current = abs;
      while (true) {
        const parent = path.dirname(current);
        if (parent === current) return null; // 到根目录还找不到
        pending.push(path.basename(current));
        try {
          const realParent = fs.realpathSync(parent);
          pending.reverse();
          return path.join(realParent, ...pending);
        } catch (e) {
          if (e.code !== "ENOENT") return null;
          current = parent;
        }
      }
    }
  }

  /** 判断 target 是否在 base 内部（含相等） */
  _isInside(target, base) {
    return target === base || target.startsWith(base + path.sep);
  }

  /**
   * 获取路径的访问级别
   * @param {string} rawPath 绝对路径
   * @returns {string} AccessLevel
   */
  getAccessLevel(rawPath) {
    const resolved = this._resolveReal(rawPath);
    if (!resolved) return AccessLevel.BLOCKED;
    return this._getAccessLevelResolved(resolved);
  }

  _getAccessLevelResolved(resolved) {
    // 1. BLOCKED 文件（lucHome 根）
    for (const f of BLOCKED_FILES) {
      if (resolved === path.join(this.luccodeHome, f)) return AccessLevel.BLOCKED;
    }

    // 2. BLOCKED 目录
    for (const d of BLOCKED_DIRS) {
      if (this._isInside(resolved, path.join(this.luccodeHome, d))) {
        return AccessLevel.BLOCKED;
      }
    }

    // 3. READ_ONLY agent 文件
    for (const f of READ_ONLY_AGENT_FILES) {
      if (resolved === path.join(this.agentDir, f)) return AccessLevel.READ_ONLY;
    }

    // 4. READ_ONLY agent 目录（通用机制，当前为空）
    for (const d of READ_ONLY_AGENT_DIRS) {
      if (this._isInside(resolved, path.join(this.agentDir, d))) {
        return AccessLevel.READ_ONLY;
      }
    }

    // 5. READ_ONLY 全局目录
    for (const d of READ_ONLY_HOME_DIRS) {
      if (this._isInside(resolved, path.join(this.luccodeHome, d))) {
        return AccessLevel.READ_ONLY;
      }
    }

    // 6. READ_WRITE agent 目录
    for (const d of READ_WRITE_AGENT_DIRS) {
      if (this._isInside(resolved, path.join(this.agentDir, d))) {
        return AccessLevel.READ_WRITE;
      }
    }

    // 6. READ_WRITE agent 文件
    for (const f of READ_WRITE_AGENT_FILES) {
      if (resolved === path.join(this.agentDir, f)) return AccessLevel.READ_WRITE;
    }

    // 7. READ_WRITE 全局目录
    for (const d of READ_WRITE_HOME_DIRS) {
      if (this._isInside(resolved, path.join(this.luccodeHome, d))) {
        return AccessLevel.READ_WRITE;
      }
    }

    // 8. lucHome 内未匹配 → 遵守 read-all 契约：非敏感路径可读，写仍需显式白名单。
    if (this._isInside(resolved, this.luccodeHome)) {
      return this.allowExternalReads ? AccessLevel.READ_ONLY : AccessLevel.BLOCKED;
    }

    // 9. workspace roots 内 → FULL
    for (const root of this.workspaceRoots) {
      if (this._isInside(resolved, root)) {
        return AccessLevel.FULL;
      }
    }

    // 10. 策略显式写根：用于运行时缓存、沙盒临时目录等非 workspace 写入点。
    for (const root of this.policyWritablePaths) {
      if (this._isInside(resolved, root)) {
        return AccessLevel.READ_WRITE;
      }
    }

    // 11. 其他普通系统路径 → 只读。写/删仍只允许在 workspace 和受控目录内发生。
    if (this.allowExternalReads) return AccessLevel.READ_ONLY;
    return AccessLevel.BLOCKED;
  }

  /**
   * 检查操作是否被允许
   * @param {string} absolutePath
   * @param {"read"|"write"|"delete"|"stage"} operation
   * @returns {{ allowed: boolean, canonicalPath?: string, reason?: string }}
   */
  check(absolutePath, operation) {
    const canonicalPath = this._resolveReal(absolutePath);
    if (!canonicalPath) {
      return {
        allowed: false,
        reason: t("sandbox.denied", {
          op: operation === "stage" ? "stage" : operation,
          path: path.resolve(absolutePath),
          level: AccessLevel.BLOCKED,
        }),
      };
    }
    if (this._fullAccess) return { allowed: true, canonicalPath };
    const level = this._getAccessLevelResolved(canonicalPath);
    const allowed = OP_REQUIREMENTS[operation]?.has(level) ?? false;

    if (allowed) return { allowed: true, canonicalPath };

    const opLabel = {
      read: t("sandbox.opRead"),
      write: t("sandbox.opWrite"),
      delete: t("sandbox.opDelete"),
      stage: "stage",
    }[operation] || operation;
    return {
      allowed: false,
      reason: t("sandbox.denied", { op: opLabel, path: canonicalPath, level }),
    };
  }

}
