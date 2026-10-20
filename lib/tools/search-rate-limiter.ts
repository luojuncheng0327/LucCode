
const DEFAULT_RETRY_JITTER_MS = 1_000;

const DEFAULT_POLICIES = Object.freeze({
  anysearch: Object.freeze({
    minIntervalMs: 0,
    jitterMs: 0,
    maxConcurrent: 5,
    rateLimitBaseDelayMs: 2_000,
    retryJitterMs: DEFAULT_RETRY_JITTER_MS,
    maxCooldownMs: 5 * 60_000,
  }),
  anysearch_free: Object.freeze({
    minIntervalMs: 0,
    jitterMs: 0,
    maxConcurrent: 3,
    rateLimitBaseDelayMs: 10_000,
    retryJitterMs: DEFAULT_RETRY_JITTER_MS,
    maxCooldownMs: 5 * 60_000,
  }),
  bing_browser: Object.freeze({
    minIntervalMs: 3_000,
    jitterMs: 4_000,
    rateLimitBaseDelayMs: 10_000,
    retryJitterMs: DEFAULT_RETRY_JITTER_MS,
    maxCooldownMs: 5 * 60_000,
  }),
  duckduckgo_browser: Object.freeze({
    minIntervalMs: 3_000,
    jitterMs: 4_000,
    rateLimitBaseDelayMs: 10_000,
    retryJitterMs: DEFAULT_RETRY_JITTER_MS,
    maxCooldownMs: 5 * 60_000,
  }),
  google_browser: Object.freeze({
    minIntervalMs: 6_000,
    jitterMs: 8_000,
    rateLimitBaseDelayMs: 30_000,
    retryJitterMs: DEFAULT_RETRY_JITTER_MS,
    maxCooldownMs: 10 * 60_000,
  }),
  brave: Object.freeze({
    minIntervalMs: 1_100,
    jitterMs: 400,
    rateLimitBaseDelayMs: 2_000,
    retryJitterMs: DEFAULT_RETRY_JITTER_MS,
    maxCooldownMs: 5 * 60_000,
  }),
  tavily: Object.freeze({
    minIntervalMs: 650,
    jitterMs: 350,
    rateLimitBaseDelayMs: 2_000,
    retryJitterMs: DEFAULT_RETRY_JITTER_MS,
    maxCooldownMs: 5 * 60_000,
  }),
  serper: Object.freeze({
    minIntervalMs: 1_000,
    jitterMs: 500,
    rateLimitBaseDelayMs: 2_000,
    retryJitterMs: DEFAULT_RETRY_JITTER_MS,
    maxCooldownMs: 5 * 60_000,
  }),
});

const FALLBACK_POLICIES = Object.freeze({
  browser: Object.freeze({
    minIntervalMs: 3_000,
    jitterMs: 4_000,
    rateLimitBaseDelayMs: 10_000,
    retryJitterMs: DEFAULT_RETRY_JITTER_MS,
    maxCooldownMs: 5 * 60_000,
  }),
  api: Object.freeze({
    minIntervalMs: 1_000,
    jitterMs: 500,
    rateLimitBaseDelayMs: 2_000,
    retryJitterMs: DEFAULT_RETRY_JITTER_MS,
    maxCooldownMs: 5 * 60_000,
  }),
});

function positiveInteger(value: any) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

function positiveConcurrency(value: any) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.floor(n);
}

export function retryAfterMsFromHeaders(headers: any) {
  if (!headers) return null;
  const raw = headers.get?.("retry-after") || headers.get?.("Retry-After");
  if (!raw) return null;

  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.floor(seconds * 1_000);
  }

  const retryAt = Date.parse(raw);
  if (!Number.isFinite(retryAt)) return null;
  return Math.max(0, retryAt - Date.now());
}

export class SearchRateLimitError extends Error {
  declare status: number;
  declare retryAfterMs: any;
  declare isSearchRateLimitError: boolean;

  constructor(message: any, { retryAfterMs = null, status = 429 }: { retryAfterMs?: any; status?: number } = {}) {
    super(message);
    this.name = "SearchRateLimitError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    this.isSearchRateLimitError = true;
  }
}

export class SearchRateLimiter {
  declare _policies: Record<string, any>;
  declare _random: () => number;
  declare _states: Map<string, any>;

  constructor({ policies = {}, random = Math.random }: { policies?: Record<string, any>; random?: () => number } = {}) {
    this._policies = { ...DEFAULT_POLICIES, ...policies };
    this._random = random;
    this._states = new Map();
  }

