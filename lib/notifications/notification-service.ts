import { normalizeBridgePlatforms } from "../bridge/bridge-context.ts";

const CHANNEL_DESKTOP = "desktop";
const CHANNEL_BRIDGE_OWNER = "bridge_owner";
const CHANNEL_AUTO = "auto";
const CONTEXT_RECORD_WHEN_DELIVERED = "record_when_delivered";
const AUDIENCE_OWNER = "owner";
const IDEMPOTENCY_TTL_MS = 10 * 60 * 1000;
const DESKTOP_FOCUS_ALWAYS = "always";
const DESKTOP_FOCUS_WHEN_UNFOCUSED = "when_unfocused";
const DESKTOP_FOCUS_WHEN_SESSION_UNFOCUSED = "when_session_unfocused";

const VALID_CHANNELS = new Set([CHANNEL_DESKTOP, CHANNEL_BRIDGE_OWNER, CHANNEL_AUTO]);
const VALID_DESKTOP_FOCUS_POLICIES = new Set([
  DESKTOP_FOCUS_ALWAYS,
  DESKTOP_FOCUS_WHEN_UNFOCUSED,
  DESKTOP_FOCUS_WHEN_SESSION_UNFOCUSED,
]);

export function formatNotificationText(title: any, body: any) {
  const safeTitle = typeof title === "string" ? title.trim() : "";
  const safeBody = typeof body === "string" ? body.trim() : "";
  if (safeTitle && safeBody) return `${safeTitle}\n\n${safeBody}`;
  return safeBody || safeTitle;
}

export function normalizeNotificationPayload(payload: any = {}) {
  const title = typeof payload.title === "string" ? payload.title : "";
  const body = typeof payload.body === "string" ? payload.body : "";
  const audience = payload.audience || AUDIENCE_OWNER;
  const contextPolicy = payload.contextPolicy || CONTEXT_RECORD_WHEN_DELIVERED;
  const { channels, invalidChannels } = normalizeChannels(payload.channels);
  const { bridgePlatforms, invalidBridgePlatforms } = normalizeBridgePlatforms(payload.bridgePlatforms);

  return {
    ...payload,
    title,
    body,
    audience,
    contextPolicy,
    idempotencyKey: normalizeIdempotencyKey(payload.idempotencyKey),
    desktopFocusPolicy: normalizeDesktopFocusPolicy(payload.desktopFocusPolicy),
    channels,
    invalidChannels,
    bridgePlatforms,
    invalidBridgePlatforms,
  };
}

function normalizeDesktopFocusPolicy(value: any) {
  return VALID_DESKTOP_FOCUS_POLICIES.has(value) ? value : DESKTOP_FOCUS_ALWAYS;
}

function normalizeIdempotencyKey(value: any) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeChannels(value: any) {
  const hasExplicitChannels = Array.isArray(value) || (typeof value === "string" && value);
  const raw = Array.isArray(value) ? value : hasExplicitChannels ? [value] : [CHANNEL_DESKTOP];
  const normalized = [];
  const invalidChannels = [];
  for (const item of raw) {
    const channel = typeof item === "string" ? item.trim() : "";
    if (!channel) continue;
    if (!VALID_CHANNELS.has(channel)) {
      invalidChannels.push(channel);
      continue;
    }
    if (channel === CHANNEL_AUTO) {
      if (!normalized.includes(CHANNEL_DESKTOP)) normalized.push(CHANNEL_DESKTOP);
      continue;
    }
    if (!normalized.includes(channel)) normalized.push(channel);
  }
  if (!hasExplicitChannels && normalized.length === 0) normalized.push(CHANNEL_DESKTOP);
  return { channels: normalized, invalidChannels };
}

export class NotificationService {
  declare _emitDesktop: any;
  declare _getBridgeManager: any;
  declare _idempotency: Map<string, any>;

  /**
   * @param {object} deps
   * @param {(event: {title: string, body: string, agentId?: string|null, desktopFocusPolicy?: string}) => void|Promise<void>} deps.emitDesktop
   * @param {() => import('../bridge/bridge-manager.ts').BridgeManager|null} deps.getBridgeManager
   */
  constructor({ emitDesktop, getBridgeManager }: any = {}) {
    this._emitDesktop = emitDesktop;
    this._getBridgeManager = getBridgeManager;
    this._idempotency = new Map();
  }

