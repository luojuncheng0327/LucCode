export const DINGTALK_API_BASE_URL = "https://api.dingtalk.com/v1.0";
export const DINGTALK_LEGACY_REST_API_BASE_URL = "https://api.dingtalk.io/v1.0";
export const DINGTALK_LEGACY_AUTH_MODE = "legacy_app";
// Compatibility export for callers that have not renamed the setting yet.
export const DINGTALK_REST_API_BASE_URL = DINGTALK_API_BASE_URL;
export const DINGTALK_STREAM_API_BASE_URL = DINGTALK_API_BASE_URL;

export const DINGTALK_BOT_CALLBACK_TOPIC = "/v1.0/im/bot/messages/get";
export const DINGTALK_STREAM_OPEN_PATH = "/gateway/connections/open";
export const DINGTALK_DM_SEND_PATH = "/robot/oToMessages/batchSend";
export const DINGTALK_GROUP_SEND_PATH = "/robot/groupMessages/send";

export const DINGTALK_STREAM_OPEN_URL = buildDingTalkUrl(
  DINGTALK_STREAM_API_BASE_URL,
  DINGTALK_STREAM_OPEN_PATH,
);
export const DINGTALK_DM_SEND_URL = buildDingTalkUrl(
  DINGTALK_API_BASE_URL,
  DINGTALK_DM_SEND_PATH,
);
export const DINGTALK_GROUP_SEND_URL = buildDingTalkUrl(
  DINGTALK_API_BASE_URL,
  DINGTALK_GROUP_SEND_PATH,
);

const CUSTOM_ROBOT_FIELDS: Record<string, string> = {
  webhook: "custom robot webhook URL",
  webhookUrl: "custom robot webhook URL",
  webhookToken: "custom robot webhook access token",
  webhookSecret: "custom robot webhook signing secret",
  robotWebhook: "custom robot webhook URL",
  robotToken: "custom robot webhook access token",
  token: "custom robot token",
  secret: "custom robot signing secret",
};

export interface DingTalkBridgeCredentials {
  authMode: "current" | "legacy_app";
  corpId: string;
  clientId: string;
  clientSecret: string;
  robotCode: string;
  apiBaseUrl: string;
  streamOpenUrl: string;
}

function cleanString(value: unknown) {
  const text = typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
  return text || "";
}

function hasValue(value: unknown) {
  return cleanString(value).length > 0;
}

function firstNonEmpty(...values: unknown[]) {
  for (const value of values) {
    const cleaned = cleanString(value);
    if (cleaned) return cleaned;
  }
  return "";
}

function hasOwn(input: Record<string, any>, key: string) {
  return Object.prototype.hasOwnProperty.call(input, key);
}

function canonicalField(
  input: Record<string, any>,
  canonicalKey: string,
  legacyKey: string,
) {
  // Once the canonical field exists it owns the value, including an explicit
  // empty string. Falling back only on truthiness would resurrect a legacy
  // credential that the user already cleared.
  return hasOwn(input, canonicalKey)
    ? cleanString(input[canonicalKey])
    : cleanString(input[legacyKey]);
}

export function buildDingTalkUrl(baseUrl: string, path: string) {
  const base = normalizeDingTalkBaseUrl(baseUrl, "DingTalk API base URL");
  const url = new URL(path.startsWith("/") ? path.slice(1) : path, `${base}/`);
  return url.toString();
}

export function normalizeDingTalkBaseUrl(value: unknown, label = "DingTalk base URL") {
  const raw = cleanString(value);
  if (!raw) throw new Error(`${label} is required`);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${label} must be an absolute http(s) URL`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`${label} must be an absolute http(s) URL`);
  }
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/$/, "");
}

export function normalizeDingTalkApiBaseUrl(value: unknown) {
  const normalized = normalizeDingTalkBaseUrl(value, "DingTalk API base URL");
  return normalized === DINGTALK_LEGACY_REST_API_BASE_URL
    ? DINGTALK_API_BASE_URL
    : normalized;
}

function normalizeDingTalkAuthMode(value: unknown) {
  const mode = cleanString(value);
  if (!mode || mode === "current") return "current" as const;
  if (mode === DINGTALK_LEGACY_AUTH_MODE) return DINGTALK_LEGACY_AUTH_MODE;
  throw new Error("Unsupported DingTalk authMode");
}

export function normalizeDingTalkEndpointUrl(value: unknown, label: string) {
  const raw = cleanString(value);
  if (!raw) throw new Error(`${label} is required`);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${label} must be an absolute http(s) URL`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`${label} must be an absolute http(s) URL`);
  }
  url.hash = "";
  return url.toString();
}

