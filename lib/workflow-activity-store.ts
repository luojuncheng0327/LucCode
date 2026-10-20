/**
 * workflow-activity-store.js —— 右侧活动卡（workflow + subagent）的持久化背书
 *
 * ActivityHub 是内存广播层，进程重启即清空，导致右侧卡（WorkflowCard / AgentActivityCard）
 * 重启消失。这个 store 把 ActivityHub 标记为可持久的活动（workflow / workflow_agent / subagent，
 * 见 activity-hub.js 的 PERSISTABLE_KINDS）落盘（lucHome/workflow-activity.json），作为
 * ActivityHub 的「持久化背书」：upsert 写穿、重启回灌、会话退场清理、72h TTL 修剪。
 * 名称沿用 workflow-activity（首次落地时仅 workflow），实为 ActivityHub 通用持久层。
 *
 * 归属：每条 entry 自带 sessionId + sessionPath。sessionId 是稳定身份，sessionPath 是 legacy locator。
 * 不从焦点指针推导（状态归属唯一确定）。这是 dumb 持久层——entry 的规范化由 ActivityHub 负责。
 */
import fs from "node:fs";
import path from "node:path";
import { atomicWriteSync } from "../shared/safe-fs.ts";

export const WORKFLOW_ACTIVITY_STORE_VERSION = 1;

function text(value: any) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeSessionRef(value: any) {
  if (value && typeof value === "object") {
    return {
      sessionId: text(value.sessionId),
      sessionPath: text(value.sessionPath),
    };
  }
  return { sessionId: null, sessionPath: text(value) };
}

function matchesSession(entry: any, sessionRef: any) {
  if (sessionRef.sessionId) return text(entry.sessionId) === sessionRef.sessionId;
  return !!sessionRef.sessionPath && entry.sessionPath === sessionRef.sessionPath;
}

export class WorkflowActivityStore {
  declare _persistPath: string | null;
  declare _entries: Map<string, any>;

  constructor(persistPath: any) {
    this._persistPath = persistPath || null;
    /** @type {Map<string, object>} */
    this._entries = new Map();
    if (this._persistPath) this._load();
  }

  upsert(entry: any) {
    return this.upsertMany([entry])[0] || null;
  }

  /** Persist a group of activity projections as one in-memory/disk transaction. */
  upsertMany(entries: any[]) {
    const staged = (Array.isArray(entries) ? entries : [])
      .filter((entry) => entry && typeof entry.id === "string" && entry.id)
      .map((entry) => ({ ...entry }));
    if (staged.length === 0) return [];

    const previous = new Map<string, any>();
    for (const entry of staged) {
      if (!previous.has(entry.id)) {
        previous.set(entry.id, this._entries.has(entry.id) ? { ...this._entries.get(entry.id) } : null);
      }
      this._entries.set(entry.id, entry);
    }
    try {
      this._save();
    } catch (error) {
      for (const [id, value] of previous) {
        if (value) this._entries.set(id, value);
        else this._entries.delete(id);
      }
      throw error;
    }
    return staged.map((entry) => ({ ...entry }));
  }

  get(id: string) {
    const e = this._entries.get(id);
    return e ? { ...e } : null;
  }

  list() {
    return [...this._entries.values()].map((e) => ({ ...e }));
  }

  listBySession(sessionRefInput: any) {
    const sessionRef = normalizeSessionRef(sessionRefInput);
    if (!sessionRef.sessionId && !sessionRef.sessionPath) return [];
    const out = [];
    for (const e of this._entries.values()) {
      if (matchesSession(e, sessionRef)) out.push({ ...e });
    }
    return out;
  }

  remove(id: string) {
    return this.removeMany([id]).length > 0;
  }

  /** Remove a group of projections atomically so failed Session Forks leave no sidecars. */
  removeMany(ids: string[]) {
    const requested = [...new Set((Array.isArray(ids) ? ids : [])
      .filter((id) => typeof id === "string" && id))];
    const removed = [];
    for (const id of requested) {
      const entry = this._entries.get(id);
      if (!entry) continue;
      removed.push([id, { ...entry }]);
      this._entries.delete(id);
    }
    if (removed.length === 0) return [];
    try {
      this._save();
    } catch (error) {
      for (const [id, entry] of removed) this._entries.set(id, entry);
      throw error;
    }
    return removed.map(([, entry]) => ({ ...entry }));
  }

  /** 会话退场（删除 / 归档 / 冷清理）时回收该 session 的活动，返回删除条数。 */
  removeBySession(sessionRefInput: any) {
    const sessionRef = normalizeSessionRef(sessionRefInput);
    if (!sessionRef.sessionId && !sessionRef.sessionPath) return 0;
    let removed = 0;
    for (const [id, e] of this._entries) {
      if (matchesSession(e, sessionRef)) {
        this._entries.delete(id);
        removed++;
      }
    }
    if (removed) this._save();
    return removed;
  }

  /**
   * 删除早于 maxAgeMs 的 entry（按 finishedAt，回退 startedAt）。nowMs 由调用方传入
   * （服务端 Date.now()，测试可注入），返回删除条数。与 session 72h 冷清理对齐。
   */
  prune(maxAgeMs: number, nowMs: number) {
    if (!Number.isFinite(maxAgeMs) || !Number.isFinite(nowMs)) return 0;
    const cutoff = nowMs - maxAgeMs;
    let removed = 0;
    for (const [id, e] of this._entries) {
      const ts = Number.isFinite(e.finishedAt)
        ? e.finishedAt
        : (Number.isFinite(e.startedAt) ? e.startedAt : null);
      if (ts != null && ts < cutoff) {
        this._entries.delete(id);
        removed++;
      }
    }
    if (removed) this._save();
    return removed;
  }

  get size() {
    return this._entries.size;
  }

  _save() {
    if (!this._persistPath) return;
    const data = {
      schemaVersion: WORKFLOW_ACTIVITY_STORE_VERSION,
      entries: Object.fromEntries(this._entries.entries()),
    };
    fs.mkdirSync(path.dirname(this._persistPath), { recursive: true });
    atomicWriteSync(this._persistPath, JSON.stringify(data, null, 2) + "\n");
  }

  _load() {
    if (!this._persistPath || !fs.existsSync(this._persistPath)) return;
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(this._persistPath, "utf-8"));
    } catch {
      // 损坏文件不崩：按空账本起步，下次 _save 覆盖。
      return;
    }
    const entries = raw?.entries && typeof raw.entries === "object" ? raw.entries : {};
    for (const [id, value] of Object.entries(entries)) {
      if (!id || !value || typeof value !== "object") continue;
      this._entries.set(id, { ...value, id });
    }
  }
}
