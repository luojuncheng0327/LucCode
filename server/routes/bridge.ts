/**
 * bridge.js — 外部平台接入 REST API
 *
 * 管理 Telegram / 飞书 / QQ 等外部消息平台的连接。
 */

import fs from "fs";
import path from "path";
import { Hono } from "hono";
import { safeJson } from "../hono-helpers.ts";
import { debugLog } from "../../lib/debug-log.ts";
import { parseSessionKey, collectKnownUsers, KNOWN_PLATFORMS, resolveBridgeSessionIdentity } from "../../lib/bridge/session-key.ts";
import { isBridgeOwner, resolveBridgeOwnerUserId } from "../../lib/bridge/owner-policy.ts";
import { collectBridgeMediaAllowedRoots, isInsideBridgeMediaRoot } from "../../lib/bridge/media-roots.ts";
import { sanitizeBridgeVisibleText } from "../../shared/bridge-visible-text.ts";
import { t } from "../../lib/i18n.ts";
import { AgentNotFoundError, resolveAgentStrict } from "../utils/resolve-agent.ts";
import { telegramBotOptions } from "../../lib/net/outbound-proxy.ts";
import { createBridgeOutboundHttp } from "../../lib/bridge/outbound-http.ts";
import {
  DINGTALK_API_BASE_URL,
  assertNoUnsupportedDingTalkRobotFields,
  canonicalizeDingTalkBridgeConfig,
  normalizeDingTalkBridgeCredentials,
} from "../../lib/bridge/dingtalk-contract.ts";
import {
  DingTalkApiError,
  dingtalkErrorInfo,
  requestDingTalkAccessToken,
} from "../../lib/bridge/dingtalk-api.ts";
import { formatSecretFingerprintComparison } from "../../lib/secret-fingerprint.ts";
import {
  collectSecretPatchPaths,
  isMaskedSecretValue,
  maskSecretValue,
  resolveSecretPatch,
} from "../../shared/secret-custody.ts";
import { denySecretMutationWithoutScope, denyWithoutScope } from "../http/capability-guard.ts";
import { recordSecurityAuditEvent } from "../http/security-audit.ts";
import { normalizeBridgePermissionMode, SESSION_PERMISSION_MODES } from "../../core/session-permission-mode.ts";

const MAX_BRIDGE_MEDIA_SIZE = 50 * 1024 * 1024;
const DEFAULT_FEISHU_REGION = "feishu_cn";
const FEISHU_DOMAIN_BY_REGION: Record<string, string> = Object.freeze({
  feishu_cn: "https://open.feishu.cn",
  lark_global: "https://open.larksuite.com",
});

