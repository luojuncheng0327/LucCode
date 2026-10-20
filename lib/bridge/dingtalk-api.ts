import {
  buildDingTalkUrl,
  normalizeDingTalkBridgeCredentials,
  type DingTalkBridgeCredentials,
} from "./dingtalk-contract.ts";
import { redactSecretsFromText } from "../secret-fingerprint.ts";

export const DINGTALK_TOKEN_RESPONSE_BODY_TIMEOUT_MS = 10_000;
export const DINGTALK_TOKEN_RESPONSE_MAX_BYTES = 64 * 1024;
export const DINGTALK_TOKEN_MAX_TTL_SECONDS = 24 * 60 * 60;

export interface DingTalkAccessTokenRequest {
  url: string;
  init: {
    method: "POST";
    headers: Record<string, string>;
    body: string;
  };
  payload: {
    client_id: string;
    client_secret: string;
    grant_type: "client_credentials";
  } | {
    appKey: string;
    appSecret: string;
  };
}

export interface DingTalkAccessTokenResult {
  token: string;
  expiresIn: number;
  metadata: DingTalkSafeMetadata;
}

export interface DingTalkSafeMetadata {
  httpStatus: number | null;
  dingtalkCode?: string | number;
  dingtalkMessage?: string;
}

export class DingTalkApiError extends Error {
  stage: string;
  code: string | number;
  httpStatus: number | null;

  constructor({ stage, code, httpStatus, message }: {
    stage: string;
    code: string | number;
    httpStatus?: number | null;
    message: string;
  }) {
    super(`[dingtalk:${stage}] ${message || "request failed"} (code=${code})`);
    this.name = "DingTalkApiError";
    this.stage = stage;
    this.code = code;
    this.httpStatus = httpStatus ?? null;
  }
}

export function buildDingTalkAccessTokenRequest(
  input: DingTalkBridgeCredentials | Record<string, any>,
): DingTalkAccessTokenRequest {
  const credentials = normalizeDingTalkBridgeCredentials(input);
  const payload: DingTalkAccessTokenRequest["payload"] = credentials.authMode === "legacy_app"
    ? {
      appKey: credentials.clientId,
      appSecret: credentials.clientSecret,
    }
    : {
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      grant_type: "client_credentials" as const,
    };
  return {
    url: buildDingTalkUrl(credentials.apiBaseUrl, credentials.authMode === "legacy_app"
      ? "/oauth2/accessToken"
      : `/oauth2/${encodeURIComponent(credentials.corpId)}/token`),
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    payload,
  };
}

function responseReadError(reason: string) {
  return new Error(`DingTalk token response ${reason}`);
}

function utf8ByteLength(value: string) {
  return new TextEncoder().encode(value).byteLength;
}

function withBodyTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout?: () => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      try { onTimeout?.(); } catch {}
      reject(responseReadError(`body timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function readBoundedResponseText(response: any, timeoutMs: number, maxBytes: number) {
  const stream = response?.body;
  if (stream && typeof stream.getReader === "function") {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    const deadline = Date.now() + timeoutMs;
    try {
      while (true) {
        const remainingMs = Math.max(1, deadline - Date.now());
        const result = await withBodyTimeout(
          Promise.resolve(reader.read()),
          remainingMs,
          () => { void reader.cancel?.(); },
        );
        if (result?.done) break;
        const chunk = result?.value instanceof Uint8Array
          ? result.value
          : new Uint8Array(result?.value || []);
        total += chunk.byteLength;
        if (total > maxBytes) {
          try { await reader.cancel?.(); } catch {}
          throw responseReadError(`body exceeded ${maxBytes} bytes`);
        }
        chunks.push(chunk);
      }
    } finally {
      try { reader.releaseLock?.(); } catch {}
    }
    const joined = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      joined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(joined);
  }

  if (typeof response?.text === "function") {
    const text = await withBodyTimeout(Promise.resolve(response.text()), timeoutMs);
    if (utf8ByteLength(String(text || "")) > maxBytes) {
      throw responseReadError(`body exceeded ${maxBytes} bytes`);
    }
    return String(text || "");
  }
  return null;
}

export async function readDingTalkResponse(
  response: any,
  {
    timeoutMs = DINGTALK_TOKEN_RESPONSE_BODY_TIMEOUT_MS,
    maxBytes = DINGTALK_TOKEN_RESPONSE_MAX_BYTES,
  }: { timeoutMs?: number; maxBytes?: number } = {},
) {
  const text = await readBoundedResponseText(response, timeoutMs, maxBytes);
  if (text !== null) {
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  // Test transports and a few SDK response shims expose only json(). This is
  // still a single body read, never a retry after another reader consumed it.
  if (typeof response?.json === "function") {
    const data = await withBodyTimeout(Promise.resolve(response.json()), timeoutMs);
    const serialized = JSON.stringify(data);
    if (serialized && utf8ByteLength(serialized) > maxBytes) {
      throw responseReadError(`body exceeded ${maxBytes} bytes`);
    }
    return data;
  }
  return {};
}

function responseCode(data: any, status: number | undefined, secrets: unknown[]) {
  const raw = data?.code ?? data?.errcode ?? data?.errorCode ?? status ?? "unknown";
  return typeof raw === "number" ? raw : redactSecretsFromText(raw, secrets);
}

function responseMessage(data: any, secrets: unknown[]) {
  // Never reflect a non-JSON token response verbatim. Proxies can return HTML,
  // request dumps, or other arbitrary text that is not safe API metadata.
  const raw = (data && typeof data === "object" ? data?.message : "")
    || data?.errmsg
    || data?.msg
    || data?.error_description
    || data?.errorMessage
    || data?.error
    || "request failed";
  return redactSecretsFromText(raw, secrets);
}

function responseCodeIsSuccess(code: unknown) {
  return code === undefined || code === null || code === 0 || code === "0";
}

export function parseDingTalkAccessTokenResponse({
  response,
  data,
  credentials,
}: {
  response: any;
  data: any;
  credentials: DingTalkBridgeCredentials;
}) {
  const code = data?.code ?? data?.errcode ?? data?.errorCode;
  const rawToken = credentials.authMode === "legacy_app"
    ? data?.accessToken ?? data?.access_token
    : data?.access_token;
  const token = typeof rawToken === "string" ? rawToken.trim() : "";
  const rawExpiresIn = credentials.authMode === "legacy_app"
    ? data?.expireIn ?? data?.expiresIn ?? data?.expires_in
    : data?.expires_in;
  const expiresIn = credentials.authMode === "legacy_app" ? Number(rawExpiresIn) : rawExpiresIn;
  const secrets = [credentials.clientSecret, token, data?.accessToken, data?.access_token];
  if (
    !response?.ok
    || !responseCodeIsSuccess(code)
    || !token
    || !Number.isSafeInteger(expiresIn)
    || expiresIn <= 0
    || expiresIn > DINGTALK_TOKEN_MAX_TTL_SECONDS
  ) {
    throw new DingTalkApiError({
      stage: "token",
      code: responseCode(data, response?.status, secrets),
      httpStatus: response?.status,
      message: responseMessage(data, secrets),
    });
  }
  return {
    token,
    expiresIn,
    metadata: {
      httpStatus: typeof response?.status === "number" ? response.status : null,
      ...(code !== undefined
        ? { dingtalkCode: responseCode(data, response?.status, secrets) }
        : {}),
    },
  };
}

/**
 * Shared token flow for the REST test route and runtime adapter. The transport
 * callback keeps proxy/retry policy owned by each caller while request and
 * response field mapping remain a single contract.
 */
export async function requestDingTalkAccessToken(
  input: DingTalkBridgeCredentials | Record<string, any>,
  transport: (request: DingTalkAccessTokenRequest) => Promise<any>,
  onRequestBuilt?: (request: DingTalkAccessTokenRequest, credentials: DingTalkBridgeCredentials) => void,
): Promise<DingTalkAccessTokenResult> {
  const credentials = normalizeDingTalkBridgeCredentials(input);
  const request = buildDingTalkAccessTokenRequest(credentials);
  onRequestBuilt?.(request, credentials);
  let response;
  try {
    response = await transport(request);
  } catch (error: any) {
    const safeMessage = redactSecretsFromText(error?.message || String(error), [credentials.clientSecret]);
    const safeCode = error?.code
      ? redactSecretsFromText(error.code, [credentials.clientSecret])
      : "network_error";
    throw new DingTalkApiError({
      stage: "token",
      code: safeCode,
      httpStatus: null,
      message: safeMessage,
    });
  }
  let data;
  try {
    data = await readDingTalkResponse(response);
  } catch (error: any) {
    throw new DingTalkApiError({
      stage: "token",
      code: "response_read_error",
      httpStatus: response?.status,
      message: redactSecretsFromText(error?.message || "failed to read response", [credentials.clientSecret]),
    });
  }
  return parseDingTalkAccessTokenResponse({ response, data, credentials });
}

export function dingtalkErrorInfo(error: unknown) {
  if (!(error instanceof DingTalkApiError)) return null;
  return {
    httpStatus: error.httpStatus,
    dingtalkCode: error.code,
    dingtalkMessage: error.message.replace(/^\[dingtalk:[^\]]+\]\s*/, "").replace(/\s+\(code=.*\)$/, ""),
  };
}
