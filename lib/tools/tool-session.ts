import path from "path";

/**
 * tool-session.js — 从 tool execute 的 ctx 中提取 sessionPath
 *
 * Pi SDK 调用 tool.execute(toolCallId, params, signal?, onUpdate?, ctx?) 时，
 * ctx.sessionManager.getSessionFile() 返回当前执行 session 的文件路径。
 * 所有工具应通过此函数获取 sessionPath，不再依赖焦点回调。
 */

/**
 * @param {object} [ctx] - Pi SDK tool execute 的第 5 个参数
 * @returns {string|null}
 */
export function getToolSessionPath(ctx) {
  return ctx?.sessionManager?.getSessionFile?.() ?? null;
}

function nonEmptyText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizedLocator(value) {
  const locator = nonEmptyText(value);
  return locator ? path.resolve(locator) : null;
}

function identityConflict(sessionIds: Set<string>) {
  const error: any = new Error(`Tool session identity conflict: ${[...sessionIds].join(" != ")}`);
  error.code = "session_identity_conflict";
  return error;
}

/**
 * Resolve Luc's runtime-owned SessionRef from explicit context first, then
 * validate it against the current JSONL locator when a resolver is available.
 * The Pi SessionManager is used only as a legacy locator source.
 */
export function resolveToolSessionRef(ctx: any, deps: any = {}) {
  const runtimeRef = ctx?.sessionRef && typeof ctx.sessionRef === "object"
    ? ctx.sessionRef
    : null;
  const providedRef = typeof deps.getSessionRef === "function"
    ? deps.getSessionRef()
    : null;
  const locatorCandidates = [
    normalizedLocator(runtimeRef?.sessionPath),
    normalizedLocator(ctx?.sessionPath),
    normalizedLocator(getToolSessionPath(ctx)),
    normalizedLocator(providedRef?.sessionPath),
    normalizedLocator(deps.getSessionPath?.()),
  ].filter(Boolean);
  const uniqueLocators = new Set<string>(locatorCandidates);
  if (uniqueLocators.size > 1) throw identityConflict(uniqueLocators);
  const sessionPath = locatorCandidates[0] || null;

  const candidates = [
    nonEmptyText(runtimeRef?.sessionId),
    nonEmptyText(ctx?.sessionId),
    nonEmptyText(providedRef?.sessionId),
    nonEmptyText(deps.getSessionId?.()),
    sessionPath ? nonEmptyText(deps.getSessionIdForPath?.(sessionPath)) : null,
  ].filter(Boolean);
  const uniqueSessionIds = new Set(candidates);
  if (uniqueSessionIds.size > 1) throw identityConflict(uniqueSessionIds);
  const sessionId = candidates[0] || null;
  return sessionId ? { sessionId, ...(sessionPath ? { sessionPath } : {}) } : null;
}

function isAbortSignalLike(value) {
  return value
    && typeof value === "object"
    && typeof value.aborted === "boolean"
    && typeof value.addEventListener === "function";
}

/**
 * Pi SDK 当前调用约定是 execute(toolCallId, params, signal, onUpdate, ctx)。
 * Luc 内部少量直接调用仍传 execute(toolCallId, params, runtimeCtx)。
 * 这里把两种入口统一成业务 ctx，避免 wrapper 把 AbortSignal 当成 runtimeCtx。
 *
 * @param {object|null|undefined} signalOrRuntimeCtx - 第 3 个 execute 参数
 * @param {object|null|undefined} piCtx - 第 5 个 execute 参数
 * @returns {{ ctx: object, hasExplicitCtx: boolean }}
 */
export function normalizeToolRuntimeContext(signalOrRuntimeCtx, piCtx) {
  if (piCtx && typeof piCtx === "object") {
    return { ctx: piCtx, hasExplicitCtx: true };
  }
  if (
    signalOrRuntimeCtx
    && typeof signalOrRuntimeCtx === "object"
    && !isAbortSignalLike(signalOrRuntimeCtx)
  ) {
    return { ctx: signalOrRuntimeCtx, hasExplicitCtx: true };
  }
  return { ctx: {}, hasExplicitCtx: false };
}

/**
 * @param {object} [ctx] - Pi SDK tool execute 的第 5 个参数
 * @returns {string|null}
 */
export function getToolSessionCwd(ctx) {
  return ctx?.sessionManager?.getCwd?.() ?? null;
}