function cleanBridgeString(value: unknown) {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

function firstBridgeString(...values: unknown[]) {
  for (const value of values) {
    const cleaned = cleanBridgeString(value);
    if (cleaned) return cleaned;
  }
  return "";
}

function normalizeFeishuRegion(region: any = DEFAULT_FEISHU_REGION) {
  const value = typeof region === "string" ? region.trim() : region;
  if (value === undefined || value === null || value === "") return DEFAULT_FEISHU_REGION;
  if (value === "feishu_cn" || value === "lark_global") return value;
  throw new Error(`unsupported Feishu region: ${value}`);
}

function resolveFeishuDomain(region: any = DEFAULT_FEISHU_REGION) {
  const normalizedRegion = normalizeFeishuRegion(region);
  return {
    region: normalizedRegion,
    domain: FEISHU_DOMAIN_BY_REGION[normalizedRegion],
    tenantTokenUrl: `${FEISHU_DOMAIN_BY_REGION[normalizedRegion]}/open-apis/auth/v3/tenant_access_token/internal`,
  };
}

function feishuStatusDomainInfo(cfg: any = {}) {
  try {
    return { ...resolveFeishuDomain(cfg?.region), configError: null };
  } catch (err: any) {
    return {
      region: cfg?.region || DEFAULT_FEISHU_REGION,
      domain: null,
      tenantTokenUrl: null,
      configError: err?.message || String(err),
    };
  }
}

function feishuLongConnectionInfo(domainInfo: any) {
  return {
    region: domainInfo.region,
    domain: domainInfo.domain,
    eventDelivery: "long_connection",
    callbackUrlRequired: false,
    credentialVerification: {
      status: "tested",
      method: "tenant_access_token",
      endpoint: domainInfo.tenantTokenUrl,
    },
    longConnection: {
      status: "not_tested",
      reason: "bridge/test validates credentials by tenant token only; runtime WSClient long-connection status is reported after the connector is enabled.",
    },
  };
}

function feishuTestInfo({ credentialOk, response, data, domainInfo }: { credentialOk?: any; response?: any; data?: any; domainInfo?: any } = {}) {
  const logId = data?.error?.log_id || data?.log_id || null;
  return {
    credentialOk,
    ...feishuLongConnectionInfo(domainInfo || resolveFeishuDomain()),
    ...(response ? { httpStatus: response.status } : {}),
    ...(data?.code !== undefined ? { feishuCode: data.code } : {}),
    ...(data?.msg ? { feishuMessage: data.msg } : {}),
    ...(logId ? { logId } : {}),
  };
}

function dingtalkStreamInfo() {
  return {
    eventDelivery: "stream",
    callbackUrlRequired: false,
    stream: {
      status: "not_tested",
      reason: "bridge/test validates internal-app credentials only; the runtime Stream connection reports live status after the connector is enabled.",
    },
  };
}

function dingtalkTestInfo({ credentialOk, authMode, metadata, errorInfo }: {
  credentialOk?: any;
  authMode?: "current" | "legacy_app";
  metadata?: any;
  errorInfo?: any;
} = {}) {
  return {
    credentialOk,
    ...(authMode ? { authMode } : {}),
    ...dingtalkStreamInfo(),
    ...(metadata || {}),
    ...(errorInfo || {}),
  };
}

function normalizeBridgeManagerRef(ref: any) {
  if (ref && typeof ref.get === "function") {
    return {
      get: ref.get,
      ensureReady: ref.ensureReady || ref.get,
      getState: ref.getState || (() => ({ ready: !!ref.get(), initializing: false, error: null })),
    };
  }
  if (typeof ref === "function") {
    return {
      get: ref,
      ensureReady: ref,
      getState: () => ({ ready: !!ref(), initializing: false, error: null }),
    };
  }
  return {
    get: () => ref || null,
    ensureReady: async () => ref || null,
    getState: () => ({ ready: !!ref, initializing: false, error: null }),
  };
}

function bridgeUnavailable(c: any, state: { error?: any; initializing?: any } = {}) {
  const error = state.error
    ? `bridge manager unavailable: ${state.error}`
    : "bridge manager is still starting";
  return c.json({
    ok: false,
    error,
    bridge: {
      ready: false,
      initializing: state.initializing !== false,
      error: state.error || null,
    },
  }, 503);
}

export function buildBridgeStatus(engine: any, manager: any, agent: any) {
  const live = manager?.getStatus?.(agent.id) || {};
  const bridge = agent.config?.bridge || {};
  const index = engine.getBridgeIndex?.(agent.id) || {};
  const feishuDomainInfo = feishuStatusDomainInfo(bridge.feishu);

  const platformStatus = (plat: any, cfg: any, extraFields: any) => {
    const enabled = !!cfg?.enabled;
    const configError = extraFields?.configError || null;
    return {
      ...extraFields,
      enabled,
      status: enabled && configError ? "error" : live[plat]?.status || "disconnected",
      error: enabled && configError ? configError : live[plat]?.error || configError,
      agentId: agent.id,
    };
  };

  const tgToken = bridge.telegram?.token || "";
  const fsAppId = bridge.feishu?.appId || "";
  const fsAppSecret = bridge.feishu?.appSecret || "";
  const qqSecret = preferredQQSecret(bridge.qq);
  const dtRaw = bridge.dingtalk || {};
  let dtCorpId = cleanBridgeString(dtRaw.corpId);
  let dtAuthMode = dtRaw.authMode === "legacy_app" ? "legacy_app" : "current";
  let dtClientId = firstBridgeString(dtRaw.clientId, dtRaw.appKey);
  let dtClientSecret = firstBridgeString(dtRaw.clientSecret, dtRaw.appSecret);
  let dtRobotCode = cleanBridgeString(dtRaw.robotCode);
  let dtApiBaseUrl = firstBridgeString(dtRaw.apiBaseUrl, dtRaw.restBaseUrl, DINGTALK_API_BASE_URL);
  const dtHasConfig = !!(
    dtRaw.enabled
    || dtCorpId
    || dtRaw.authMode
    || dtClientId
    || dtClientSecret
    || dtRobotCode
    || dtRaw.apiBaseUrl
    || dtRaw.restBaseUrl
    || dtRaw.streamOpenUrl
    || dtRaw.webhook
    || dtRaw.webhookUrl
    || dtRaw.webhookToken
    || dtRaw.webhookSecret
    || dtRaw.robotWebhook
    || dtRaw.robotToken
    || dtRaw.token
    || dtRaw.secret
  );
  let dtConfigured = false;
  let dtConfigError = null;
  if (dtHasConfig) {
    try {
      const normalized = normalizeDingTalkBridgeCredentials(dtRaw);
      dtCorpId = normalized.corpId;
      dtAuthMode = normalized.authMode;
      dtClientId = normalized.clientId;
      dtClientSecret = normalized.clientSecret;
      dtRobotCode = normalized.robotCode;
      dtApiBaseUrl = normalized.apiBaseUrl;
      dtConfigured = true;
    } catch (err: any) {
      try {
        const canonical = canonicalizeDingTalkBridgeConfig(dtRaw);
        dtCorpId = canonical.corpId;
        dtAuthMode = canonical.authMode === "legacy_app" ? "legacy_app" : "current";
        dtClientId = canonical.clientId;
        dtClientSecret = canonical.clientSecret;
        dtRobotCode = canonical.robotCode;
        dtApiBaseUrl = canonical.apiBaseUrl;
      } catch {
        // Keep the raw projection above when even URL canonicalization fails.
      }
      dtConfigError = err?.message || String(err);
    }
  }

  const ownerDict = {};
  for (const plat of KNOWN_PLATFORMS) {
    const o = resolveBridgeOwnerUserId({ platform: plat, agent, index });
    if (o) ownerDict[plat] = o;
  }

  const readOnly = engine.getBridgeReadOnly?.() === true;
  const permissionMode = engine.getBridgePermissionMode?.()
    || normalizeBridgePermissionMode({ readOnly });
  const receiptEnabled = engine.getBridgeReceiptEnabled?.() !== false;
  const richStreamingEnabled = engine.getBridgeRichStreamingEnabled?.() !== false;

  return {
    agentId: agent.id,
    telegram: platformStatus("telegram", bridge.telegram, {
      configured: !!tgToken, token: maskSecretValue(tgToken), hasToken: !!tgToken,
    }),
    feishu: platformStatus("feishu", bridge.feishu, {
      configured: !!(fsAppId && fsAppSecret && !feishuDomainInfo.configError),
      appId: fsAppId,
      appSecret: maskSecretValue(fsAppSecret),
      hasAppSecret: !!fsAppSecret,
      region: feishuDomainInfo.region,
      domain: feishuDomainInfo.domain,
      configError: feishuDomainInfo.configError,
    }),
    dingtalk: platformStatus("dingtalk", bridge.dingtalk, {
      configured: dtConfigured,
      authMode: dtAuthMode,
      corpId: dtCorpId,
      clientId: dtClientId,
      clientSecret: maskSecretValue(dtClientSecret),
      hasClientSecret: !!dtClientSecret,
      robotCode: dtRobotCode,
      apiBaseUrl: dtApiBaseUrl,
      // Compatibility projection for pre-canonical desktop clients.
      restBaseUrl: dtApiBaseUrl,
      configError: dtConfigError,
    }),
    qq: platformStatus("qq", bridge.qq, {
      configured: !!(bridge.qq?.appID && qqSecret),
      appID: bridge.qq?.appID || "",
      appSecret: maskSecretValue(qqSecret),
      hasAppSecret: !!qqSecret,
    }),
    wechat: platformStatus("wechat", bridge.wechat, {
      configured: !!bridge.wechat?.botToken,
      token: maskSecretValue(bridge.wechat?.botToken || ""),
      hasBotToken: !!bridge.wechat?.botToken,
    }),
    permissionMode,
    readOnly,
    receiptEnabled,
    richStreamingEnabled,
    knownUsers: collectKnownUsers(index),
    owner: ownerDict,
  };
}

export function createBridgeRoute(engine: any, bridgeManagerRef: any) {
  const route = new Hono();
  const bridgeRef = normalizeBridgeManagerRef(bridgeManagerRef);

  function resolveBridgeManager() {
    return bridgeRef.get?.() || null;
  }

  async function ensureBridgeManager() {
    const existing = resolveBridgeManager();
    if (existing) return existing;
    try {
      return await bridgeRef.ensureReady?.() || null;
    } catch {
      return null;
    }
  }

  /**
   * Bridge reads answer for exactly one agent, so the request has to name it.
   * There is no server-wide "current" agent that is the right answer for every
   * connected client, so a request without an agentId gets a 404 rather than
   * whichever agent the server happens to be focused on.
   */
  function withReadAgent(handler: (c: any, agent: any) => any) {
    return async (c: any) => {
      let agent;
      try {
        agent = resolveAgentStrict(engine, c);
      } catch (err) {
        if (err instanceof AgentNotFoundError) return c.json({ error: err.message }, 404);
        throw err;
      }
      return handler(c, agent);
    };
  }

  /** 获取所有平台连接状态（从 agent.config.bridge 读取） */
  route.get("/bridge/status", withReadAgent(async (c, agent) => {
    const manager = resolveBridgeManager();
    const bridgeState = bridgeRef.getState?.() || { ready: !!manager, initializing: false, error: null };
    return c.json({
      ...buildBridgeStatus(engine, manager, agent),
      bridgeReady: !!manager,
      bridgeInitializing: !!bridgeState.initializing,
      bridgeError: bridgeState.error || null,
    });
  }));

  /** 设置 owner（哪个账号是你）— 写入 agent.config.bridge */
  route.post("/bridge/owner", async (c) => {
    const body = await safeJson(c);
    const { platform, userId } = body;
    if (!platform || !KNOWN_PLATFORMS.includes(platform)) {
      return c.json({ ok: false, error: "invalid platform" });
    }
    const scopeDenied = denyWithoutScope(c, "bridge.manage");
    if (scopeDenied) return scopeDenied;
    const agent = resolveAgentStrict(engine, c);
    agent.updateConfig({ bridge: { [platform]: { owner: userId || null } } });
    debugLog()?.log("api", `POST /api/bridge/owner agent=${agent.id} platform=${platform} owner=${userId ? "[set]" : "[cleared]"}`);
    return c.json({ ok: true, status: buildBridgeStatus(engine, resolveBridgeManager(), agent) });
  });

  /** 保存凭证 + 启停平台（写入 agent.config.bridge） */
  route.post("/bridge/config", async (c) => {
    const body = await safeJson(c);
    const { platform, credentials, enabled } = body;
    if (!platform || !KNOWN_PLATFORMS.includes(platform)) {
      return c.json({ error: "invalid platform" }, 400);
    }
    const scopeDenied = denyWithoutScope(c, "bridge.manage");
    if (scopeDenied) return scopeDenied;
    const secretFields = credentials
      ? collectSecretPatchPaths({ credentials }, bridgeSecretKeys(platform))
      : [];
    const secretDenied = denySecretMutationWithoutScope(c, secretFields);
    if (secretDenied) return secretDenied;

    const agent = resolveAgentStrict(engine, c);
    const agentId = agent.id;

    const bridgeCfg = agent.config?.bridge?.[platform] || {};
    let patch = { ...bridgeCfg };

    if (credentials) {
      try {
        if (platform === "dingtalk") {
          patch = mergeDingTalkCredentialInput(bridgeCfg, credentials);
        } else if (platform === "qq") {
          patch = mergeQQCredentialInput(bridgeCfg, credentials);
        } else {
          patch = { ...patch, ...resolveBridgeCredentials(platform, credentials, bridgeCfg) };
        }
      } catch (err: any) {
        return c.json({ ok: false, error: err?.message || String(err) }, 400);
      }
    }
    if (typeof enabled === "boolean") patch.enabled = enabled;
    if (platform === "feishu") {
      try {
        patch.region = resolveFeishuDomain(patch.region).region;
      } catch (err: any) {
        return c.json({ ok: false, error: err?.message || String(err) }, 400);
      }
    }
    if (platform === "dingtalk") {
      try {
        assertNoUnsupportedDingTalkRobotFields(patch);
        patch = canonicalizeDingTalkBridgeConfig(patch);
        if (patch.enabled) normalizeDingTalkBridgeCredentials(patch);
      } catch (err: any) {
        return c.json({ ok: false, error: err?.message || String(err) }, 400);
      }
    }

    agent.updateConfig({ bridge: { [platform]: patch } });

    let persistedPatch = agent.config?.bridge?.[platform] || patch;

    if (platform === "dingtalk") {
      const incoming = resolveDingTalkDiagnosticSecret(credentials, bridgeCfg);
      let persisted;
      try {
        persisted = canonicalizeDingTalkBridgeConfig(agent.config?.bridge?.dingtalk || {});
      } catch (err: any) {
        resolveBridgeManager()?.stopPlatform(platform, agentId);
        return c.json({
          ok: false,
          error: `DingTalk configuration could not be reloaded after save: ${err?.message || String(err)}`,
        }, 500);
      }
      debugLog()?.log(
        "api",
        `[dingtalk] ${formatSecretFingerprintComparison({
          stage: "config_save",
          beforeLabel: incoming.label,
          before: incoming.value,
          afterLabel: "persisted",
          after: persisted.clientSecret,
        })}`,
      );
      const suppliedPlaintextSecret = hasPlaintextDingTalkSecret(credentials);
      if (suppliedPlaintextSecret && patch.clientSecret !== persisted.clientSecret) {
        resolveBridgeManager()?.stopPlatform(platform, agentId);
        return c.json({
          ok: false,
          error: "DingTalk Client Secret was not persisted intact; the connector was not started",
        }, 500);
      }
      persistedPatch = persisted;
    }

    // Start/stop
    if (persistedPatch.enabled) {
      const manager = await ensureBridgeManager();
      if (!manager) return bridgeUnavailable(c, bridgeRef.getState?.() || {});
      manager.startPlatformFromConfig(platform, persistedPatch, agentId);
    } else {
      resolveBridgeManager()?.stopPlatform(platform, agentId);
    }

    debugLog()?.log("api", `POST /api/bridge/config agent=${agentId} platform=${platform} enabled=${!!patch.enabled}`);
    recordSecurityAuditEvent(c, engine, {
      action: "settings.bridge.config.update",
      target: `bridge.${platform}`,
      secretFields,
      metadata: { agentId, platform, enabled: typeof enabled === "boolean" ? enabled : null },
    } as any);
    return c.json({ ok: true });
  });

  /** 更新 bridge 总设置（permissionMode / legacy readOnly / receiptEnabled / richStreamingEnabled）— global preferences */
  route.post("/bridge/settings", async (c) => {
    const body = await safeJson(c);
    const scopeDenied = denyWithoutScope(c, "bridge.manage");
    if (scopeDenied) return scopeDenied;
    const { permissionMode, readOnly, receiptEnabled, richStreamingEnabled } = body;
    if (typeof permissionMode === "string") {
      const normalized = normalizeBridgePermissionMode({ permissionMode });
      if (normalized !== permissionMode) {
        return c.json({ ok: false, error: "invalid bridge permission mode" }, 400);
      }
      engine.setBridgePermissionMode?.(normalized);
    } else if (typeof readOnly === "boolean") {
      engine.setBridgeReadOnly(readOnly);
      engine.setBridgePermissionMode?.(
        readOnly ? SESSION_PERMISSION_MODES.READ_ONLY : SESSION_PERMISSION_MODES.AUTO,
      );
    }
    if (typeof receiptEnabled === "boolean") {
      engine.setBridgeReceiptEnabled(receiptEnabled);
    }
    if (typeof richStreamingEnabled === "boolean") {
      engine.setBridgeRichStreamingEnabled?.(richStreamingEnabled);
    }
    debugLog()?.log(
      "api",
      `POST /api/bridge/settings permissionMode=${permissionMode} readOnly=${readOnly} receiptEnabled=${receiptEnabled} richStreamingEnabled=${richStreamingEnabled}`,
    );
    const savedPermissionMode = engine.getBridgePermissionMode?.()
      || normalizeBridgePermissionMode({ readOnly: engine.getBridgeReadOnly() });
    return c.json({
      ok: true,
      permissionMode: savedPermissionMode,
      readOnly: engine.getBridgeReadOnly(),
      receiptEnabled: engine.getBridgeReceiptEnabled(),
      richStreamingEnabled: engine.getBridgeRichStreamingEnabled?.() !== false,
    });
  });

  /** 停止指定平台 */
  route.post("/bridge/stop", async (c) => {
    const body = await safeJson(c);
    const { platform } = body;
    if (!platform) {
      return c.json({ error: "platform required" }, 400);
    }
    const scopeDenied = denyWithoutScope(c, "bridge.manage");
    if (scopeDenied) return scopeDenied;

    const agent = resolveAgentStrict(engine, c);
    resolveBridgeManager()?.stopPlatform(platform, agent.id);
    agent.updateConfig({ bridge: { [platform]: { enabled: false } } });

    debugLog()?.log("api", `POST /api/bridge/stop agent=${agent.id} platform=${platform}`);
    return c.json({ ok: true });
  });

  /** 获取最近消息日志（实时内存缓冲） */
  route.get("/bridge/messages", withReadAgent(async (c, agent) => {
    const limit = parseInt(c.req.query("limit"), 10) || 50;
    return c.json({ messages: resolveBridgeManager()?.getMessages(limit, agent.id) || [] });
  }));

  /** 获取 bridge session 列表 */
  route.get("/bridge/sessions", withReadAgent(async (c, agent) => {
    const platform = c.req.query("platform"); // optional filter
    const index = engine.getBridgeIndex(agent.id);
    const bridgeDir = path.join(agent.sessionDir, "bridge");
    const sessions = [];

    for (const [sessionKey, raw] of Object.entries(index) as [string, any][]) {
      // 兼容旧格式（字符串）和新格式（对象）
      const entry = typeof raw === "string" ? { file: raw } : raw;
      const file = entry.file;
      if (!file) continue;

      // 解析 sessionKey → 平台 + 类型
      const { platform: plat, chatType, chatId } = parseSessionKey(sessionKey);

      // 按平台过滤
      if (platform && plat !== platform) continue;

      // 获取最后修改时间
      let lastActive = null;
      const fp = path.resolve(bridgeDir, file);
      const bridgeRoot = path.resolve(bridgeDir);
      if (!fp.startsWith(bridgeRoot + path.sep)) continue;
      try {
        const stat = fs.statSync(fp);
        lastActive = stat.mtimeMs;
      } catch {}

      const identity = resolveBridgeSessionIdentity(entry, { sessionKey, parsed: { platform: plat, chatType, chatId } });
      const userId = identity.userId || (plat === "wechat" && chatType === "dm" ? chatId : null);
      const aliases = identity.aliases;
      const isOwner = isBridgeOwner({ platform: plat, chatType, userId, aliases, agent });

      sessions.push({
        sessionKey, platform: plat, chatType, chatId, file, sessionPath: fp, lastActive,
        displayName: identity.displayName || null,
        avatarUrl: identity.avatarUrl || null,
        isOwner,
      });
    }

    // 按最后活跃时间排序
    sessions.sort((a, b) => (b.lastActive || 0) - (a.lastActive || 0));
    return c.json({ sessions });
  }));

  /** 读取指定 bridge session 的消息 */
  route.get("/bridge/sessions/:sessionKey/messages", withReadAgent(async (c, agent) => {
    const sessionKey = c.req.param("sessionKey");
    const index = engine.getBridgeIndex(agent.id);
    const raw = index[sessionKey];
    const file = typeof raw === "string" ? raw : raw?.file;
    if (!file) return c.json({ error: "session not found", messages: [] });

    const bridgeDir = path.join(agent.sessionDir, "bridge");
    const fp = path.resolve(bridgeDir, file);

    // 防止 path traversal
    if (!fp.startsWith(path.resolve(bridgeDir) + path.sep)) {
      return c.json({ error: "invalid session path", messages: [] });
    }

    try {
      const rawContent = fs.readFileSync(fp, "utf-8");
      const lines = rawContent.trim().split("\n").map(l => {
        try { return JSON.parse(l); } catch { return null; }
      }).filter(Boolean);

      const messages = [];
      for (const line of lines) {
        if (line.type !== "message") continue;
        const msg = line.message;
        if (!msg || (msg.role !== "user" && msg.role !== "assistant")) continue;

        let textContent = "";
        let mediaCount = 0;
        if (Array.isArray(msg.content)) {
          for (const b of msg.content) {
            if (b.type === "text" && b.text) textContent += b.text;
            if (b.type === "image") mediaCount++;
          }
        } else if (typeof msg.content === "string") {
          textContent = msg.content;
        }

        const hasMedia = mediaCount > 0;
        if (!textContent && !hasMedia) continue;
        const visibleContent = sanitizeBridgeVisibleText(textContent) || (hasMedia ? `[图片 x${mediaCount}]` : "");
        messages.push({
          role: msg.role,
          content: visibleContent,
          hasMedia,
          mediaCount,
          ts: line.timestamp || null,
        });
      }

      return c.json({ messages });
    } catch (err) {
      return c.json({ error: err.message, messages: [] });
    }
  }));

  /** 重置 bridge session（清除上下文，下次消息新建 session） */
  route.post("/bridge/sessions/:sessionKey/reset", async (c) => {
    const sessionKey = c.req.param("sessionKey");
    const agent = resolveAgentStrict(engine, c);
    const agentId = agent.id;
    const index = engine.getBridgeIndex(agentId);
    const raw = index[sessionKey];
    if (!raw) return c.json({ ok: false, error: "session not found" });

    // 保留元数据（name, avatarUrl），只删 file 引用
    const entry = typeof raw === "string" ? {} : { ...raw };
    delete entry.file;
    index[sessionKey] = entry;
    engine.saveBridgeIndex(index, agentId);

    return c.json({ ok: true });
  });

  /** 公开给外部平台拉取的临时媒体 URL（由 MediaPublisher token 控制） */
  route.get("/bridge/media/:token", async (c) => {
    const token = c.req.param("token");
    const entry = resolveBridgeManager()?.mediaPublisher?.resolve?.(token);
    if (!entry) return c.text("media not found", 404);

    let stat;
    try {
      stat = fs.statSync(entry.realPath);
      if (!stat.isFile()) return c.text("media not found", 404);
    } catch {
      return c.text("media not found", 404);
    }
    if (stat.size > MAX_BRIDGE_MEDIA_SIZE) {
      return c.text("media too large", 413);
    }

    const filename = entry.filename || path.basename(entry.realPath);
    const disposition = isInlineBridgeMediaMime(entry.mime) ? "inline" : "attachment";
    const headers = new Headers({
      "content-type": entry.mime || "application/octet-stream",
      "content-length": String(stat.size),
      "content-disposition": `${disposition}; filename*=UTF-8''${encodeRfc5987ValueChars(filename)}`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    return new Response(fs.readFileSync(entry.realPath), { headers });
  });

  /** 发送媒体到 bridge 平台（桌面端推送文件） */
  route.post("/bridge/send-media", async (c) => {
    const body = await safeJson(c);
    const { platform, chatId, filePath } = body;
    if (!platform || !chatId || !filePath) {
      return c.json({ error: "platform, chatId, filePath required" }, 400);
    }

    const agent = resolveAgentStrict(engine, c);

    // 路径安全检查：对齐 Bridge runtime 的媒体发送白名单。
    const allowedRoots = collectBridgeMediaAllowedRoots(engine, { agentId: agent.id, agent });

    // 先检查文件是否存在
    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved)) {
      return c.json({ error: "file not found" }, 404);
    }

    // 用 realpathSync 解析 symlink，防止 symlink 绕过白名单
    let realPath;
    try { realPath = fs.realpathSync(resolved); }
    catch { return c.json({ error: "file not found" }, 404); }

    const isSafe = isInsideBridgeMediaRoot(realPath, allowedRoots);
    if (!isSafe) {
      return c.json({ error: "path outside allowed roots" }, 403);
    }

    // Fix 3: 文件大小保护（50MB 上限，避免同步读大文件卡事件循环）
    try {
      const stat = fs.statSync(realPath);
      if (stat.size > MAX_BRIDGE_MEDIA_SIZE) {
        return c.json({ error: `file too large: ${(stat.size / 1024 / 1024).toFixed(1)}MB (max 50MB)` }, 413);
      }
    } catch { return c.json({ error: "file not found" }, 404); }

    try {
      const manager = await ensureBridgeManager();
      if (!manager) return bridgeUnavailable(c, bridgeRef.getState?.() || {});
      if (typeof engine.registerSessionFile !== "function") {
        return c.json({ ok: false, error: "session file registry unavailable" }, 500);
      }
      if (typeof manager.sendMediaItem !== "function") {
        return c.json({ ok: false, error: "bridge media delivery unavailable" }, 500);
      }

      const sessionPath = typeof body.sessionPath === "string" && body.sessionPath.trim()
        ? body.sessionPath.trim()
        : buildBridgeManualSendSessionPath(agent.id, platform, chatId);
      const sessionFile = engine.registerSessionFile({
        sessionPath,
        filePath: realPath,
        label: typeof body.label === "string" && body.label.trim() ? body.label.trim() : path.basename(realPath),
        origin: "bridge_manual_send",
      });
      await manager.sendMediaItem(
        platform,
        chatId,
        {
          type: "session_file",
          fileId: sessionFile.id,
          ...(sessionFile.sessionId ? { sessionId: sessionFile.sessionId } : {}),
          sessionPath,
        },
        agent.id,
      );
      return c.json({ ok: true, fileId: sessionFile.id });
    } catch (err) {
      return c.json(
        { ok: false, error: err.message },
        isUnsupportedMediaDeliveryError(err) ? 422 : 500,
      );
    }
  });

  /** 测试凭证（不启动轮询） */
  route.post("/bridge/test", async (c) => {
    const body = await safeJson(c);
    const { platform, useSavedCredentials } = body;
    if (useSavedCredentials !== undefined && typeof useSavedCredentials !== "boolean") {
      return c.json({ error: "useSavedCredentials must be a boolean" }, 400);
    }
    const credentials = body.credentials && typeof body.credentials === "object"
      ? body.credentials
      : null;
    if (!platform || (!credentials && useSavedCredentials !== true)) {
      return c.json({ error: "platform and credentials required" }, 400);
    }

    if (!KNOWN_PLATFORMS.includes(platform)) {
      return c.json({ error: "unknown platform" }, 400);
    }
    const scopeDenied = denyWithoutScope(c, "bridge.manage");
    if (scopeDenied) return scopeDenied;
    const providedCredentials = credentials || {};
    const secretFields = collectSecretPatchPaths({ credentials: providedCredentials }, bridgeSecretKeys(platform));
    const secretDenied = denySecretMutationWithoutScope(c, secretFields);
    if (secretDenied) return secretDenied;

    try {
      const usesMaskedCredentials = hasMaskedBridgeCredentials(platform, providedCredentials);
      if (useSavedCredentials !== true && usesMaskedCredentials) {
        return c.json({ error: "masked credentials require useSavedCredentials=true" }, 400);
      }
      const shouldUseSavedCredentials = useSavedCredentials === true;
      if (shouldUseSavedCredentials && !hasExplicitAgentId(c)) {
        return c.json({ error: "agentId is required when testing saved or masked bridge credentials" }, 400);
      }
      const saved = shouldUseSavedCredentials
        ? resolveAgentStrict(engine, c).config?.bridge?.[platform] || {}
        : {};
      const resolvedCredentials = platform === "dingtalk"
        ? mergeDingTalkCredentialInput(shouldUseSavedCredentials ? saved : {}, providedCredentials)
        : platform === "qq"
          ? mergeQQCredentialInput(shouldUseSavedCredentials ? saved : {}, providedCredentials)
          : resolveBridgeCredentials(platform, providedCredentials, saved);
      const effectiveCredentials = shouldUseSavedCredentials && platform !== "dingtalk" && platform !== "qq"
        ? { ...saved, ...resolvedCredentials }
        : resolvedCredentials;
      if (platform === "telegram") {
        const TelegramBot = (await import("node-telegram-bot-api")).default;
        const bot = new TelegramBot(effectiveCredentials.token, telegramBotOptions());
        const me = await bot.getMe();
        return c.json({ ok: true, info: { username: me.username, name: me.first_name } });
      } else if (platform === "feishu") {
        const domainInfo = resolveFeishuDomain(effectiveCredentials.region);
        const resp = await fetch(domainInfo.tenantTokenUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            app_id: effectiveCredentials.appId,
            app_secret: effectiveCredentials.appSecret,
          }),
          signal: AbortSignal.timeout(10_000),
        });
        const data = await resp.json();
        if (data.code === 0) {
          return c.json({
            ok: true,
            info: {
              msg: t("error.tokenSuccess"),
              ...feishuTestInfo({ credentialOk: true, response: resp, data, domainInfo }),
            },
          });
        }
        return c.json({
          ok: false,
          error: data.msg || t("error.verifyFailed"),
          info: feishuTestInfo({ credentialOk: false, response: resp, data, domainInfo }),
        });
      } else if (platform === "dingtalk") {
        const dingtalkCredentials = normalizeDingTalkBridgeCredentials(effectiveCredentials);
        try {
          const dingtalkHttp = createBridgeOutboundHttp({
            platform: "dingtalk",
            fetchImpl: fetch as any,
          });
          const result = await requestDingTalkAccessToken(
            dingtalkCredentials,
            (request) => dingtalkHttp.request({
              stage: "token_test",
              url: request.url,
              ...request.init,
              timeoutMs: 10_000,
              idempotent: true,
              maxRetries: 0,
            }),
            (request) => {
              debugLog()?.log(
                "api",
                `[dingtalk] ${formatSecretFingerprintComparison({
                  stage: "credential_test",
                  beforeLabel: shouldUseSavedCredentials ? "saved" : "normalized",
                  before: shouldUseSavedCredentials
                    ? preferredDingTalkSecret(saved)
                    : dingtalkCredentials.clientSecret,
                  afterLabel: shouldUseSavedCredentials ? "effective" : "outbound",
                  after: shouldUseSavedCredentials
                    ? dingtalkCredentials.clientSecret
                    : "client_secret" in request.payload
                      ? request.payload.client_secret
                      : request.payload.appSecret,
                })}`,
              );
            },
          );
          return c.json({
            ok: true,
            info: {
              msg: t("error.tokenSuccess"),
              ...dingtalkTestInfo({
                credentialOk: true,
                authMode: dingtalkCredentials.authMode,
                metadata: result.metadata,
              }),
            },
          });
        } catch (err: any) {
          if (!(err instanceof DingTalkApiError)) throw err;
          const errorInfo = dingtalkErrorInfo(err);
          return c.json({
            ok: false,
            error: errorInfo?.dingtalkMessage || t("error.verifyFailed"),
            info: dingtalkTestInfo({
              credentialOk: false,
              authMode: dingtalkCredentials.authMode,
              errorInfo,
            }),
          });
        }
      } else if (platform === "qq") {
        // v2 鉴权：appID + appSecret → access_token → /users/@me
        const tokenRes = await fetch("https://bots.qq.com/app/getAppAccessToken", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ appId: effectiveCredentials.appID, clientSecret: effectiveCredentials.appSecret }),
        });
        const tokenData = await tokenRes.json();
        if (!tokenData.access_token) {
          return c.json({ ok: false, error: tokenData.message || t("error.tokenFetchFailed") });
        }
        const meRes = await fetch("https://api.sgroup.qq.com/users/@me", {
          headers: { Authorization: `QQBot ${tokenData.access_token}` },
        });
        const me = await meRes.json();
        if (me.id) {
          return c.json({ ok: true, info: { username: me.username, name: me.username } });
        }
        return c.json({ ok: false, error: me.message || t("error.botInfoFailed") });
      }
      if (platform === "wechat") {
        // 用 getconfig 验证 token（不污染 cursor）
        const crypto = await import("node:crypto");
        const uin = Buffer.from(String(crypto.randomBytes(4).readUInt32BE(0)), "utf-8").toString("base64");
        const res = await fetch("https://ilinkai.weixin.qq.com/ilink/bot/getconfig", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "AuthorizationType": "ilink_bot_token",
            "Authorization": `Bearer ${effectiveCredentials.botToken}`,
            "X-WECHAT-UIN": uin,
          },
          body: JSON.stringify({ base_info: { channel_version: "1.0.0" } }),
          signal: AbortSignal.timeout(10_000),
        });
        const data = await res.json();
        if (data.ret && data.ret !== 0) {
          return c.json({ ok: false, error: data.errmsg || `errcode ${data.ret}` });
        }
        return c.json({ ok: true, info: { msg: "微信 iLink 连接成功" } });
      }
      return c.json({ ok: false, error: t("error.platformTestUnsupported") });
    } catch (err) {
      return c.json({ ok: false, error: err.message });
    }
  });

  /** 获取微信扫码登录二维码 */
  route.post("/bridge/wechat/qrcode", async (c) => {
    const { getWechatQrcode } = await import("../../lib/bridge/wechat-login.ts");
    return c.json(await getWechatQrcode());
  });

  /** 轮询微信扫码状态 */
  route.post("/bridge/wechat/qrcode-status", async (c) => {
    const body = await safeJson(c);
    const { qrcodeId } = body;
    const { pollWechatQrcodeStatus } = await import("../../lib/bridge/wechat-login.ts");
    return c.json(await pollWechatQrcodeStatus(qrcodeId));
  });

  return route;
}

