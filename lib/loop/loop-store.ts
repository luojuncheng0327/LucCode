/**
 * loop-store.ts — 循环状态持久化
 *
 * 只负责状态 CRUD 与原子落盘；调度在 alarm-service，记账与护栏在 loop-controller。
 * 以 sessionId 为键（桌面桥接统一）：sessionId 是持久身份，sessionPath/sessionKey
 * 只是 locator/投递地址，须在边界解析。循环只活在一个物理会话里——会话换代
 * （reset/new）后 sessionId 变更，旧循环由投递层身份校验终止。
 * 每个会话至多一个循环记录。
 */
import fs from "fs";
import path from "path";
import { atomicWriteSync } from "../../shared/safe-fs.ts";

export const LOOP_DEFAULT_LIMITS = Object.freeze({
  maxTurns: 50,
  maxConsecutiveFailures: 3,
  minDelaySec: 60,
  guardedMinDelaySec: 1200,
  fallbackDelaySec: 1200,
});

const ACTIVE_LOOP_STATUSES = new Set(["running", "paused"]);

export function loopKeyForTarget(target) {
  const sessionId = typeof target?.sessionId === "string" ? target.sessionId.trim() : "";
  if (!sessionId) throw new Error("loop-store: target.sessionId is required");
  return sessionId;
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}

export class LoopStore {
  declare _path: string;
  declare _loops: Map<string, any>;
  declare _log: any;

  constructor(persistPath, options: any = {}) {
    this._path = persistPath;
    this._log = options.log || console;
    this._loops = new Map();
    this._load();
  }

  _load() {
    let raw;
    try {
      raw = fs.readFileSync(this._path, "utf-8");
    } catch (err: any) {
      if (err?.code === "ENOENT") return;
      throw err;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // 损坏文件不静默丢弃：移到 .corrupt-<ts> 保留现场并大声报错；
      // 循环状态可安全重建，因此以空态继续而不是阻断启动。
      const backup = `${this._path}.corrupt-${Date.now()}`;
      try { fs.renameSync(this._path, backup); } catch {}
      this._log.error?.(`[loop-store] corrupt state file moved to ${backup}; starting empty`);
      return;
    }
    for (const entry of parsed?.loops || []) {
      if (entry?.key && entry?.target) this._loops.set(entry.key, entry);
    }
  }

  _save() {
    fs.mkdirSync(path.dirname(this._path), { recursive: true });
    const data = JSON.stringify(
      { schemaVersion: 1, loops: [...this._loops.values()] },
      null,
      2,
    ) + "\n";
    atomicWriteSync(this._path, data);
  }

  get(key) {
    return clone(this._loops.get(key) ?? null);
  }

  create(target, prompt, limitsOverride: any = null) {
    const key = loopKeyForTarget(target);
    const existing = this._loops.get(key);
    if (existing && ACTIVE_LOOP_STATUSES.has(existing.status)) {
      throw new Error(`loop_already_active: ${key}`);
    }
    const now = Date.now();
    const record = {
      key,
      target: clone(target),
      status: "running",
      prompt,
      turnCount: 0,
      consecutiveFailures: 0,
      alarm: null,
      limits: { ...LOOP_DEFAULT_LIMITS, ...(limitsOverride || {}) },
      pausedReason: null,
      completedSummary: null,
      createdAt: now,
      updatedAt: now,
    };
    this._loops.set(key, record);
    this._save();
    return clone(record);
  }

  update(key, patch) {
    const existing = this._loops.get(key);
    if (!existing) throw new Error(`no_loop: ${key}`);
    const next = { ...existing, ...clone(patch), updatedAt: Date.now() };
    this._loops.set(key, next);
    this._save();
    return clone(next);
  }

  remove(key) {
    if (this._loops.delete(key)) this._save();
  }

  listByStatus(status) {
    return [...this._loops.values()].filter((l) => l.status === status).map(clone);
  }
}
