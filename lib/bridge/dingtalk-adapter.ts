/**
 * dingtalk-adapter.ts — 钉钉企业应用机器人 Stream 适配器
 *
 * 官方协议边界：
 * - Stream 注册：POST https://api.dingtalk.com/v1.0/gateway/connections/open
 * - Bot 回调 topic：/v1.0/im/bot/messages/get
 * - 当前应用 accessToken：POST https://api.dingtalk.com/v1.0/oauth2/{corpId}/token
 * - 旧应用 accessToken：POST https://api.dingtalk.io/v1.0/oauth2/accessToken
 * - 单聊发送：POST https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend
 * - 群聊发送：POST https://api.dingtalk.com/v1.0/robot/groupMessages/send
 */

import WebSocket from "ws";
import { createModuleLogger, debugLog } from "../debug-log.ts";
import { webSocketOptionsForUrl } from "../net/outbound-proxy.ts";
import { formatSecretFingerprintComparison, redactSecretsFromText } from "../secret-fingerprint.ts";
import { createBridgeOutboundHttp } from "./outbound-http.ts";
import { createStreamingCapabilities } from "./streaming-capabilities.ts";
import {
  DINGTALK_BOT_CALLBACK_TOPIC,
  DINGTALK_DM_SEND_PATH,
  DINGTALK_DM_SEND_URL,
  DINGTALK_GROUP_SEND_PATH,
  DINGTALK_GROUP_SEND_URL,
  DINGTALK_STREAM_OPEN_URL,
  buildDingTalkUrl,
  normalizeDingTalkBridgeCredentials,
} from "./dingtalk-contract.ts";
import { requestDingTalkAccessToken } from "./dingtalk-api.ts";

const log = createModuleLogger("dingtalk");

export {
  DINGTALK_BOT_CALLBACK_TOPIC,
  DINGTALK_DM_SEND_URL,
  DINGTALK_GROUP_SEND_URL,
  DINGTALK_STREAM_OPEN_URL,
};

const MAX_MSG_SIZE = 100_000;
const MAX_OUTBOUND_TEXT_BYTES = 12_000;
const TOKEN_EXPIRY_SKEW_MS = 60_000;
const DEFAULT_RECONNECT_DELAY_MS = 5_000;

export const DINGTALK_STREAMING_CAPABILITIES = createStreamingCapabilities({
  platform: "dingtalk",
  mode: "batch",
  scopes: ["dm", "group"],
  maxChars: 15_000,
  renderer: "text",
  source: "https://open-dingtalk.github.io/developerpedia/docs/learn/stream/protocol/",
});

function asString(value: any) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function cleanString(value: any) {
  const s = asString(value).trim();
  return s || null;
}