  reset() {
    for (const state of this._states.values()) {
      if (state.pumpTimer) clearTimeout(state.pumpTimer);
    }
    this._states.clear();
  }

  async run(provider: any, sourceType: any, operation: any) {
    const key = String(provider || sourceType || "search");
    const state = this._stateFor(key);
    return new Promise((resolve, reject) => {
      state.queue.push({ sourceType, operation, resolve, reject });
      this._pump(key);
    });
  }

  _stateFor(key: string) {
    let state = this._states.get(key);
    if (!state) {
      state = {
        queue: [],
        activeCount: 0,
        pumpTimer: null,
        lastStartAt: null,
        nextStartAt: 0,
        cooldownUntil: 0,
        rateLimitFailures: 0,
      };
      this._states.set(key, state);
    }
    return state;
  }

  _policy(provider: any, sourceType: any) {
    return this._policies[provider]
      || FALLBACK_POLICIES[sourceType]
      || FALLBACK_POLICIES.api;
  }

  _jitter(maxMs: any) {
    const max = positiveInteger(maxMs);
    if (max <= 0) return 0;
    return Math.floor(this._random() * max);
  }

  _maxConcurrent(provider: any, sourceType: any) {
    return positiveConcurrency(this._policy(provider, sourceType).maxConcurrent);
  }

  _nextStartDelay(provider: any, sourceType: any) {
    const state = this._stateFor(provider);
    const now = Date.now();
    const waitUntil = Math.max(state.nextStartAt || 0, state.cooldownUntil || 0);
    return Math.max(0, waitUntil - now);
  }

  _schedulePump(provider: any, sourceType: any, delayMs: any) {
    const state = this._stateFor(provider);
    if (state.pumpTimer) return;
    state.pumpTimer = setTimeout(() => {
      state.pumpTimer = null;
      this._pump(provider, sourceType);
    }, delayMs);
  }

  _pump(provider: any, sourceType?: any) {
    const state = this._stateFor(provider);
    if (state.queue.length === 0) return;

    while (state.queue.length > 0) {
      const task = state.queue[0];
      const sourceType = task.sourceType;
      if (state.activeCount >= this._maxConcurrent(provider, sourceType)) return;

      const delayMs = this._nextStartDelay(provider, sourceType);
      if (delayMs > 0) {
        this._schedulePump(provider, sourceType, delayMs);
        return;
      }

      state.queue.shift();
      this._startTask(provider, task);
    }
  }

  _startTask(provider: any, task: any) {
    const state = this._stateFor(provider);
    const sourceType = task.sourceType;
    state.activeCount += 1;
    state.lastStartAt = Date.now();
    const policy = this._policy(provider, sourceType);
    state.nextStartAt = state.lastStartAt
      + positiveInteger(policy.minIntervalMs)
      + this._jitter(policy.jitterMs);
    if (state.cooldownUntil && state.cooldownUntil <= state.lastStartAt) {
      state.cooldownUntil = 0;
    }

    Promise.resolve()
      .then(task.operation)
      .then((result) => {
        state.rateLimitFailures = 0;
        task.resolve(result);
      })
      .catch((err) => {
        this._recordRateLimit(provider, sourceType, err);
        task.reject(err);
      })
      .finally(() => {
        state.activeCount = Math.max(0, state.activeCount - 1);
        this._pump(provider);
      });
  }

  _recordRateLimit(provider: any, sourceType: any, err: any) {
    if (!err?.isSearchRateLimitError && err?.status !== 429) return;

    const state = this._stateFor(provider);
    const policy = this._policy(provider, sourceType);
    const retryAfter = err?.retryAfterMs == null ? null : Number(err.retryAfterMs);
    const hasRetryAfter = Number.isFinite(retryAfter) && retryAfter >= 0;
    const baseCooldownMs = hasRetryAfter
      ? Math.floor(retryAfter)
      : positiveInteger(policy.rateLimitBaseDelayMs) * (2 ** Math.min(state.rateLimitFailures, 8));
    const cooldownMs = Math.min(
      positiveInteger(policy.maxCooldownMs),
      baseCooldownMs + this._jitter(policy.retryJitterMs),
    );
    state.rateLimitFailures += 1;
    state.cooldownUntil = Math.max(state.cooldownUntil || 0, Date.now() + cooldownMs);
  }
}

export function createSearchRateLimiter(opts = {}) {
  return new SearchRateLimiter(opts);
}
