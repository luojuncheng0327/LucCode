/**
 * outbound-http.ts — Bridge 出站 REST 统一出口（#1612）
 *
 * 背景：QQ adapter 的 WS 通过 webSocketOptionsForUrl 显式走代理，而 token /
 * gateway / sendReply 等 REST 调用此前用 Node 内建 fetch 直连。Node 内建
 * fetch 不读取 npm undici 的 global dispatcher（两份 undici 拷贝的 registry
 * 互不相通，Node v24 实测），于是代理环境下"WS 收得到、REST 发不出"，错误
 * 只剩笼统的 "fetch failed"，没有阶段标识。
 *
 * 本模块统一管理 Bridge adapter 的出站 REST：
 *   - 代理：per-URL dispatcher 来自 lib/net/outbound-proxy 的 fetchDispatcherForUrl
 *     （与 WS 同一份配置源），配合 npm undici 的 fetch 使用——同一拷贝，
 *     dispatcher 契约锁定，不再依赖跨拷贝的 global dispatcher 假设
 *   - 超时：显式常量 BRIDGE_HTTP_TIMEOUT_MS（覆盖连接 + 响应头；响应体读取
 *     归调用方，沿用 mcp-http-client 的语义）
 *   - 重试：仅调用方显式声明 idempotent 的请求做有限重试（网络错误 / 超时 /
 *     429 / 5xx），上限 BRIDGE_HTTP_MAX_RETRIES，指数退避基数
 *     BRIDGE_HTTP_RETRY_BASE_DELAY_MS。发送类调用（send_reply 等）没有
 *     客户端去重保障，默认绝不自动重试，避免重复发消息
 *   - 诊断：失败必带 [platform:stage]、目标 host（不含 path/query，预签名
 *     URL 的签名不泄漏）、尝试次数、代理路由（凭证打码）、底层错误码
 *
 * 设计为所有 Bridge adapter 可复用；当前只有 QQ adapter 迁入（#1612 控制
 * 爆炸半径），其余平台后续逐个迁移。
 */

import { fetch as undiciFetch } from "undici";
import { fetchDispatcherForUrl } from "../net/outbound-proxy.ts";

/** 单次尝试的超时（连接 + 响应头）。 */
export const BRIDGE_HTTP_TIMEOUT_MS = 30_000;
/** 幂等请求在首次尝试之外的最大重试次数。 */
export const BRIDGE_HTTP_MAX_RETRIES = 2;
/** 重试退避基数：第 n 次重试前等待 base * 2^(n-1)。 */
export const BRIDGE_HTTP_RETRY_BASE_DELAY_MS = 1000;

export class BridgeHttpError extends Error {
  declare platform: string;
  declare stage: string;
  declare method: string;
  declare host: string;
  declare proxied: boolean;
  declare proxyUrl: string;
  declare attempts: number;
  declare timedOut: boolean;

  constructor(message: string, fields: {
    platform: string;
    stage: string;
    method: string;
    host: string;
    proxied: boolean;
    proxyUrl: string;
    attempts: number;
    timedOut: boolean;
    cause?: unknown;
  }) {
    super(message, fields.cause === undefined ? undefined : { cause: fields.cause });
    this.name = "BridgeHttpError";
    this.platform = fields.platform;
    this.stage = fields.stage;
    this.method = fields.method;
    this.host = fields.host;
    this.proxied = fields.proxied;
    this.proxyUrl = fields.proxyUrl;
    this.attempts = fields.attempts;
    this.timedOut = fields.timedOut;
  }
}

function redactUrlCredentials(value: string) {
  try {
    const url = new URL(value);
    if (url.username) url.username = "***";
    if (url.password) url.password = "***";
    return url.href.replace(/\/$/, "");
  } catch {
    return "";
  }
}

