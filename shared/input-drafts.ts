/**
 * 输入框草稿持久化 —— 共享归一化（server 与前端共用）
 *
 * surface 白名单是唯一扩展点；新增客户端时在这里声明，server 与 renderer
 * 共用同一套校验，避免各自接受不同的持久化键空间。
 */

export const INPUT_DRAFT_SURFACES = Object.freeze(["electron", "pwa"]);
export const HOME_DRAFT_KEY = "__home__";
/** 单条草稿序列化字符数上限（约 512K；中文按 JSON 转义后字符计，近似值即可） */
export const INPUT_DRAFT_MAX_ENTRY_CHARS = 512 * 1024;
export const INPUT_DRAFT_MAX_SESSIONS_PER_SURFACE = 200;

const INPUT_DRAFT_SURFACE_SET = new Set(INPUT_DRAFT_SURFACES);

export function normalizeInputDraftSurface(value: any) {
  return typeof value === "string" && INPUT_DRAFT_SURFACE_SET.has(value) ? value : null;
}

function serializedChars(entry: any) {
  try {
    return JSON.stringify(entry).length;
  } catch {
    return Infinity;
  }
}

/** 归一化单条草稿；空文本/非法输入返回 null（语义 = 删除该条目） */
export function normalizeInputDraftEntry(raw: any) {
  if (!raw || typeof raw !== "object") return null;
  const text = typeof raw.text === "string" ? raw.text : "";
  if (!text.trim()) return null;
  const doc = raw.doc && typeof raw.doc === "object" && !Array.isArray(raw.doc) ? raw.doc : undefined;
  const updatedAt = Number.isFinite(raw.updatedAt) ? raw.updatedAt : Date.now();
  let entry = doc ? { text, doc, updatedAt } : { text, updatedAt };
  // 超限先丢 doc（恢复时前端用纯文本重建富文本），text 仍超限则截断落盘。
  // 内存中的草稿始终完整，截断只影响落盘影子——明确的设计取舍，见 spec §4。
  if (doc && serializedChars(entry) > INPUT_DRAFT_MAX_ENTRY_CHARS) {
    entry = { text, updatedAt };
  }
  if (serializedChars(entry) > INPUT_DRAFT_MAX_ENTRY_CHARS) {
    entry = { text: text.slice(0, INPUT_DRAFT_MAX_ENTRY_CHARS), updatedAt };
  }
  return entry;
}

/** upsert 一条 session 草稿；entry 为 null 即删除；超过上限按 updatedAt 淘汰最旧 */
export function upsertSurfaceSessionDrafts(sessions: any, sessionId: any, entry: any) {
  const next: Record<string, any> = { ...(sessions && typeof sessions === "object" ? sessions : {}) };
  if (!entry) {
    delete next[sessionId];
    return next;
  }
  next[sessionId] = entry;
  const ids = Object.keys(next);
  if (ids.length > INPUT_DRAFT_MAX_SESSIONS_PER_SURFACE) {
    ids.sort((a, b) => (next[a]?.updatedAt || 0) - (next[b]?.updatedAt || 0));
    while (ids.length > INPUT_DRAFT_MAX_SESSIONS_PER_SURFACE) {
      const oldest = ids.shift();
      if (oldest !== undefined) delete next[oldest];
    }
  }
  return next;
}

/** 归一化整个落盘文件；任何垃圾输入都归一化为合法空结构 */
export function normalizeInputDraftsFile(raw: any) {
  const surfaces: Record<string, any> = {};
  for (const surface of INPUT_DRAFT_SURFACES) {
    const source = raw?.surfaces?.[surface];
    const home = normalizeInputDraftEntry(source?.home);
    let sessions: Record<string, any> = {};
    const entries = source?.sessions && typeof source.sessions === "object"
      ? Object.entries(source.sessions)
      : [];
    for (const [sessionId, value] of entries) {
      if (typeof sessionId !== "string" || !sessionId.trim()) continue;
      const entry = normalizeInputDraftEntry(value);
      if (entry) sessions = upsertSurfaceSessionDrafts(sessions, sessionId, entry);
    }
    surfaces[surface] = { home, sessions };
  }
  return { version: 1, surfaces };
}