function resolveBridgeCredentials(platform: any, credentials: any, existing: any): any {
  return resolveSecretPatch({
    patch: credentials,
    existing,
    secretKeys: bridgeSecretKeys(platform),
  });
}

function hasOwnBridgeField(value: any, field: string) {
  return Boolean(value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, field));
}

function mergeDingTalkCredentialInput(existing: any, credentials: any) {
  const source = credentials && typeof credentials === "object" ? credentials : {};
  const saved = canonicalizeDingTalkBridgeConfig(
    existing && typeof existing === "object" ? existing : {},
  );
  const merged: Record<string, any> = {
    ...saved,
    ...source,
  };

  // Patch precedence is request-local: canonical wins when both forms appear;
  // otherwise a legacy field may intentionally replace or clear canonical
  // state. Persist only the canonical form after the merge.
  if (hasOwnBridgeField(source, "clientId")) merged.clientId = source.clientId;
  else if (hasOwnBridgeField(source, "appKey")) merged.clientId = source.appKey;

  if (hasOwnBridgeField(source, "clientSecret")) {
    merged.clientSecret = isMaskedSecretValue(source.clientSecret)
      ? saved.clientSecret
      : source.clientSecret;
  } else if (hasOwnBridgeField(source, "appSecret")) {
    merged.clientSecret = isMaskedSecretValue(source.appSecret)
      ? saved.clientSecret
      : source.appSecret;
  }

  if (hasOwnBridgeField(source, "apiBaseUrl")) merged.apiBaseUrl = source.apiBaseUrl;
  else if (hasOwnBridgeField(source, "restBaseUrl")) merged.apiBaseUrl = source.restBaseUrl;

  merged.appKey = null;
  merged.appSecret = null;
  merged.restBaseUrl = null;
  return canonicalizeDingTalkBridgeConfig(merged);
}

