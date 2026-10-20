/**
 * InputDraftsStore — 输入框草稿落盘（{LUC_HOME}/input-drafts.v1.json）
 *
 * 独立于 preferences.json：草稿是高频写入的用户内容，不混进配置。
 * build-to-delete：删除本文件 + shared/input-drafts.ts + server/routes/input-drafts.ts
 * 及 engine 上的四个委托方法，即可整块移除该功能。
 */
import fs from "fs";
import path from "path";
import { atomicWriteSync } from "../shared/safe-fs.ts";
import {
  INPUT_DRAFT_SURFACES,
  normalizeInputDraftEntry,
  normalizeInputDraftsFile,
  upsertSurfaceSessionDrafts,
} from "../shared/input-drafts.ts";
import { createModuleLogger } from "../lib/debug-log.ts";

const log = createModuleLogger("input-drafts");

export class InputDraftsStore {
  declare _path: string;
  declare _cache: any;

  constructor({ lucHome }) {
    if (!lucHome) throw new Error("InputDraftsStore requires lucHome");
    this._path = path.join(lucHome, "input-drafts.v1.json");
    this._cache = null;
  }

  _load() {
    if (this._cache) return this._cache;
    let raw = null;
    if (fs.existsSync(this._path)) {
      try {
        raw = JSON.parse(fs.readFileSync(this._path, "utf8"));
      } catch (err) {
        // 损坏文件重命名留证后从空重建，不静默覆盖证据，不阻塞启动
        const quarantine = `${this._path}.corrupt-${Date.now()}`;
        try {
          fs.renameSync(this._path, quarantine);
          log.error(`input drafts file corrupt, moved aside to ${path.basename(quarantine)}: ${err?.message || err}`);
        } catch (renameErr) {
          log.error(`input drafts file corrupt and quarantine failed: ${renameErr?.message || renameErr}`);
        }
        raw = null;
      }
    }
    this._cache = normalizeInputDraftsFile(raw);
    return this._cache;
  }

  _save() {
    fs.mkdirSync(path.dirname(this._path), { recursive: true });
    atomicWriteSync(this._path, JSON.stringify(this._cache));
  }

  /** surface 必须已由调用方（route）归一化 */
  getAll(surface) {
    const data = this._load();
    const bucket = data.surfaces[surface];
    return { home: bucket?.home || null, sessions: { ...(bucket?.sessions || {}) } };
  }

  setHome(surface, rawEntry) {
    const data = this._load();
    data.surfaces[surface].home = normalizeInputDraftEntry(rawEntry);
    this._save();
  }

  setSession(surface, sessionId, rawEntry) {
    const data = this._load();
    const entry = normalizeInputDraftEntry(rawEntry);
    data.surfaces[surface].sessions = upsertSurfaceSessionDrafts(
      data.surfaces[surface].sessions,
      sessionId,
      entry,
    );
    this._save();
  }

  /** session 永久删除时清掉所有 surface 下的草稿 */
  deleteSession(sessionId) {
    if (typeof sessionId !== "string" || !sessionId.trim()) return;
    const data = this._load();
    let changed = false;
    for (const surface of INPUT_DRAFT_SURFACES) {
      if (data.surfaces[surface].sessions[sessionId]) {
        data.surfaces[surface].sessions = upsertSurfaceSessionDrafts(
          data.surfaces[surface].sessions,
          sessionId,
          null,
        );
        changed = true;
      }
    }
    if (changed) this._save();
  }
}