/** 提取底层网络错误的可读细节（内建/undici fetch 把真实原因塞在 cause 里）。 */
function describeCause(err: any) {
  if (!err) return "unknown error";
  const cause = err.cause;
  if (cause instanceof AggregateError && Array.isArray(cause.errors) && cause.errors.length) {
    const parts = cause.errors.map((e: any) => e?.code || e?.message).filter(Boolean);
    if (parts.length) return `${err.message} → ${parts.join(", ")}`;
  }
  if (cause) {
    const detail = cause.code || cause.message;
    if (detail) return `${err.message} → ${detail}`;
  }
  return err.message || String(err);
}

function isRetryableStatus(status: number) {
  return status === 429 || status >= 500;
}

function defaultSleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface BridgeOutboundRequestOptions {
  /** 调用阶段标识（token / gateway / send_reply / ...），必填，进诊断消息。 */
  stage: string;
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: any;
  /** 单次尝试超时；默认 BRIDGE_HTTP_TIMEOUT_MS。 */
  timeoutMs?: number;
  /** 仅幂等/可安全重复的调用允许置 true；发送类调用必须保持 false。 */
  idempotent?: boolean;
  /** 幂等重试上限；默认 BRIDGE_HTTP_MAX_RETRIES。 */
  maxRetries?: number;
}

export function createBridgeOutboundHttp({
  platform,
  fetchImpl = undiciFetch,
  resolveDispatcher = fetchDispatcherForUrl,
  sleep = defaultSleep,
}: {
  platform: string;
  fetchImpl?: typeof undiciFetch;
  resolveDispatcher?: typeof fetchDispatcherForUrl;
  sleep?: (ms: number) => Promise<unknown>;
}) {
  if (!platform || typeof platform !== "string") {
    throw new Error("createBridgeOutboundHttp requires an explicit platform label");
  }

  async function request({
    stage,
    url,
    method = "GET",
    headers,
    body,
    timeoutMs = BRIDGE_HTTP_TIMEOUT_MS,
    idempotent = false,
    maxRetries = BRIDGE_HTTP_MAX_RETRIES,
  }: BridgeOutboundRequestOptions) {
    if (!stage || typeof stage !== "string") {
      throw new Error(`[${platform}] outbound request requires an explicit stage label`);
    }
    let host = "";
    try {
      host = new URL(url).host;
    } catch {
      throw new Error(`[${platform}:${stage}] outbound request URL is not parsable`);
    }

    const { dispatcher, proxyUrl } = resolveDispatcher(url) || { dispatcher: null, proxyUrl: "" };
    const proxied = !!proxyUrl;
    const redactedProxy = proxied ? redactUrlCredentials(proxyUrl) : "";
    const route = proxied ? `proxy ${redactedProxy}` : "direct";
    const attempts = idempotent ? Math.max(1, maxRetries + 1) : 1;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      let timedOut = false;
      const controller = new AbortController();
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
      try {
        const res: any = await fetchImpl(url as any, {
          method,
          headers,
          body,
          signal: controller.signal,
          ...(dispatcher ? { dispatcher } : {}),
        } as any);
        if (attempt < attempts && isRetryableStatus(res.status)) {
          // 释放连接，丢弃这轮可重试响应的 body（状态语义仍归调用方：
          // 最后一轮的响应原样返回，由调用方解析错误细节）
          try { await res.body?.cancel?.(); } catch { /* body 可能已被消费或不存在 */ }
          await sleep(BRIDGE_HTTP_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
          continue;
        }
        return res;
      } catch (err) {
        if (attempt < attempts) {
          await sleep(BRIDGE_HTTP_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
          continue;
        }
        const what = timedOut
          ? `timed out after ${timeoutMs}ms`
          : `failed: ${describeCause(err)}`;
        throw new BridgeHttpError(
          `[${platform}:${stage}] ${method} ${host} ${what} (${attempt}/${attempts} attempts, ${route})`,
          { platform, stage, method, host, proxied, proxyUrl: redactedProxy, attempts: attempt, timedOut, cause: err },
        );
      } finally {
        clearTimeout(timer);
      }
    }
    // 循环要么 return 要么 throw；走到这里说明上面的不变量被破坏了
    throw new Error(`[${platform}:${stage}] outbound retry loop exited without a result`);
  }

  return { platform, request };
}