function safeJsonParse(value: any) {
  if (value == null) return null;
  if (Array.isArray(value)) {
    value = Buffer.concat(value.map((part) => Buffer.isBuffer(part) ? part : Buffer.from(part)));
  }
  if (value instanceof ArrayBuffer) value = Buffer.from(value);
  if (ArrayBuffer.isView(value) && !Buffer.isBuffer(value)) {
    value = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  if (typeof value === "object" && !Buffer.isBuffer(value)) return value;
  const text = Buffer.isBuffer(value) ? value.toString("utf-8") : String(value);
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function responseJsonOrText(res: any) {
  try {
    return await res.json();
  } catch {
    try {
      return await res.text();
    } catch {
      return "";
    }
  }
}

function dingTalkApiError(stage: string, data: any, status?: number, secrets: unknown[] = []) {
  const rawCode = data?.code ?? data?.errcode ?? data?.errorCode ?? status ?? "unknown";
  const code = typeof rawCode === "number" ? rawCode : redactSecretsFromText(rawCode, secrets);
  const message = redactSecretsFromText(
    data?.message || data?.errmsg || data?.msg || data?.errorMessage || data?.error || "request failed",
    secrets,
  );
  return new Error(`[dingtalk:${stage}] ${message || "request failed"} (code=${code})`);
}

function validateDingTalkApiResponse(stage: string, res: any, data: any, secrets: unknown[] = []) {
  const code = data?.code ?? data?.errcode ?? data?.errorCode;
  if (!res?.ok) throw dingTalkApiError(stage, data, res?.status, secrets);
  if (code !== undefined && code !== 0 && code !== "0") throw dingTalkApiError(stage, data, res?.status, secrets);
}

function appendTicket(endpoint: string, ticket: string) {
  const url = new URL(endpoint);
  url.searchParams.set("ticket", ticket);
  return url.toString();
}

function dingTalkTargetScope(options: Record<string, any> = {}) {
  const context = options.replyContext && typeof options.replyContext === "object"
    ? options.replyContext
    : {};
  if (options.targetScope) return String(options.targetScope);
  if (context.targetScope) return String(context.targetScope);
  if (options.isGroup === true || context.isGroup === true) return "group";
  if (options.isGroup === false || context.isGroup === false) return "dm";
  return "dm";
}

function splitTextByUtf8Bytes(text: string, maxBytes = MAX_OUTBOUND_TEXT_BYTES) {
  const value = asString(text);
  if (!value) return [""];
  const chunks = [];
  let current = "";
  let currentBytes = 0;
  for (const char of Array.from(value)) {
    const bytes = Buffer.byteLength(char, "utf-8");
    if (current && currentBytes + bytes > maxBytes) {
      chunks.push(current);
      current = "";
      currentBytes = 0;
    }
    current += char;
    currentBytes += bytes;
  }
  if (current || chunks.length === 0) chunks.push(current);
  return chunks;
}

function markdownPayload(text: string, index: number, total: number) {
  const title = total > 1 ? `Luc ${index + 1}/${total}` : "Luc";
  return JSON.stringify({ title, text });
}

function extractDingTalkText(payload: Record<string, any>) {
  const msgtype = asString(payload.msgtype || payload.msgType).toLowerCase();
  if (msgtype === "text") return asString(payload.text?.content || payload.content?.text || payload.content || "");
  if (msgtype === "audio") {
    const recognition = cleanString(payload.content?.recognition || payload.audio?.recognition);
    if (recognition) return recognition;
  }
  if (Array.isArray(payload.content?.richText)) {
    return payload.content.richText.map((item: any) => asString(item?.text)).join("");
  }
  return "";
}

function unsupportedMessageNotice(payload: Record<string, any>) {
  const msgtype = cleanString(payload.msgtype || payload.msgType) || "unknown";
  return `钉钉消息类型 ${msgtype} 暂未接入文本内容，请在钉钉中改发文字。`;
}

function resolveDingTalkProfile(payload: Record<string, any>, previous: Record<string, any> = {}) {
  const displayName = cleanString(payload.senderNick)
    || cleanString(payload.senderName)
    || cleanString(payload.senderStaffName)
    || cleanString(payload.sender?.nick)
    || cleanString(payload.sender?.name)
    || cleanString(previous.displayName);
  const avatarUrl = cleanString(payload.senderAvatar)
    || cleanString(payload.senderAvatarUrl)
    || cleanString(payload.sender?.avatar)
    || cleanString(payload.sender?.avatarUrl)
    || cleanString(previous.avatarUrl);
  return { displayName, avatarUrl };
}

function normalizeDingTalkInboundMessage(payload: Record<string, any>, agentId: string, profileCache: Map<string, any>) {
  const conversationId = cleanString(payload.conversationId);
  const userId = cleanString(payload.senderStaffId)
    || cleanString(payload.senderId)
    || cleanString(payload.senderUnionId)
    || "unknown";
  const isGroup = String(payload.conversationType || "") !== "1";
  const chatId = isGroup ? conversationId : userId;
  if (!chatId) return null;

  let text = extractDingTalkText(payload);
  if (!text) text = unsupportedMessageNotice(payload);
  if (text.length > MAX_MSG_SIZE) {
    log.warn(`message too large (${text.length} chars), truncated`);
    text = text.slice(0, MAX_MSG_SIZE);
  }

  const sessionKey = isGroup
    ? `dt_group_${chatId}@${agentId}`
    : `dt_dm_${userId}@${agentId}`;
  const previousProfile = profileCache.get(userId) || {};
  const profile = resolveDingTalkProfile(payload, previousProfile);
  profileCache.set(userId, profile);

  return {
    platform: "dingtalk",
    agentId,
    chatId,
    userId,
    sessionKey,
    text,
    senderName: profile.displayName || "DingTalk User",
    displayName: profile.displayName || undefined,
    avatarUrl: profile.avatarUrl || undefined,
    principalId: userId,
    isGroup,
    _msgId: cleanString(payload.msgId) || cleanString(payload.messageId) || null,
  };
}

/**
 * @param {object} opts
 * @param {"legacy_app"} [opts.authMode] - stable 升级配置的显式旧鉴权标记
 * @param {string} opts.corpId - 钉钉组织 ID
 * @param {string} opts.clientId - 钉钉应用 Client ID
 * @param {string} opts.clientSecret - 钉钉应用 Client Secret
 * @param {string} opts.robotCode - 机器人编码
 * @param {string} [opts.apiBaseUrl] - 钉钉 OpenAPI base URL
 * @param {string} [opts.streamOpenUrl] - 钉钉 Stream 连接注册 endpoint
 * @param {string} opts.agentId
 * @param {(msg: object) => void} opts.onMessage
 * @param {(status: string, error?: string) => void} [opts.onStatus]
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {typeof WebSocket} [opts.WebSocketImpl]
 */
export function createDingTalkAdapter({
  authMode,
  corpId,
  appKey,
  appSecret,
  clientId,
  clientSecret,
  robotCode,
  apiBaseUrl,
  restBaseUrl,
  streamOpenUrl,
  agentId,
  onMessage,
  onStatus,
  fetchImpl,
  WebSocketImpl = WebSocket,
  reconnectDelayMs = DEFAULT_RECONNECT_DELAY_MS,
  ...extraConfig
}: {
  authMode?: "legacy_app";
  corpId?: string;
  appKey?: string;
  appSecret?: string;
  clientId?: string;
  clientSecret?: string;
  robotCode: string;
  apiBaseUrl?: string;
  restBaseUrl?: string;
  streamOpenUrl?: string;
  agentId: string;
  onMessage: (msg: Record<string, any>) => void;
  onStatus?: (status: string, error?: string) => void;
  fetchImpl?: any;
  WebSocketImpl?: any;
  reconnectDelayMs?: number;
  [key: string]: any;
}) {
  const contract = normalizeDingTalkBridgeCredentials({
    ...extraConfig,
    authMode,
    corpId,
    appKey,
    appSecret,
    clientId,
    clientSecret,
    robotCode,
    apiBaseUrl,
    restBaseUrl,
    streamOpenUrl,
  });
  const http = createBridgeOutboundHttp({ platform: "dingtalk", fetchImpl });
  let accessToken: string | null = null;
  let tokenExpiresAt = 0;
  let ws: any = null;
  let streamConnected = false;
  let outboundError: string | null = null;
  let stopped = false;
  let reconnectTimer: any = null;
  const profileCache = new Map<string, any>();

  async function getAccessToken() {
    if (accessToken && Date.now() < tokenExpiresAt - TOKEN_EXPIRY_SKEW_MS) return accessToken;
    const result = await requestDingTalkAccessToken(
      contract,
      (request) => http.request({
        stage: "token",
        url: request.url,
        ...request.init,
        idempotent: true,
      }),
      (request) => {
        debugLog()?.log(
          "bridge",
          `[dingtalk] ${formatSecretFingerprintComparison({
            stage: "runtime_token",
            beforeLabel: "normalized",
            before: contract.clientSecret,
            afterLabel: "outbound",
            after: "client_secret" in request.payload
              ? request.payload.client_secret
              : request.payload.appSecret,
          })}`,
        );
      },
    );
    accessToken = result.token;
    tokenExpiresAt = Date.now() + result.expiresIn * 1000;
    return accessToken;
  }

  async function openStreamRegistration() {
    const res = await http.request({
      stage: "stream_open",
      url: contract.streamOpenUrl,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientId: contract.clientId,
        clientSecret: contract.clientSecret,
        subscriptions: [
          { topic: DINGTALK_BOT_CALLBACK_TOPIC, type: "CALLBACK" },
        ],
        ua: "luc-bridge-dingtalk/1.0.0",
      }),
      idempotent: true,
    });
    const data = await responseJsonOrText(res);
    validateDingTalkApiResponse("stream_open", res, data, [contract.clientSecret]);
    const endpoint = cleanString(data?.endpoint);
    const ticket = cleanString(data?.ticket);
    if (!endpoint || !ticket) throw dingTalkApiError("stream_open", data, res?.status, [contract.clientSecret]);
    return { endpoint, ticket };
  }

  function acknowledge(envelope: Record<string, any>) {
    const messageId = envelope?.headers?.messageId;
    const closedState = WebSocketImpl.CLOSED ?? 3;
    if (!messageId || !ws) return;
    if (typeof ws.readyState === "number" && ws.readyState === closedState) return;
    ws.send(JSON.stringify({
      code: 200,
      headers: {
        contentType: "application/json",
        messageId,
      },
      message: "OK",
      data: "{}",
    }));
  }

  function handleStreamMessage(raw: any) {
    const envelope = safeJsonParse(raw);
    if (!envelope || typeof envelope !== "object") return;
    const topic = envelope.headers?.topic;
    const type = envelope.type;
    if (type === "SYSTEM" && topic === "disconnect") {
      try { ws?.close?.(); } catch {}
      return;
    }
    if (type !== "CALLBACK" || topic !== DINGTALK_BOT_CALLBACK_TOPIC) return;

    acknowledge(envelope);
    const payload = safeJsonParse(envelope.data);
    if (!payload || typeof payload !== "object") return;
    if (payload.robotCode && contract.robotCode && payload.robotCode !== contract.robotCode) return;

    const normalized = normalizeDingTalkInboundMessage(payload, agentId, profileCache);
    if (!normalized) return;
    try {
      onMessage(normalized);
    } catch (err: any) {
      debugLog()?.warn("bridge", `[dingtalk] onMessage failed: ${err?.message || err}`);
    }
  }

  function clearReconnectTimer() {
    if (!reconnectTimer) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  function scheduleReconnect(reason?: string) {
    if (stopped || reconnectTimer) return;
    onStatus?.("connecting", reason);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, reconnectDelayMs);
    if (typeof reconnectTimer.unref === "function") reconnectTimer.unref();
  }

  async function connect() {
    if (stopped) return;
    clearReconnectTimer();
    let streamTicket = "";
    let streamUrl = "";
    try {
      const { endpoint, ticket } = await openStreamRegistration();
      streamTicket = ticket;
      if (stopped) return;
      const url = appendTicket(endpoint, ticket);
      streamUrl = url;
      ws = new WebSocketImpl(url, webSocketOptionsForUrl(url));
      ws.on("open", () => {
        streamConnected = true;
        log.log("stream connected");
        if (outboundError) onStatus?.("error", outboundError);
        else onStatus?.("connected");
      });
      ws.on("message", handleStreamMessage);
      ws.on("error", (err: any) => {
        streamConnected = false;
        const message = redactSecretsFromText(
          err?.message || String(err),
          [contract.clientSecret, streamTicket, streamUrl],
        );
        log.error(`stream error: ${message}`);
        onStatus?.("error", message);
      });
      ws.on("close", () => {
        streamConnected = false;
        if (stopped) return;
        log.warn("stream closed, reconnecting");
        scheduleReconnect("stream closed");
      });
    } catch (err: any) {
      streamConnected = false;
      const message = redactSecretsFromText(
        err?.message || String(err),
        [contract.clientSecret, streamTicket, streamUrl],
      );
      log.error(`connect failed: ${message}`);
      onStatus?.("error", message);
      scheduleReconnect(message);
    }
  }

  async function requestRobotApi(stage: string, url: string, body: Record<string, any>) {
    let token: string | null = null;
    try {
      token = await getAccessToken();
      const res = await http.request({
        stage,
        url,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-acs-dingtalk-access-token": token,
        },
        body: JSON.stringify(body),
        idempotent: false,
      });
      const data = await responseJsonOrText(res);
      validateDingTalkApiResponse(stage, res, data, [contract.clientSecret, token]);
      const shouldRestoreConnected = outboundError !== null && streamConnected;
      outboundError = null;
      if (shouldRestoreConnected) onStatus?.("connected");
      return data;
    } catch (err: any) {
      const message = redactSecretsFromText(
        err?.message || String(err),
        [contract.clientSecret, token, accessToken],
      );
      outboundError = message;
      onStatus?.("error", message);
      if (err instanceof Error && err.message === message) throw err;
      throw new Error(message);
    }
  }

  void connect();

  return {
    streamingCapabilities: DINGTALK_STREAMING_CAPABILITIES,

    async sendReply(chatId: string, text: string, options: Record<string, any> = {}) {
      const content = asString(text);
      const scope = dingTalkTargetScope(options);
      const chunks = splitTextByUtf8Bytes(content);
      const results = [];
      for (let i = 0; i < chunks.length; i += 1) {
        const msgParam = markdownPayload(chunks[i], i, chunks.length);
        if (scope === "group") {
          results.push(await requestRobotApi("send_group", buildDingTalkUrl(contract.apiBaseUrl, DINGTALK_GROUP_SEND_PATH), {
            robotCode: contract.robotCode,
            openConversationId: String(chatId),
            msgKey: "sampleMarkdown",
            msgParam,
          }));
        } else {
          results.push(await requestRobotApi("send_dm", buildDingTalkUrl(contract.apiBaseUrl, DINGTALK_DM_SEND_PATH), {
            robotCode: contract.robotCode,
            userIds: [String(chatId)],
            msgKey: "sampleMarkdown",
            msgParam,
          }));
        }
      }
      return results.length === 1 ? results[0] : results;
    },

    stop() {
      stopped = true;
      streamConnected = false;
      clearReconnectTimer();
      const current = ws;
      ws = null;
      try { current?.close?.(); } catch {}
      onStatus?.("disconnected");
    },
  };
}
