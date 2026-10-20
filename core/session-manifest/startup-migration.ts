import { createSessionManifestCheckpoint } from "./checkpoint.ts";
import { migrateLegacySessions } from "./legacy-migration.ts";

export const LEGACY_SESSION_MANIFEST_MIGRATION_KEY = "legacy-session-manifest-scan-v1";

function sanitizeTimestamp(value) {
  return String(value).replace(/:/g, "-").replace(/\./g, "-");
}

function serializeError(error) {
  return {
    name: error?.name || "Error",
    message: error?.message || String(error),
    ...(error?.code ? { code: error.code } : {}),
  };
}

export function ensureLegacySessionManifestMigration(opts: any = {}) {
  if (!opts.lucHome) throw new Error("ensureLegacySessionManifestMigration requires lucHome");
  if (!opts.store) throw new Error("ensureLegacySessionManifestMigration requires store");

  const key = opts.stateKey || LEGACY_SESSION_MANIFEST_MIGRATION_KEY;
  const existing = typeof opts.store.getState === "function" ? opts.store.getState(key) : null;
  if (existing?.completedAt) {
    // rescan 分支：completedAt 之后每次启动仍无条件调用 migrate（语义保留，不改）。
    // rescan 的整读风险由 legacy-migration.ts 的 stat 签名账本（createMetaSourceGate）控制——
    // 已判定超大或损坏的 meta 源文件在签名未变时不会被再次 readFileSync；健康文件体积小，
    // 每次照常重读（保证迟到会话行总能拿到 legacy 属性），因此这里可以放心地每次都调用。
    try {
      const scannedAt = opts.scannedAt || new Date().toISOString();
      const migrate = opts.migrate || migrateLegacySessions;
      const result = migrate({
        lucHome: opts.lucHome,
        store: opts.store,
        migratedAt: scannedAt,
        stopOnError: opts.stopOnError,
      });
      const state = {
        ...existing,
        lastScannedAt: scannedAt,
        lastResult: result,
      };
      opts.store.setState(key, state);
      return { status: "rescanned", result, state };
    } catch (error) {
      const state = {
        ...existing,
        lastFailedAt: opts.failedAt || new Date().toISOString(),
        error: serializeError(error),
      };
      try {
        opts.store.setState(key, state);
      } catch (stateError) {
        if (opts.throwOnFailure) throw stateError;
      }
      if (opts.throwOnFailure) throw error;
      return { status: "failed", error, state };
    }
  }

  const startedAt = opts.startedAt || new Date().toISOString();
  const checkpointId = opts.checkpointId || `legacy-session-manifest-${sanitizeTimestamp(startedAt)}`;
  const createCheckpoint = opts.createCheckpoint || createSessionManifestCheckpoint;
  const migrate = opts.migrate || migrateLegacySessions;
  let checkpoint = null;

  try {
    checkpoint = createCheckpoint({
      lucHome: opts.lucHome,
      appVersion: opts.appVersion,
      gitAnchors: opts.gitAnchors,
      createdAt: startedAt,
      id: checkpointId,
      ...(opts.checkpointRoot ? { checkpointRoot: opts.checkpointRoot } : {}),
      ...(opts.includes ? { includes: opts.includes } : {}),
    });

    const result = migrate({
      lucHome: opts.lucHome,
      store: opts.store,
      migratedAt: startedAt,
      stopOnError: opts.stopOnError,
    });
    const state = {
      startedAt,
      completedAt: opts.completedAt || startedAt,
      checkpointDirectory: checkpoint.directory,
      checkpointId: checkpoint.id,
      result,
    };
    opts.store.setState(key, state);
    return { status: "completed", checkpoint, result, state };
  } catch (error) {
    const state = {
      startedAt,
      failedAt: opts.failedAt || startedAt,
      checkpointDirectory: checkpoint?.directory || null,
      checkpointId: checkpoint?.id || checkpointId,
      error: serializeError(error),
    };
    try {
      opts.store.setState(key, state);
    } catch (stateError) {
      if (opts.throwOnFailure) throw stateError;
    }
    if (opts.throwOnFailure) throw error;
    return { status: "failed", error, state };
  }
}
