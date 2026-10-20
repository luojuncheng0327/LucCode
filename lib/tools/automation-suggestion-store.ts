import { issueAutomationSuggestionReceipt } from "../desk/automation-suggestion-receipt.ts";

function clonePlain<T>(value: T): T {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value)) as T;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function defaultShortCode() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

const DEFAULT_SUGGESTION_TTL_MS = 15 * 60 * 1000;

export class AutomationSuggestionStore {
  declare _entries: Map<string, any>;
  declare _generateShortCode: () => string;
  declare _now: () => number;
  declare _sequence: number;
  declare _ttlMs: number;

  constructor({
    generateShortCode = defaultShortCode,
    now = () => Date.now(),
    ttlMs = DEFAULT_SUGGESTION_TTL_MS,
  }: {
    generateShortCode?: () => string;
    now?: () => number;
    ttlMs?: number;
  } = {}) {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error("automation suggestion ttlMs must be positive");
    this._entries = new Map();
    this._generateShortCode = generateShortCode;
    this._now = now;
    this._sequence = 0;
    this._ttlMs = ttlMs;
  }

  create(entry: {
    sessionId?: string | null;
    sessionPath?: string | null;
    bridgeSessionKey?: string | null;
    studioId?: string | null;
    operation?: "create" | "update";
    jobId?: string | null;
    baseConfigRevision?: number | null;
    jobData: Record<string, unknown>;
    apply: (value?: unknown, confirmation?: { suggestionId: string; confirmedAt: string; receipt: object }) => unknown;
  }) {
    if (!entry || typeof entry !== "object") throw new Error("automation suggestion entry is required");
    if (typeof entry.apply !== "function") throw new Error("automation suggestion apply function is required");
    const sessionId = text(entry.sessionId) || null;
    const bridgeSessionKey = text(entry.bridgeSessionKey) || null;
    if (!sessionId && !bridgeSessionKey) {
      throw new Error("automation suggestion requires a stable sessionId or bridgeSessionKey");
    }
    // Suggestions retain an apply closure. Prune expired entries before
    // allocating a new code so abandoned confirmations cannot leak closures or
    // permanently consume the small human-readable shortcode namespace.
    this._pruneExpired();
    const suggestionId = `automation_${Date.now().toString(36)}_${(++this._sequence).toString(36)}`;
    const shortCode = this._nextShortCode();
    const createdAt = this._now();
    const operation = entry.operation === "update" ? "update" : "create";
    const jobId = text(entry.jobId) || null;
    const baseConfigRevision = Number.isSafeInteger(entry.baseConfigRevision)
      && Number(entry.baseConfigRevision) > 0
      ? Number(entry.baseConfigRevision)
      : null;
    if (operation === "update" && (!jobId || !baseConfigRevision)) {
      throw new Error("update automation suggestion requires jobId and baseConfigRevision");
    }
    const stored = {
      suggestionId,
      shortCode,
      sessionId,
      sessionPath: text(entry.sessionPath) || null,
      bridgeSessionKey,
      studioId: text(entry.studioId) || null,
      operation,
      jobId,
      baseConfigRevision,
      jobData: clonePlain(entry.jobData || {}),
      apply: entry.apply,
      applying: false,
      createdAt,
      expiresAt: createdAt + this._ttlMs,
    };
    this._entries.set(suggestionId, stored);
    return this._publicEntry(stored);
  }

  get(ref: string) {
    this._pruneExpired();
    const normalizedRef = text(ref);
    const entry = normalizedRef
      ? [...this._entries.values()].find((candidate) => (
        candidate.shortCode === normalizedRef
        || candidate.suggestionId === normalizedRef
      )) || null
      : null;
    return entry ? this._publicEntry(entry) : null;
  }

  list(filter: { sessionId?: string | null; sessionPath?: string | null; bridgeSessionKey?: string | null; studioId?: string | null } = {}) {
    this._pruneExpired();
    return [...this._entries.values()]
      .filter((entry) => this._matchesScope(entry, filter))
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((entry) => this._publicEntry(entry));
  }

