import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { test } from "node:test";
import { createUsageLedger } from "../lib/llm/usage-ledger.ts";

const fixedNow = () => Date.parse("2026-10-21T02:00:00.000Z");
const usage = { input: { totalTokens: 7 }, output: { totalTokens: 3 }, cache: { readTokens: null, writeTokens: 0 }, totalTokens: 10 };
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "luc-usage-sqlite-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, databasePath: path.join(dir, "usage-ledger.sqlite"), legacyStoragePath: path.join(dir, "usage-ledger.json"), timeZone: "Asia/Shanghai", now: fixedNow };
}
function legacyEntry(requestId) { return { requestId, startedAt: "2026-10-20T23:00:00Z", endedAt: "2026-10-20T23:00:01Z", status: "ok", model: { provider: "fixture", modelId: "fixture-model" }, usage }; }

test("legacy import is once-only, byte preserving, durable, and maintains history after detail trimming", (t) => {
  const options = fixture(t);
  fs.writeFileSync(options.legacyStoragePath, JSON.stringify({ version: 1, entries: [legacyEntry("a"), legacyEntry("b"), legacyEntry("a")] }));
  const original = fs.readFileSync(options.legacyStoragePath);
  let ledger = createUsageLedger({ ...options, maxEntries: 1 });
  t.after(() => ledger.close?.());
  assert.equal(typeof ledger.listDaily, "function", "SQLite ledger must expose durable rollups");
  assert.deepEqual(ledger.list().entries.map((entry) => entry.requestId), ["b"]);
  assert.equal(ledger.listDaily().rows[0].requestCount, 2);
  assert.equal(ledger.listDaily().rows[0].tokens.total, 20);
  assert.equal(ledger.listDaily().rows[0].missingFieldCounts.cacheRead, 2);
  assert.equal(ledger.listDaily().coverage.historyIncomplete, true);
  assert.deepEqual(fs.readFileSync(options.legacyStoragePath), original);
  assert.equal(ledger.record({ requestId: "a", usage }), null, "trimmed detail identity must remain deduplicated");
  ledger.close();
  fs.writeFileSync(options.legacyStoragePath, "invalid after one-time import");
  ledger = createUsageLedger(options);
  assert.equal(ledger.listDaily().rows[0].requestCount, 2);
  assert.equal(ledger.listDaily({ since: "2026-10-22" }).rows.length, 0);
  ledger.close();
  const db = new Database(options.databasePath, { readonly: true });
  try { assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'usage_%' ORDER BY name").all().map((row) => row.name), ["usage_daily_rollups", "usage_entries", "usage_meta", "usage_seen_requests"]); } finally { db.close(); }
});

test("invalid legacy input fails loudly and a retry imports without partial rollups", (t) => {
  const options = fixture(t);
  for (const invalid of ["{", JSON.stringify({ entries: null }), JSON.stringify({ entries: [legacyEntry("ok"), { ...legacyEntry("bad"), endedAt: "invalid" }] })]) {
    fs.writeFileSync(options.legacyStoragePath, invalid);
    assert.throws(() => createUsageLedger(options), /migrate|entries|timestamp/);
    assert.equal(fs.readFileSync(options.legacyStoragePath, "utf8"), invalid);
  }
  fs.writeFileSync(options.legacyStoragePath, JSON.stringify({ entries: [legacyEntry("ok")] }));
  const ledger = createUsageLedger(options);
  try { assert.equal(ledger.listDaily().rows[0].requestCount, 1); } finally { ledger.close(); }
});

test("writes are transactional, retryable, and emit only after commit", (t) => {
  const options = fixture(t);
  const emitted = [];
  const ledger = createUsageLedger({ ...options, eventBus: { emit: (event) => emitted.push(event) } });
  t.after(() => ledger.close?.());
  assert.equal(typeof ledger.close, "function");
  const db = new Database(options.databasePath);
  try {
    db.exec("CREATE TRIGGER reject_usage BEFORE INSERT ON usage_entries BEGIN SELECT RAISE(ABORT, 'injected write failure'); END");
    ledger.start({ requestId: "retry" });
    assert.throws(() => ledger.finish("retry", { usage }), /injected write failure/);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM usage_seen_requests").get().n, 0);
    assert.equal(emitted.length, 0);
    db.exec("DROP TRIGGER reject_usage");
    assert.equal(ledger.finish("retry", { usage }).requestId, "retry");
    assert.equal(emitted.length, 1);
  } finally { db.close(); }
  ledger.clear();
  assert.equal(ledger.list().entries.length, 0);
  assert.equal(ledger.listDaily().rows.length, 0);
  ledger.close();
  assert.throws(() => ledger.list(), /closed/);
});

test("missing usage fields remain missing and persisted time zone cannot drift", (t) => {
  const options = fixture(t);
  let ledger = createUsageLedger(options);
  t.after(() => ledger.close?.());
  assert.equal(typeof ledger.listDaily, "function");
  ledger.record({ requestId: "empty", usage: {} });
  ledger.record({ requestId: "partial", usage: { output_tokens: 4 } });
  ledger.start({ requestId: "failed" });
  ledger.recordError("failed", new Error("fixture"), "aborted");
  const row = ledger.listDaily().rows[0];
  assert.equal(row.requestCount, 3);
  assert.equal(row.tokens.output, 4);
  assert.equal(row.missingFieldCounts.input, 3);
  assert.equal(row.missingFieldCounts.output, 2);
  assert.equal(row.statusCounts.usageMissing, 1);
  assert.equal(row.statusCounts.aborted, 1);
  ledger.close();
  ledger = createUsageLedger({ ...options, timeZone: "UTC" });
  assert.equal(ledger.listDaily().timeZone, "Asia/Shanghai");
});