function preferredDingTalkSecret(value: any) {
  if (hasOwnBridgeField(value, "clientSecret")) return cleanBridgeString(value.clientSecret);
  return cleanBridgeString(value?.appSecret);
}

function mergeQQCredentialInput(existing: any, credentials: any) {
  const saved = existing && typeof existing === "object" ? existing : {};
  const source = credentials && typeof credentials === "object" ? credentials : {};
  const savedSecret = preferredQQSecret(saved);
  const merged: Record<string, any> = { ...saved, ...source };

  if (hasOwnBridgeField(source, "appSecret")) {
    merged.appSecret = isMaskedSecretValue(source.appSecret)
      ? savedSecret
      : source.appSecret;
  } else if (hasOwnBridgeField(source, "token")) {
    merged.appSecret = isMaskedSecretValue(source.token)
      ? savedSecret
      : source.token;
  } else {
    merged.appSecret = savedSecret;
  }
  merged.token = null;
  return merged;
}

function preferredQQSecret(value: any) {
  if (hasOwnBridgeField(value, "appSecret")) return cleanBridgeString(value.appSecret);
  return cleanBridgeString(value?.token);
}

function hasPlaintextDingTalkSecret(credentials: any) {
  const source = credentials && typeof credentials === "object" ? credentials : {};
  return (hasOwnBridgeField(source, "clientSecret") && !isMaskedSecretValue(source.clientSecret))
    || (hasOwnBridgeField(source, "appSecret") && !isMaskedSecretValue(source.appSecret));
}