  async notify(payload: any, context: any = {}) {
    const bridgeDeliveryTarget = normalizeBridgeDeliveryTargetFromContext(context);
    const hasExplicitChannels = Array.isArray(payload?.channels) || (typeof payload?.channels === "string" && payload.channels.trim());
    const normalized = normalizeNotificationPayload(
      bridgeDeliveryTarget && !hasExplicitChannels
        ? { ...payload, channels: [CHANNEL_BRIDGE_OWNER] }
        : payload,
    );
    const deliveryContext = bridgeDeliveryTarget
      ? { ...context, bridgeDeliveryTarget }
      : context;
    const idempotencyKey = normalized.idempotencyKey || normalizeIdempotencyKey(context.idempotencyKey);
    if (idempotencyKey) {
      const existing = this._getIdempotentDelivery(idempotencyKey);
      if (existing) return existing;
      const promise = this._notifyOnce(normalized, deliveryContext, idempotencyKey);
      this._idempotency.set(idempotencyKey, { promise, createdAt: Date.now(), result: null });
      return promise;
    }

    return this._notifyOnce(normalized, deliveryContext, null);
  }

  _getIdempotentDelivery(idempotencyKey: any) {
    this._pruneIdempotency();
    const existing = this._idempotency.get(idempotencyKey);
    if (!existing) return null;
    if (existing.promise) return existing.promise;
    return {
      ...(existing.result || {}),
      ok: true,
      idempotencyKey,
      skipped: true,
      deliveries: [{
        channel: "notification",
        status: "skipped",
        reason: "duplicate notification",
      }],
    };
  }

  _pruneIdempotency(now = Date.now()) {
    for (const [key, entry] of this._idempotency) {
      if (now - entry.createdAt > IDEMPOTENCY_TTL_MS) this._idempotency.delete(key);
    }
  }

  async _notifyOnce(normalized: any, context: any = {}, idempotencyKey: any = null) {
    const deliveries = [];

    for (const channel of normalized.invalidChannels) {
      deliveries.push({
        channel,
        status: "failed",
        error: `unsupported notification channel: ${channel}`,
      });
    }

    for (const platform of normalized.invalidBridgePlatforms) {
      deliveries.push({
        channel: CHANNEL_BRIDGE_OWNER,
        status: "failed",
        error: `unsupported bridge platform: ${platform}`,
      });
    }

    for (const channel of normalized.channels) {
      if (channel === CHANNEL_DESKTOP) {
        deliveries.push(await this._deliverDesktop(normalized, context));
      } else if (channel === CHANNEL_BRIDGE_OWNER) {
        deliveries.push(await this._deliverBridgeOwner(normalized, context));
      }
    }

    const result = {
      ok: deliveries.length > 0 && deliveries.every((d) => d.status === "sent"),
      title: normalized.title,
      body: normalized.body,
      channels: normalized.channels,
      ...(idempotencyKey ? { idempotencyKey } : {}),
      deliveries,
    };
    if (idempotencyKey) {
      const delivered = deliveries.some((d) => d.status === "sent");
      if (delivered) {
        this._idempotency.set(idempotencyKey, {
          promise: null,
          createdAt: Date.now(),
          result,
        });
      } else {
        this._idempotency.delete(idempotencyKey);
      }
    }
    return result;
  }

  async _deliverDesktop(payload: any, context: any) {
    try {
      const sessionPath = normalizeSessionPath(payload.sessionPath) || normalizeSessionPath(context.sessionPath);
      await this._emitDesktop?.({
        title: payload.title,
        body: payload.body,
        agentId: context.agentId || null,
        desktopFocusPolicy: payload.desktopFocusPolicy,
        ...(sessionPath ? { sessionPath } : {}),
      });
      return { channel: CHANNEL_DESKTOP, status: "sent" };
    } catch (err) {
      return { channel: CHANNEL_DESKTOP, status: "failed", error: err.message };
    }
  }

