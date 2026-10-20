// 跨 session 协作草稿卡的 one-shot 存储。对齐 AutomationSuggestionStore 语义：
// 一般 apply 失败保留条目供重试；若创建已部分成功则把原草稿切换成仅重试首条消息。
export type SessionCollabDraftKind = "send" | "create";

export interface SessionCollabDraftInput {
  kind: SessionCollabDraftKind;
  sourceSessionId: string;
  sourceSessionPath?: string | null;
  draft: Record<string, unknown>;
  apply: (editedDraft?: Record<string, unknown>) => unknown;
}

export class SessionCollabPartialSuccessError extends Error {
  readonly code = "first_message_failed";
  readonly partialSuccess = true;
  readonly sessionId: string;
  readonly result: {
    sessionId: string;
    sessionCreated: true;
    firstMessageAccepted: false;
    retryMessage: string;
    retryable: boolean;
  };
  readonly retry?: (editedDraft?: Record<string, unknown>) => unknown;

  constructor(
    sessionId: string,
    cause: unknown,
    retryMessage: string,
    retry?: (editedDraft?: Record<string, unknown>) => unknown,
  ) {
    const detail = (cause as any)?.message || String(cause);
    super(`first_message_failed:${sessionId}:${detail}`);
    this.name = "SessionCollabPartialSuccessError";
    this.sessionId = sessionId;
    this.result = {
      sessionId,
      sessionCreated: true,
      firstMessageAccepted: false,
      retryMessage,
      retryable: typeof retry === "function",
    };
    this.retry = retry;
    (this as any).cause = cause;
  }
}

export function isSessionCollabPartialSuccessError(error: unknown): error is SessionCollabPartialSuccessError {
  const candidate = error as any;
  return candidate?.partialSuccess === true
    && candidate?.code === "first_message_failed"
    && typeof candidate?.sessionId === "string"
    && !!candidate.sessionId;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function collectSuggestionIds(value: unknown, out = new Set<string>(), seen = new Set<object>()) {
  if (!value || typeof value !== "object") return out;
  if (seen.has(value as object)) return out;
  seen.add(value as object);
  if (Array.isArray(value)) {
    for (const item of value) collectSuggestionIds(item, out, seen);
    return out;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === "suggestionId") {
      const suggestionId = text(child);
      if (suggestionId) out.add(suggestionId);
    }
    collectSuggestionIds(child, out, seen);
  }
  return out;
}

export class SessionCollabDraftStore {
  declare _entries: Map<string, any>;
  declare _sequence: number;

  constructor() {
    this._entries = new Map();
    this._sequence = 0;
  }

  create(input: SessionCollabDraftInput) {
    if (!input || typeof input.apply !== "function") {
      throw new Error("session collab draft apply function is required");
    }
    if (typeof input.sourceSessionId !== "string" || !input.sourceSessionId.trim()) {
      throw new Error("session collab draft sourceSessionId is required");
    }
    const suggestionId = `session_${Date.now().toString(36)}_${(++this._sequence).toString(36)}`;
    const stored = {
      suggestionId,
      kind: input.kind === "create" ? "create" : "send",
      sourceSessionId: input.sourceSessionId.trim(),
      sourceSessionPath: text(input.sourceSessionPath),
      draft: JSON.parse(JSON.stringify(input.draft || {})),
      apply: input.apply,
      createdAt: Date.now(),
    };
    this._entries.set(suggestionId, stored);
    return this._publicEntry(stored);
  }

  get(suggestionId: string) {
    const entry = this._entries.get(suggestionId);
    return entry ? this._publicEntry(entry) : null;
  }

  listForSession(sourceSessionId: string) {
    return [...this._entries.values()]
      .filter((e) => e.sourceSessionId === sourceSessionId)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((e) => this._publicEntry(e));
  }

  /**
   * Clone only still-pending draft handles referenced by the retained fork
   * branch. The cloned handle keeps the same inert draft/apply closure but owns
   * a fresh suggestionId and child session identity, so either branch can make
   * its decision without consuming or updating the other branch.
   */
  forkSessionDrafts({
    sourceSessionId,
    targetSessionId,
    targetSessionPath = null,
    retainedEntries = [],
  }: {
    sourceSessionId: string;
    targetSessionId: string;
    targetSessionPath?: string | null;
    retainedEntries?: unknown[];
  }) {
    const sourceId = text(sourceSessionId);
    const targetId = text(targetSessionId);
    if (!sourceId) throw new Error("sourceSessionId is required to fork session drafts");
    if (!targetId) throw new Error("targetSessionId is required to fork session drafts");
    if (sourceId === targetId) throw new Error("forked session drafts require a distinct targetSessionId");

    const referencedIds = collectSuggestionIds(retainedEntries);
    const createdIds: string[] = [];
    const suggestionIdMap: Record<string, string> = {};
    try {
      for (const suggestionId of referencedIds) {
        const source = this._entries.get(suggestionId);
        if (!source || source.sourceSessionId !== sourceId) continue;
        if (source._applying) {
          throw new Error(`session collab draft is being applied: ${suggestionId}`);
        }
        const cloned = this.create({
          kind: source.kind,
          sourceSessionId: targetId,
          sourceSessionPath: targetSessionPath,
          draft: source.draft,
          apply: source.apply,
        });
        const stored = this._entries.get(cloned.suggestionId);
        if (stored) {
          stored.createdAt = source.createdAt;
          stored.forkedFromSuggestionId = suggestionId;
        }
        createdIds.push(cloned.suggestionId);
        suggestionIdMap[suggestionId] = cloned.suggestionId;
      }
    } catch (error) {
      this.discardForkedSessionDrafts({ suggestionIds: createdIds });
      throw error;
    }
    return {
      drafts: createdIds.length,
      suggestionIds: createdIds,
      suggestionIdMap,
    };
  }

  discardForkedSessionDrafts({ suggestionIds = [] }: { suggestionIds?: string[] } = {}) {
    let discarded = 0;
    for (const suggestionId of suggestionIds) {
      const entry = this._entries.get(suggestionId);
      if (!entry || entry._applying) continue;
      this._entries.delete(suggestionId);
      discarded += 1;
    }
    return { discarded };
  }

  discard(suggestionId: string) {
    const entry = this._entries.get(suggestionId);
    if (!entry || entry._applying) return null;
    this._entries.delete(suggestionId);
    return this._publicEntry(entry);
  }

  async apply(suggestionId: string, editedDraft?: Record<string, unknown>) {
    const entry = this._entries.get(suggestionId);
    if (!entry) return { ok: false as const, reason: "not-found" as const };
    if (entry._applying) return { ok: false as const, reason: "in-flight" as const };
    entry._applying = true;
    try {
      const result = await entry.apply(editedDraft);
      this._entries.delete(suggestionId);
      return { ok: true as const, result };
    } catch (error) {
      // 创建已发生但首条消息未被接受时，原创建闭包不能再重放，否则会再建
      // 一个空 session。只替换当前草稿的闭包，fork 出去的其它条目不会共享状态。
      if (isSessionCollabPartialSuccessError(error)) {
        if (typeof error.retry === "function") {
          entry.apply = error.retry;
          entry.partialResult = error.result;
        } else {
          this._entries.delete(suggestionId);
        }
      }
      throw error;
    } finally {
      // 失败路径清标记让用户可重试；成功路径条目已删，清标记无副作用
      entry._applying = false;
    }
  }

  _publicEntry(entry: any) {
    const { apply: _apply, _applying: _inFlight, ...rest } = entry;
    return { ...rest, draft: JSON.parse(JSON.stringify(entry.draft)) };
  }
}