function resolveDingTalkDiagnosticSecret(credentials: any, existing: any) {
  const source = credentials && typeof credentials === "object" ? credentials : {};
  const incomingClientSecret = source.clientSecret;
  const incomingAppSecret = source.appSecret;
  if (incomingClientSecret !== undefined && !isMaskedSecretValue(incomingClientSecret)) {
    return { label: "incoming", value: incomingClientSecret };
  }
  if (incomingAppSecret !== undefined && !isMaskedSecretValue(incomingAppSecret)) {
    return { label: "incoming", value: incomingAppSecret };
  }
  return { label: "saved", value: preferredDingTalkSecret(existing) };
}

function hasMaskedBridgeCredentials(platform: any, credentials: any) {
  const secretKeys = bridgeSecretKeys(platform);
  return secretKeys.some((key) => isMaskedSecretValue(credentials?.[key]));
}

function hasExplicitAgentId(c: any) {
  return Boolean(c.req.query("agentId") || c.req.param("agentId"));
}

function bridgeSecretKeys(platform: any): any {
  return platform === "feishu"
    ? ["appSecret"]
    : platform === "dingtalk"
      ? ["clientSecret", "appSecret", "webhookToken", "webhookSecret", "token", "secret"]
      : platform === "qq"
        ? ["appSecret", "token"]
        : platform === "wechat"
          ? ["botToken"]
          : ["token"];
}

function buildBridgeManualSendSessionPath(agentId: any, platform: any, chatId: any) {
  return `bridge:${agentId}:${platform}:${chatId}`;
}

function isUnsupportedMediaDeliveryError(err: any) {
  const message = String(err?.message || err || "");
  return /暂不支持|不支持|unsupported|不能直接消费|public_url fallback|cannot deliver|does not support media input mode/i.test(message);
}

function encodeRfc5987ValueChars(value: any) {
  return encodeURIComponent(value)
    .replace(/['()]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/\*/g, "%2A");
}

function isInlineBridgeMediaMime(mime: any) {
  const value = String(mime || "").toLowerCase();
  return value.startsWith("image/") || value.startsWith("video/");
}