  async _deliverBridgeOwner(payload: any, context: any) {
    if (payload.audience !== AUDIENCE_OWNER) {
      return {
        channel: CHANNEL_BRIDGE_OWNER,
        status: "failed",
        error: `unsupported audience for bridge_owner: ${payload.audience}`,
      };
    }

    const manager = this._getBridgeManager?.();
    if (!manager) {
      return { channel: CHANNEL_BRIDGE_OWNER, status: "failed", error: "bridge manager unavailable" };
    }

    const text = formatNotificationText(payload.title, payload.body);
    if (!text) {
      return { channel: CHANNEL_BRIDGE_OWNER, status: "failed", error: "notification text is empty" };
    }

    try {
      const proactiveOpts: Record<string, any> = {
        contextPolicy: payload.contextPolicy,
      };
      if (payload.bridgePlatforms.length) proactiveOpts.bridgePlatforms = payload.bridgePlatforms;
      if (context.bridgeDeliveryTarget) proactiveOpts.deliveryTarget = context.bridgeDeliveryTarget;
      if (payload.idempotencyKey) proactiveOpts.idempotencyKey = `${payload.idempotencyKey}:bridge_owner`;
      const result = await manager.sendProactive(text, context.agentId || null, proactiveOpts);
      if (!result) {
        return { channel: CHANNEL_BRIDGE_OWNER, status: "failed", error: "target_missing" };
      }
      if (result.ok === false) {
        return {
          channel: CHANNEL_BRIDGE_OWNER,
          status: "failed",
          error: result.error || "target_missing",
          ...(result.message ? { message: result.message } : {}),
          ...(Array.isArray(result.deliveries) ? { bridgeDeliveries: result.deliveries } : {}),
        };
      }
      return {
        channel: CHANNEL_BRIDGE_OWNER,
        status: "sent",
        platform: result.platform,
        chatId: result.chatId,
        sessionKey: result.sessionKey,
        recorded: result.recorded === true,
        ...(Array.isArray(result.deliveries) ? { bridgeDeliveries: result.deliveries } : {}),
      };
    } catch (err) {
      return { channel: CHANNEL_BRIDGE_OWNER, status: "failed", error: err.message };
    }
  }
}

function normalizeSessionPath(value: any) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeBridgeDeliveryTargetFromContext(context: any = {}) {
  return normalizeBridgeDeliveryTarget(
    context.bridgeDeliveryTarget
      || context.deliveryTarget
      || context.notificationContext?.bridgeDeliveryTarget
      || context.notificationContext?.deliveryTarget
      || bridgeTargetFromBridgeContext(context.bridgeContext),
  );
}

function bridgeTargetFromBridgeContext(bridgeContext: any) {
  if (bridgeContext?.isBridgeSession !== true) return null;
  if (bridgeContext.role && bridgeContext.role !== "owner") return null;
  if (bridgeContext.chatType && bridgeContext.chatType !== "dm") return null;
  return {
    kind: "bridge",
    platform: bridgeContext.platform,
    chatType: "dm",
    chatId: bridgeContext.chatId,
    sessionKey: bridgeContext.sessionKey,
    agentId: bridgeContext.agentId,
  };
}

function normalizeBridgeDeliveryTarget(value: any) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (value.kind && value.kind !== "bridge") return null;
  const platform = typeof value.platform === "string" && value.platform.trim() ? value.platform.trim() : null;
  const chatId = typeof value.chatId === "string" && value.chatId.trim() ? value.chatId.trim() : null;
  const sessionKey = typeof value.sessionKey === "string" && value.sessionKey.trim() ? value.sessionKey.trim() : null;
  if (!platform || (!chatId && !sessionKey)) return null;
  const agentId = typeof value.agentId === "string" && value.agentId.trim() ? value.agentId.trim() : null;
  return {
    kind: "bridge",
    platform,
    chatType: "dm",
    ...(chatId ? { chatId } : {}),
    ...(sessionKey ? { sessionKey } : {}),
    ...(agentId ? { agentId } : {}),
  };
}