  async apply({
    sessionId = null,
    sessionPath = null,
    bridgeSessionKey = null,
    studioId = null,
    ref = null,
    value = undefined,
  }: {
    sessionId?: string | null;
    sessionPath?: string | null;
    bridgeSessionKey?: string | null;
    studioId?: string | null;
    ref?: string | null;
    value?: unknown;
  } = {}) {
    const entry = this._find({ sessionId, sessionPath, bridgeSessionKey, studioId, ref });
    if (!entry) return { ok: false, reason: "not-found" };
    if (entry.expiresAt <= this._now()) {
      this._entries.delete(entry.suggestionId);
      return { ok: false, reason: "expired" };
    }
    if (entry.applying) return { ok: false, reason: "already-applying" };
    entry.applying = true;
    try {
      const confirmedAt = new Date(this._now()).toISOString();
      const receipt = issueAutomationSuggestionReceipt({
        suggestionId: entry.suggestionId,
        confirmedAt,
        expiresAt: entry.expiresAt,
        studioId: entry.studioId,
        operation: entry.operation,
        jobId: entry.jobId,
        baseConfigRevision: entry.baseConfigRevision,
      }, { now: this._now });
      const result = await entry.apply(value, {
        suggestionId: entry.suggestionId,
        confirmedAt,
        receipt,
      });
      this._entries.delete(entry.suggestionId);
      return {
        ok: true,
        suggestion: this._publicEntry(entry),
        result,
      };
    } catch (err) {
      entry.applying = false;
      throw err;
    }
  }

  _nextShortCode() {
    for (let i = 0; i < 200; i += 1) {
      const code = text(this._generateShortCode()) || defaultShortCode();
      if (![...this._entries.values()].some((entry) => entry.shortCode === code)) return code;
    }
    return String(10000 + this._sequence);
  }

  _find({ sessionId = null, sessionPath = null, bridgeSessionKey = null, studioId = null, ref = null }: {
    sessionId?: string | null;
    sessionPath?: string | null;
    bridgeSessionKey?: string | null;
    studioId?: string | null;
    ref?: string | null;
  }) {
    const scope = { sessionId, sessionPath, bridgeSessionKey, studioId };
    const candidates = [...this._entries.values()]
      .filter((entry) => this._matchesScope(entry, scope))
      .sort((a, b) => b.createdAt - a.createdAt);
    if (!candidates.length) return null;
    const normalizedRef = text(ref);
    if (!normalizedRef) return candidates[0];
    return candidates.find((entry) => (
      entry.shortCode === normalizedRef
      || entry.suggestionId === normalizedRef
    )) || null;
  }

  _matchesScope(entry: any, filter: { sessionId?: string | null; sessionPath?: string | null; bridgeSessionKey?: string | null; studioId?: string | null }) {
    const studioId = text(filter.studioId);
    // A Studio-bound suggestion can only be consumed by a caller that proves
    // the same current Studio. Omitting the filter must not turn Studio into an
    // optional part of the identity.
    if (entry.studioId && entry.studioId !== studioId) return false;
    if (studioId && entry.studioId !== studioId) return false;
    const bridgeSessionKey = text(filter.bridgeSessionKey);
    if (bridgeSessionKey) return entry.bridgeSessionKey === bridgeSessionKey;
    const sessionId = text(filter.sessionId);
    if (sessionId) return entry.sessionId === sessionId;
    return false;
  }

  _publicEntry(entry: any) {
    return {
      suggestionId: entry.suggestionId,
      shortCode: entry.shortCode,
      sessionId: entry.sessionId,
      sessionPath: entry.sessionPath,
      bridgeSessionKey: entry.bridgeSessionKey,
      studioId: entry.studioId,
      operation: entry.operation,
      jobId: entry.jobId,
      baseConfigRevision: entry.baseConfigRevision,
      jobData: clonePlain(entry.jobData),
      createdAt: entry.createdAt,
      expiresAt: entry.expiresAt,
    };
  }

  _pruneExpired() {
    const now = this._now();
    for (const [suggestionId, entry] of this._entries) {
      if (entry.expiresAt <= now && entry.applying !== true) this._entries.delete(suggestionId);
    }
  }
}
