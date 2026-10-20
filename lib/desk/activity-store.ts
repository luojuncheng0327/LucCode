/**
 * activity-store.js — 助手活动元数据存储
 *
 * 管理心跳、cron 等后台执行的记录。
 * 每次执行存一条元数据（摘要、时间、状态），
 * session .jsonl 文件单独存放在 activity/ 目录。
 *
 * 自动清理：超过 MAX_ENTRIES 条时删除最老的，连同 session 文件。
 */

import fs from "fs";
import path from "path";
import { atomicWriteSync } from "../../shared/safe-fs.ts";

const MAX_ENTRIES = 100;
export const DEFAULT_ACTIVITY_EXECUTION_TIMEOUT_MS = 20 * 60 * 1000;

function normalizeNow(value: any) {
  return typeof value === "number" && Number.isFinite(value) ? value : Date.now();
}

function normalizeTimeoutMs(value: any) {
  if (value === undefined || value === null) return DEFAULT_ACTIVITY_EXECUTION_TIMEOUT_MS;
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("executionTimeoutMs must be a positive finite number");
  }
  return value;
}

function formatTimeoutMs(ms: number) {
  if (ms % 60_000 === 0) return `${ms / 60_000} 分钟`;
  if (ms % 1000 === 0) return `${ms / 1000} 秒`;
  return `${ms}ms`;
}

function activityLabel(entry: any) {
  return entry?.label || entry?.summary || "后台任务";
}

function interruptedPatch(entry: any, now: number) {
  return {
    status: "error",
    finishedAt: now,
    error: "interrupted",
    summary: `${activityLabel(entry)} 已中断：应用已关闭或重启`,
  };
}

export function activityTimeoutPatch(entry: any, now: number, timeoutMs = DEFAULT_ACTIVITY_EXECUTION_TIMEOUT_MS) {
  return {
    status: "error",
    finishedAt: now,
    error: "timeout",
    summary: `${activityLabel(entry)} 已超时（超过 ${formatTimeoutMs(timeoutMs)}）`,
  };
}

export class ActivityStore {
  declare _filePath: string;
  declare _activityDir: string;
  declare _entries: any[];

  /**
   * @param {string} filePath - activities.json 路径
   * @param {string} activityDir - session 文件所在目录
   */
  declare _executionTimeoutMs: number;

  constructor(filePath: string, activityDir: string, opts: any = {}) {
    this._filePath = filePath;
    this._activityDir = activityDir;
    this._executionTimeoutMs = normalizeTimeoutMs(opts.executionTimeoutMs);
    this._entries = [];
    this._load();
    if (opts.finalizeOrphanedRunning !== false) {
      this.finalizeRunningAsInterrupted({ now: opts.now });
    }
  }

  /** @private */
  _load() {
    try {
      const raw = fs.readFileSync(this._filePath, "utf-8");
      this._entries = JSON.parse(raw);
      if (!Array.isArray(this._entries)) this._entries = [];
    } catch {
      this._entries = [];
    }
  }

  /** @private */
  _save() {
    fs.mkdirSync(path.dirname(this._filePath), { recursive: true });
    // atomic write: tmp + rename，防止写到一半崩溃损坏文件
    atomicWriteSync(this._filePath, JSON.stringify(this._entries, null, 2));
  }

  /**
   * 添加活动记录
   * @param {object} entry
   * @returns {object} 添加的记录
   */
  add(entry: any) {
    this._entries.unshift(entry);
    this._cleanup();
    this._save();
    return entry;
  }

  /** 列出所有活动（已按时间倒序） */
  list() {
    return this._entries;
  }

  /** 按 ID 查找 */
  get(id: any) {
    return this._entries.find(e => e.id === id) || null;
  }

  /** 按 ID 更新条目的部分字段（不触发 cleanup） */
  update(id: any, partial: any) {
    const entry = this._entries.find(e => e.id === id);
    if (!entry) return null;
    const { id: _, ...safePartial } = partial;
    Object.assign(entry, safePartial);
    this._save();
    return entry;
  }

  finalizeRunningAsInterrupted({ now }: any = {}) {
    const finishedAt = normalizeNow(now);
    const changed = [];
    for (const entry of this._entries) {
      if (entry?.status !== "running") continue;
      Object.assign(entry, interruptedPatch(entry, finishedAt));
      changed.push({ ...entry });
    }
    if (changed.length) this._save();
    return changed;
  }

  reconcileOverdueRunning({ now, executionTimeoutMs }: any = {}) {
    const finishedAt = normalizeNow(now);
    const timeoutMs = normalizeTimeoutMs(executionTimeoutMs ?? this._executionTimeoutMs);
    const changed = [];
    for (const entry of this._entries) {
      if (entry?.status !== "running") continue;
      if (typeof entry.startedAt !== "number" || !Number.isFinite(entry.startedAt)) continue;
      if (finishedAt - entry.startedAt < timeoutMs) continue;
      Object.assign(entry, activityTimeoutPatch(entry, finishedAt, timeoutMs));
      changed.push({ ...entry });
    }
    if (changed.length) this._save();
    return changed;
  }

  /** 按 ID 移除（升格后清理用） */
  remove(id: any) {
    const idx = this._entries.findIndex(e => e.id === id);
    if (idx === -1) return false;
    this._entries.splice(idx, 1);
    this._save();
    return true;
  }

  /** 自动清理超出上限的老记录 */
  _cleanup() {
    while (this._entries.length > MAX_ENTRIES) {
      const old = this._entries.pop();
      // 删除对应的 session 文件
      if (old?.sessionFile) {
        const sessionPath = path.join(this._activityDir, old.sessionFile);
        try { fs.unlinkSync(sessionPath); } catch {}
      }
    }
  }
}
