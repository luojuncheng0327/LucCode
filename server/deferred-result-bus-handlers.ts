import { normalizeDeferredResolveResult } from "../lib/deferred-result-payload.ts";

function textOrNull(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function sessionRefPayload(payload: any = {}) {
  const rawRef = payload.sessionRef && typeof payload.sessionRef === "object"
    ? payload.sessionRef
    : null;
  const sessionId = textOrNull(payload.sessionId) || textOrNull(rawRef?.sessionId);
  const sessionPath =
    textOrNull(payload.sessionPath)
    || textOrNull(rawRef?.sessionPath)
    || textOrNull(rawRef?.path);
  const legacySessionPath =
    textOrNull(payload.legacySessionPath)
    || textOrNull(rawRef?.legacySessionPath)
    || (sessionId && sessionPath ? sessionPath : null);
  const sessionRef = sessionId
    ? {
      sessionId,
      ...(sessionPath ? { sessionPath } : {}),
      ...(legacySessionPath ? { legacySessionPath } : {}),
    }
    : null;
  return { sessionId, sessionPath, sessionRef };
}

function requireDeferredTarget(payload: any = {}) {
  const target = sessionRefPayload(payload);
  if (!target.sessionId && !target.sessionPath) {
    return { ok: false, error: "sessionId or sessionPath is required" };
  }
  return target;
}

function isDeferredTargetError(target): target is { ok: false; error: string } {
  return target?.ok === false;
}

export function registerDeferredResultBusHandlers(eventBus, deferredResultStore) {
  eventBus.handle("deferred:register", ({ taskId, meta, ...payload }) => {
    const target = requireDeferredTarget(payload);
    if (isDeferredTargetError(target)) return target;
    const resolved = target as ReturnType<typeof sessionRefPayload>;
    deferredResultStore.defer(taskId, resolved, meta);
    return { ok: true, ...(resolved.sessionId ? { sessionId: resolved.sessionId, sessionRef: resolved.sessionRef } : {}), sessionPath: resolved.sessionPath };
  });
  eventBus.handle("deferred:retry", ({ taskId, meta, ...payload }) => {
    const target = requireDeferredTarget(payload);
    if (isDeferredTargetError(target)) return target;
    const resolved = target as ReturnType<typeof sessionRefPayload>;
    deferredResultStore.retry(taskId, resolved, meta);
    return { ok: true, ...(resolved.sessionId ? { sessionId: resolved.sessionId, sessionRef: resolved.sessionRef } : {}), sessionPath: resolved.sessionPath };
  });
  eventBus.handle("deferred:resolve", ({ taskId, result, files, sessionFiles }) => {
    deferredResultStore.resolve(taskId, normalizeDeferredResolveResult({ result, files, sessionFiles }));
    return { ok: true };
  });
  eventBus.handle("deferred:fail", ({ taskId, reason, error }) => {
    deferredResultStore.fail(taskId, reason ?? error?.message ?? String(error));
    return { ok: true };
  });
  eventBus.handle("deferred:query", ({ taskId }) => {
    return deferredResultStore.query(taskId);
  });
  eventBus.handle("deferred:list-pending", (payload: any = {}) => {
    const target = requireDeferredTarget(payload);
    if (isDeferredTargetError(target)) return [];
    return deferredResultStore.listPending(target as ReturnType<typeof sessionRefPayload>);
  });
  eventBus.handle("deferred:abort", ({ taskId, reason }) => {
    deferredResultStore.abort(taskId, reason);
    return { ok: true };
  });
}
