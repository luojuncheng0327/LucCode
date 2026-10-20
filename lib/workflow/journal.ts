import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/**
 * Workflow 断点恢复日志。
 *
 * 按 nodeSeq 记录每个 agent() 调用的 cache key（prompt + opts hash）→ result。
 * resume 时按序比对：同位置 key 匹配 → 返回缓存；首个不匹配 → 该位置及之后全部重跑。
 *
 * 文件格式：JSONL（每行一个 JSON 对象），按完成顺序追加。
 * 加载时按 nodeSeq 索引到 Map，顺序由 nodeSeq 字段保证。
 */
export class WorkflowJournal {
  declare _path: string | null;
  declare _entries: Map<number, { key: string; result: any; status: string; ts: number }>;
  declare _invalidatedAfter: number;
  declare _replayHits: number;

  /**
   * @param {string|null} journalPath  JSONL 文件路径；null = 纯内存（不持久化）
   */
  constructor(journalPath) {
    this._path = journalPath || null;
    /** @type {Map<number, { key: string, result: any, status: string, ts: number }>} */
    this._entries = new Map();
    this._invalidatedAfter = Infinity;
    this._replayHits = 0;
  }

  /**
   * 计算 agent() 调用的 cache key：sha256(prompt + sanitized opts) 取前 16 hex。
   * 只保留可序列化、确定性的字段（跳过 signal / 函数 / onSessionReady）。
   */
  static computeKey(prompt, opts) {
    const sanitized = {};
    if (opts && typeof opts === "object") {
      for (const [k, v] of Object.entries(opts)) {
        if (typeof v === "function") continue;
        if (k === "signal" || k === "onSessionReady") continue;
        sanitized[k] = v;
      }
    }
    const payload = JSON.stringify({ p: prompt, o: sanitized });
    return crypto.createHash("sha256").update(payload).digest("hex").slice(0, 16);
  }

  /**
   * 从旧 run 的 JSONL 文件加载 journal（用于 resume）。
   * 文件不存在或损坏 → 返回空 journal（等价于全部重跑）。
   */
  static load(journalPath) {
    const journal = new WorkflowJournal(journalPath);
    if (!journalPath) return journal;
    try {
      if (!fs.existsSync(journalPath)) return journal;
      const lines = fs.readFileSync(journalPath, "utf-8").split("\n").filter(Boolean);
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (typeof entry.nodeSeq === "number") {
            journal._entries.set(entry.nodeSeq, entry);
          }
        } catch { /* skip malformed line */ }
      }
    } catch { /* corrupt file → fresh journal */ }
    return journal;
  }

  /**
   * 尝试从缓存返回结果。
   * @param {number} nodeSeq  当前 agent() 的序号（1-based）
   * @param {string} key      computeKey 的结果
   * @returns {{ hit: true, result: any } | null}
   */
  tryReplay(nodeSeq, key) {
    if (nodeSeq > this._invalidatedAfter) return null;
    const entry = this._entries.get(nodeSeq);
    if (!entry || entry.key !== key) {
      this._invalidatedAfter = nodeSeq - 1;
      return null;
    }
    if (entry.status !== "ok") {
      this._invalidatedAfter = nodeSeq - 1;
      return null;
    }
    this._replayHits++;
    return { hit: true, result: entry.result };
  }

  /**
   * 记录一个 agent() 调用的结果（缓存命中时也应调用以写入当前 run 的 journal）。
   *
   * extra 是归因附加字段（error 消息、attempts 重试次数）。写侧自由扩展，读侧
   * （load / tryReplay）只认 nodeSeq/key/result/status，未知字段天然忽略——
   * 老 journal 没有这些字段照样能 resume，新 journal 被老代码读也不会炸。
   * @param {{ error?: string, attempts?: number }} [extra]
   */
  record(nodeSeq, key, result, status = "ok", extra: Record<string, any> = {}) {
    const entry = {
      nodeSeq, key, result, status, ts: Date.now(),
      ...(extra && typeof extra === "object" && !Array.isArray(extra) ? extra : {}),
    };
    this._entries.set(nodeSeq, entry);
    this._appendLine(entry);
  }

  _appendLine(entry) {
    if (!this._path) return;
    try {
      fs.mkdirSync(path.dirname(this._path), { recursive: true });
      fs.appendFileSync(this._path, JSON.stringify(entry) + "\n");
    } catch { /* best effort */ }
  }

  get replayHits() { return this._replayHits; }
  get totalEntries() { return this._entries.size; }
  get hasEntries() { return this._entries.size > 0; }
}