export function assertNoUnsupportedDingTalkRobotFields(input: Record<string, any> = {}) {
  const customFields = Object.entries(CUSTOM_ROBOT_FIELDS)
    .filter(([field]) => hasValue(input?.[field]))
    .map(([, label]) => label);
  if (customFields.length) {
    throw new Error(
      `DingTalk custom robot webhook fields (${Array.from(new Set(customFields)).join(", ")}) ` +
      "cannot be used by the Enterprise Stream connector. Configure corpId, clientId/clientSecret, robotCode, and API base URL instead.",
    );
  }
}

/**
 * Converts persisted legacy aliases at the route boundary. `null` is
 * intentional: Agent config deepMerge interprets it as deletion.
 */
export function canonicalizeDingTalkBridgeConfig(input: Record<string, any> = {}) {
  assertNoUnsupportedDingTalkRobotFields(input);
  const corpId = cleanString(input.corpId);
  const requestedAuthMode = normalizeDingTalkAuthMode(input.authMode);
  // A real corpId is the explicit signal that the user completed the current
  // credential contract. The persisted compatibility marker is removed then.
  const authMode = corpId ? "current" : requestedAuthMode;
  const streamOpenUrl = cleanString(input.streamOpenUrl);
  const apiBaseUrl = hasOwn(input, "apiBaseUrl")
    ? cleanString(input.apiBaseUrl) || (authMode === DINGTALK_LEGACY_AUTH_MODE
      ? DINGTALK_LEGACY_REST_API_BASE_URL
      : DINGTALK_API_BASE_URL)
    : firstNonEmpty(
      input.restBaseUrl,
      authMode === DINGTALK_LEGACY_AUTH_MODE
        ? DINGTALK_LEGACY_REST_API_BASE_URL
        : DINGTALK_API_BASE_URL,
    );
  const result: Record<string, any> = {
    ...input,
    authMode: authMode === DINGTALK_LEGACY_AUTH_MODE ? DINGTALK_LEGACY_AUTH_MODE : null,
    corpId,
    clientId: canonicalField(input, "clientId", "appKey"),
    clientSecret: canonicalField(input, "clientSecret", "appSecret"),
    robotCode: cleanString(input.robotCode),
    apiBaseUrl: authMode === DINGTALK_LEGACY_AUTH_MODE
      ? normalizeDingTalkBaseUrl(apiBaseUrl, "DingTalk API base URL")
      : normalizeDingTalkApiBaseUrl(apiBaseUrl),
    appKey: null,
    appSecret: null,
    restBaseUrl: null,
  };
  if (streamOpenUrl) {
    result.streamOpenUrl = normalizeDingTalkEndpointUrl(streamOpenUrl, "DingTalk Stream open endpoint");
  } else if (Object.prototype.hasOwnProperty.call(input, "streamOpenUrl")) {
    result.streamOpenUrl = null;
  }
  return result;
}

export function normalizeDingTalkBridgeCredentials(input: Record<string, any> = {}): DingTalkBridgeCredentials {
  const canonical = canonicalizeDingTalkBridgeConfig(input);
  const authMode = canonical.authMode === DINGTALK_LEGACY_AUTH_MODE
    ? DINGTALK_LEGACY_AUTH_MODE
    : "current";
  const corpId = canonical.corpId;
  const clientId = canonical.clientId;
  const clientSecret = canonical.clientSecret;
  const robotCode = canonical.robotCode;
  const missing = [];
  if (authMode === "current" && !corpId) missing.push("organization corpId");
  if (!clientId) missing.push("internal app clientId");
  if (!clientSecret) missing.push("internal app clientSecret");
  if (!robotCode) missing.push("enterprise robotCode");
  if (missing.length) {
    throw new Error(`DingTalk Enterprise Stream connector requires ${missing.join(", ")}`);
  }

  return {
    authMode,
    corpId,
    clientId,
    clientSecret,
    robotCode,
    apiBaseUrl: canonical.apiBaseUrl,
    streamOpenUrl: normalizeDingTalkEndpointUrl(canonical.streamOpenUrl || DINGTALK_STREAM_OPEN_URL, "DingTalk Stream open endpoint"),
  };
}
