import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeLlmUsage, flattenNormalizedUsage, buildUsageDebugRecord, logLlmUsage } from "../lib/llm/usage-observer.ts";
import { createUsageLedger } from "../lib/llm/usage-ledger.ts";

test("missing-field mode preserves nulls while the default normalizer keeps compatibility", () => {
  assert.equal(normalizeLlmUsage(null), null);
  assert.equal(normalizeLlmUsage({}).totalTokens, 0);
  const partial = normalizeLlmUsage({ input: null, output_tokens: 4, cacheRead: false, cacheWrite: "" }, { preserveMissingFields: true });
  assert.equal(partial.input.totalTokens, null);
  assert.equal(partial.totalTokens, null);
  assert.equal(partial.cache.readTokens, null);
  assert.equal(partial.cache.hit, null);
  assert.equal(partial.cache.created, null);
  const invalid = normalizeLlmUsage({ input: "invalid", output: 2, totalTokens: NaN }, { preserveMissingFields: true });
  assert.equal(invalid.totalTokens, null);
});

test("provider token and cache semantics retain their explicit denominators", () => {
  const anthropic = normalizeLlmUsage({ input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 3, cache_creation: { ephemeral_5m_input_tokens: 4, ephemeral_1h_input_tokens: 5 } }, { preserveMissingFields: true, costRates: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } });
  assert.equal(anthropic.totalTokens, 24);
  assert.equal(anthropic.input.uncachedTokens, 10);
  assert.equal(anthropic.cache.hitRatio, 3 / 22);
  assert.ok(Math.abs(anthropic.costTotal - 59 / 1_000_000) < 1e-15);
  const openai = normalizeLlmUsage({ prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 3 }, reasoning_tokens: 1 });
  assert.equal(openai.totalTokens, 12);
  assert.equal(openai.input.uncachedTokens, 7);
  assert.equal(openai.cache.hitRatio, 0.3);
  const responses = normalizeLlmUsage({ input_tokens: 6, output_tokens: 1, input_tokens_details: { cached_tokens: 2 }, prompt_cache_miss_tokens: 4, cost: { total: 1.2 } }, { preserveMissingFields: true });
  assert.equal(responses.totalTokens, 7);
  assert.equal(responses.input.uncachedTokens, 4);
  assert.equal(responses.costTotal, 1.2);
  for (const cacheSupport of ["not_supported", "not_reported"]) {
    const value = normalizeLlmUsage({ input: 1, output: 2 }, { preserveMissingFields: true, cacheSupport });
    assert.equal(value.cache.hitRatio, null);
    assert.equal(value.input.uncachedTokens, null);
    assert.equal(value.totalTokens, 3);
  }
  assert.equal(normalizeLlmUsage({ input: 1, output: 2, cache_creation: { ephemeral_5m_input_tokens: 3 } }, { preserveMissingFields: true }).cache.writeTokens, null);
  assert.equal(normalizeLlmUsage({ cache_creation: { ephemeral_5m_input_tokens: 3 } }).cache.writeTokens, 3);
  assert.equal(normalizeLlmUsage({ prompt_tokens: 0, completion_tokens: 0 }, { preserveMissingFields: true }).cache.hitRatio, null);
  assert.equal(normalizeLlmUsage({ input: 3, output: 1, cacheRead: 1 }, { preserveMissingFields: true }).cache.hitRatio, null);
  assert.equal(normalizeLlmUsage({ prompt_tokens: 3 }, { preserveMissingFields: true }).input.uncachedTokens, null);
});

test("debug logging remains tolerant of absent usage and throwing sinks", () => {
  assert.equal(flattenNormalizedUsage(null), null);
  assert.equal(buildUsageDebugRecord({ usage: null }), null);
  assert.equal(logLlmUsage({ usage: null, logger: {} }), null);
  assert.equal(logLlmUsage({ usage: { input: 1 }, logger: {} }).inputTokens, 1);
  assert.deepEqual(flattenNormalizedUsage({}), { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, costTotal: null, cacheHit: false, cacheCreated: false });
  const record = logLlmUsage({ usage: { input: 2, cacheMiss: 1 }, logger: { log() { throw new Error("sink"); } } });
  assert.equal(record.cacheMissTokens, 1);
});

test("ledger filters, error observation, ID factories and throwing observers remain compatible", () => {
  const ledger = createUsageLedger({ maxEntries: -1, timeZone: "UTC", logger: { warn() { throw new Error("logger"); } }, eventBus: { emit() { throw new Error("event"); } }, requestIdFactory: () => "factory", now: () => Date.parse("2026-10-21T00:00:00Z") });
  try {
    const entry = ledger.record({ usage: {}, metadata: { local: true } });
    assert.equal(entry.requestId, "factory");
    assert.equal(ledger.finish("absent"), null);
    assert.equal(ledger.recordError("absent", null), null);
    ledger.start({ requestId: "err" });
    assert.equal(ledger.recordError("err", null).error.name, null);
    ledger.start({ requestId: "err-text" });
    assert.equal(ledger.recordError("err-text", "problem").error.message, "problem");
    for (const filter of [{ since: "2026-11" }, { until: "2026-09" }, { status: "ok" }, { attributionKind: "session" }, { sessionId: "s" }, { sessionPath: "p" }, { childSessionId: "s" }, { childSessionPath: "p" }, { agentId: "a" }, { subsystem: "x" }, { operation: "x" }, { modelId: "m" }]) assert.equal(ledger.list(filter).entries.length, 0);
    assert.equal(ledger.list({ limit: 1 }).entries.length, 1);
  } finally { ledger.close(); }
  const generated = createUsageLedger();
  try { assert.match(generated.record({ usage: { input: 1 } }).requestId, /^llm_/); } finally { generated.close(); }
  assert.throws(() => createUsageLedger({ timeZone: "invalid/time-zone" }), RangeError);
});
