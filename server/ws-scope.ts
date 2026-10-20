import crypto from "crypto";
import {
  normalizePrincipal,
  principalHasScope,
  principalOwnsLocalConnection,
} from "../core/security-principal.ts";

const SAFE_GLOBAL_EVENTS = new Set([
  "session_created",
  "notification",
]);

const WRITE_MESSAGE_TYPES = new Set([
  "abort",
  "steer",
  "interject",
  "slash",
  "compact",
  "prompt",
]);

const READ_MESSAGE_TYPES = new Set([
  "resume_stream",
  "context_usage",
]);

export function createWsClientRecord({ principal, subscriptions = [], clientId = `wsc_${crypto.randomUUID()}` }: { principal?: any; subscriptions?: any[]; clientId?: string } = {}) {
  return Object.freeze({
    clientId,
    principal: normalizePrincipal(principal || { kind: "unknown" }),
    subscriptions: normalizeSubscriptions(subscriptions),
  });
}

export function subscribeWsClientToSession(client, { studioId, sessionPath, sessionId = null }) {
  if (!client) return client;
  if (!studioId || !sessionPath) return client;
  const normalizedSessionId = stringOrNull(sessionId);
  const next = [
    ...client.subscriptions,
    { kind: "session", studioId, sessionPath, ...(normalizedSessionId ? { sessionId: normalizedSessionId } : {}) },
  ];
  return createWsClientRecord({
    clientId: client.clientId,
    principal: client.principal,
    subscriptions: next,
  });
}

/**
 * @param event 出站消息（wire payload，原样序列化发给 client，不在此函数内被修改）。
 * @param options.resolvedSessionId 广播侧在扇出前解析出的 sessionId（当 event 本身未携带时的兜底，
 *   由调用方对同一条 event 只解析一次，不随每个订阅者重复解析）。
 */
export function wsClientCanReceiveEvent(client, event, { resolvedSessionId = null }: { resolvedSessionId?: any } = {}) {
  if (!client || !event || typeof event !== "object") return false;
  const principal = normalizePrincipal(client.principal);
  if (principalOwnsLocalConnection(principal)) return true;

  if (event.thumbnail && typeof event.thumbnail === "string") return false;

  const sessionPath = stringOrNull(event.sessionPath);
  const eventStudioId = stringOrNull(event.studioId);
  if (sessionPath) {
    // session 事件必须显式携带 studioId 才能投递给非本地 owner；
    // publisher (server/routes/chat.ts broadcast()) 已在 wrap 时注入 server
    // runtime studioId。缺 studioId 视为来源不明，拒收 fail-closed。
    if (!eventStudioId) return false;
    if (!principalHasScope(principal, "chat.read")) return false;
    if (!sameStudio(principal, eventStudioId)) return false;
    const eventSessionId = stringOrNull(event.sessionId) || stringOrNull(resolvedSessionId);
    return subscriptionAllows(client.subscriptions, { kind: "session", studioId: eventStudioId, sessionPath, sessionId: eventSessionId })
      || subscriptionAllows(client.subscriptions, { kind: "studio", studioId: eventStudioId });
  }

  if (SAFE_GLOBAL_EVENTS.has(event.type)) {
    return principalHasScope(principal, "chat.read");
  }

  if (event.resourceId) {
    return principalHasScope(principal, "resources.read") || principalHasScope(principal, "resources.content");
  }

  return false;
}

export function wsClientCanSendMessage(client, message) {
  if (!client || !message || typeof message !== "object") return false;
  const principal = normalizePrincipal(client.principal);
  if (principalOwnsLocalConnection(principal)) return true;
  const type = stringOrNull(message.type);
  if (WRITE_MESSAGE_TYPES.has(type)) return principalHasScope(principal, "chat.write");
  if (READ_MESSAGE_TYPES.has(type)) return principalHasScope(principal, "chat.read");
  return principalHasScope(principal, "chat");
}

function normalizeSubscriptions(subscriptions) {
  const out = [];
  const seen = new Set();
  for (const sub of Array.isArray(subscriptions) ? subscriptions : []) {
    if (!sub || typeof sub !== "object") continue;
    const kind = stringOrNull(sub.kind);
    const studioId = stringOrNull(sub.studioId);
    const sessionPath = stringOrNull(sub.sessionPath);
    const sessionId = stringOrNull(sub.sessionId);
    const resourceId = stringOrNull(sub.resourceId);
    if (!kind || !studioId) continue;
    const normalized = {
      kind,
      studioId,
      ...(sessionId ? { sessionId } : {}),
      ...(sessionPath ? { sessionPath } : {}),
      ...(resourceId ? { resourceId } : {}),
    };
    // 去重键用 sessionId || sessionPath 代表同一会话身份：同一 session 归档换 path 后
    // 重新 subscribe 不会在 subscriptions 数组里滚雪球攒出多条指向同一会话的旧纪录。
    const dedupeKey = JSON.stringify({
      kind,
      studioId,
      session: sessionId || sessionPath || null,
      resourceId: resourceId || null,
    });
    if (!seen.has(dedupeKey)) {
      seen.add(dedupeKey);
      out.push(Object.freeze(normalized));
    }
  }
  return Object.freeze(out);
}

function subscriptionAllows(subscriptions, target) {
  return (subscriptions || []).some((sub) => {
    if (sub.kind === "studio") return sub.studioId === target.studioId;
    if (sub.kind !== target.kind) return false;
    if (sub.studioId !== target.studioId) return false;
    if (target.sessionPath) {
      // sessionId 双方都在场时按身份比较（归档改 path 不失配）；
      // 否则回退裸 path 相等（无 manifest 的老会话兼容路径）。
      if (sub.sessionId && target.sessionId) {
        if (sub.sessionId !== target.sessionId) return false;
      } else if (sub.sessionPath !== target.sessionPath) {
        return false;
      }
    }
    if (target.resourceId && sub.resourceId !== target.resourceId) return false;
    return true;
  });
}

function sameStudio(principal, studioId) {
  if (!studioId) return false;
  if (principal.studioId === studioId) return true;
  return Array.isArray(principal.studioIds) && principal.studioIds.includes(studioId);
}

function stringOrNull(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
