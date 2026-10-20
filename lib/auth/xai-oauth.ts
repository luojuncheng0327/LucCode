import type {
  OAuthLoginCallbacks,
  SdkOAuthProvider,
} from "../pi-sdk/index.ts";

export const XAI_OAUTH_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
export const XAI_OAUTH_DISCOVERY_URL = "https://auth.x.ai/.well-known/openid-configuration";
export const XAI_OAUTH_SCOPES = "openid profile email offline_access grok-cli:access api:access";
export const XAI_OAUTH_RESOURCE_URL = "https://cli-chat-proxy.grok.com/v1";

const XAI_OAUTH_REQUEST_TIMEOUT_MS = 30_000;
const MAX_TIMER_MILLISECONDS = 2_147_483_647;

type OAuthCredentials = Awaited<ReturnType<SdkOAuthProvider["login"]>>;
type FetchLike = typeof globalThis.fetch;

interface XaiOAuthDriverOptions {
  fetchImpl?: FetchLike;
  now?: () => number;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

interface XaiDiscoveryDocument {
  device_authorization_endpoint?: unknown;
  token_endpoint?: unknown;
}

interface TokenPayload {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  id_token?: unknown;
  error?: unknown;
  error_description?: unknown;
}

function abortError(signal?: AbortSignal) {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error("xAI OAuth login aborted");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw abortError(signal);
}

function defaultSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function trustedXaiAuthEndpoint(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`xAI OAuth discovery missing ${label}`);
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`xAI OAuth discovery returned invalid ${label}`);
  }
  if (parsed.protocol !== "https:"
    || parsed.hostname !== "auth.x.ai"
    || parsed.port
    || parsed.username
    || parsed.password
    || parsed.hash) {
    throw new Error(`xAI OAuth discovery returned untrusted ${label}`);
  }
  return parsed.toString();
}

function trustedXaiUserFacingUrl(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`xAI OAuth response missing ${label}`);
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`xAI OAuth response returned invalid ${label}`);
  }
  const hostname = parsed.hostname.toLowerCase();
  const isXaiHost = hostname === "x.ai" || hostname.endsWith(".x.ai");
  if (parsed.protocol !== "https:"
    || !isXaiHost
    || parsed.port
    || parsed.username
    || parsed.password) {
    throw new Error(`xAI OAuth response returned unsafe ${label}`);
  }
  return parsed.toString();
}

function positiveSeconds(value: unknown): number | null {
  const seconds = typeof value === "string" && value.trim() ? Number(value) : value;
  return typeof seconds === "number"
    && Number.isFinite(seconds)
    && seconds > 0
    && seconds * 1000 <= MAX_TIMER_MILLISECONDS
    ? seconds
    : null;
}

function requestSignal(externalSignal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(XAI_OAUTH_REQUEST_TIMEOUT_MS);
  return externalSignal
    ? AbortSignal.any([externalSignal, timeoutSignal])
    : timeoutSignal;
}

function jwtExpiryMilliseconds(accessToken: string): number | null {
  const parts = accessToken.split(".");
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf-8"));
    return typeof payload?.exp === "number" && Number.isFinite(payload.exp)
      ? payload.exp * 1000
      : null;
  } catch {
    return null;
  }
}

function tokenExpiry(payload: TokenPayload, accessToken: string, now: () => number): number {
  const expiresIn = positiveSeconds(payload.expires_in);
  if (expiresIn !== null) return now() + expiresIn * 1000;
  const jwtExpiry = jwtExpiryMilliseconds(accessToken);
  if (jwtExpiry !== null && jwtExpiry > now()) return jwtExpiry;
  throw new Error("xAI OAuth token response missing a valid expiration");
}

function oauthErrorMessage(payload: TokenPayload, fallback: string): string {
  const code = typeof payload.error === "string" ? payload.error : "";
  const description = typeof payload.error_description === "string" ? payload.error_description : "";
  if (code && description) return `${code}: ${description}`;
  return code || description || fallback;
}

async function readJsonResponse(response: Response, label: string): Promise<Record<string, unknown>> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`xAI OAuth ${label} returned invalid JSON`);
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`xAI OAuth ${label} returned an invalid payload`);
  }
  return payload as Record<string, unknown>;
}

function formBody(values: Record<string, string>) {
  return new URLSearchParams(values).toString();
}

function formRequest(body: string, signal?: AbortSignal): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal,
  };
}

function buildCredentials(
  payload: TokenPayload,
  options: {
    now: () => number;
    tokenEndpoint: string;
    previousRefresh?: string;
    requireRefresh: boolean;
  },
): OAuthCredentials {
  if (typeof payload.access_token !== "string" || !payload.access_token) {
    throw new Error("xAI OAuth token response missing access_token");
  }
  const refresh = typeof payload.refresh_token === "string" && payload.refresh_token
    ? payload.refresh_token
    : options.previousRefresh;
  if (options.requireRefresh && !refresh) {
    throw new Error("xAI OAuth token response missing refresh_token");
  }
  if (!refresh) {
    throw new Error("xAI OAuth refresh response has no usable refresh token");
  }
  return {
    access: payload.access_token,
    refresh,
    expires: tokenExpiry(payload, payload.access_token, options.now),
    tokenEndpoint: options.tokenEndpoint,
    ...(typeof payload.id_token === "string" && payload.id_token
      ? { idToken: payload.id_token }
      : {}),
  };
}

export function createXaiOAuthProvider(options: XaiOAuthDriverOptions = {}): SdkOAuthProvider {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const now = options.now || Date.now;
  const sleep = options.sleep || defaultSleep;
  if (typeof fetchImpl !== "function") {
    throw new Error("xAI OAuth requires a Fetch implementation");
  }

  async function discover(signal?: AbortSignal) {
    throwIfAborted(signal);
    const response = await fetchImpl(XAI_OAUTH_DISCOVERY_URL, {
      headers: { Accept: "application/json" },
      signal: requestSignal(signal),
    });
    const payload = await readJsonResponse(response, "discovery endpoint") as XaiDiscoveryDocument;
    if (!response.ok) {
      throw new Error(`xAI OAuth discovery failed with HTTP ${response.status}`);
    }
    return {
      deviceEndpoint: trustedXaiAuthEndpoint(
        payload.device_authorization_endpoint,
        "device_authorization_endpoint",
      ),
      tokenEndpoint: trustedXaiAuthEndpoint(payload.token_endpoint, "token_endpoint"),
    };
  }

  async function postToken(
    tokenEndpoint: string,
    values: Record<string, string>,
    signal?: AbortSignal,
  ) {
    throwIfAborted(signal);
    const response = await fetchImpl(
      tokenEndpoint,
      formRequest(formBody(values), requestSignal(signal)),
    );
    const payload = await readJsonResponse(response, "token endpoint") as TokenPayload;
    return { response, payload };
  }

  return {
    name: "xAI Grok (OAuth)",

    async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
      const signal = callbacks.signal;
      const { deviceEndpoint, tokenEndpoint } = await discover(signal);
      const deviceResponse = await fetchImpl(
        deviceEndpoint,
        formRequest(formBody({
          client_id: XAI_OAUTH_CLIENT_ID,
          scope: XAI_OAUTH_SCOPES,
        }), requestSignal(signal)),
      );
      const device = await readJsonResponse(deviceResponse, "device authorization endpoint");
      if (!deviceResponse.ok) {
        throw new Error(`xAI OAuth device authorization failed: ${oauthErrorMessage(device, `HTTP ${deviceResponse.status}`)}`);
      }
      const deviceCode = typeof device.device_code === "string" ? device.device_code : "";
      const userCode = typeof device.user_code === "string" ? device.user_code : "";
      const verificationUri = typeof device.verification_uri === "string"
        ? device.verification_uri
        : (typeof device.verification_url === "string" ? device.verification_url : "");
      const expiresInSeconds = positiveSeconds(device.expires_in);
      const intervalSecondsValue = device.interval === undefined
        ? 5
        : positiveSeconds(device.interval);
      let intervalSeconds = intervalSecondsValue;
      if (!deviceCode
        || !userCode
        || !verificationUri
        || expiresInSeconds === null
        || intervalSeconds === null) {
        throw new Error("xAI OAuth device authorization response is incomplete");
      }
      const trustedVerificationUri = trustedXaiUserFacingUrl(verificationUri, "verification_uri");
      callbacks.onDeviceCode({
        userCode,
        verificationUri: trustedVerificationUri,
        intervalSeconds,
        expiresInSeconds,
      });

      const deadline = now() + expiresInSeconds * 1000;
      while (now() < deadline) {
        await sleep(intervalSeconds * 1000, signal);
        throwIfAborted(signal);
        if (now() >= deadline) break;
        const { response, payload } = await postToken(tokenEndpoint, {
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: deviceCode,
          client_id: XAI_OAUTH_CLIENT_ID,
        }, signal);
        if (response.ok && !payload.error) {
          return buildCredentials(payload, {
            now,
            tokenEndpoint,
            requireRefresh: true,
          });
        }
        const errorCode = typeof payload.error === "string" ? payload.error : "";
        if (errorCode === "authorization_pending") continue;
        if (errorCode === "slow_down") {
          const slowedInterval = positiveSeconds(intervalSeconds + 5);
          if (slowedInterval === null) {
            throw new Error("xAI OAuth polling interval exceeds the safe timer range");
          }
          intervalSeconds = slowedInterval;
          continue;
        }
        if (errorCode === "access_denied" || errorCode === "authorization_denied") {
          throw new Error("xAI OAuth authorization was denied");
        }
        if (errorCode === "expired_token") {
          throw new Error("xAI OAuth device code expired");
        }
        throw new Error(`xAI OAuth token exchange failed: ${oauthErrorMessage(payload, `HTTP ${response.status}`)}`);
      }
      throwIfAborted(signal);
      throw new Error("xAI OAuth device code expired");
    },

    async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
      if (typeof credentials.refresh !== "string" || !credentials.refresh) {
        throw new Error("xAI OAuth credentials missing refresh token");
      }
      const tokenEndpoint = credentials.tokenEndpoint === undefined
        ? (await discover()).tokenEndpoint
        : trustedXaiAuthEndpoint(credentials.tokenEndpoint, "cached token_endpoint");
      const { response, payload } = await postToken(tokenEndpoint, {
        grant_type: "refresh_token",
        refresh_token: credentials.refresh,
        client_id: XAI_OAUTH_CLIENT_ID,
      });
      if (!response.ok || payload.error) {
        throw new Error(`xAI OAuth token refresh failed: ${oauthErrorMessage(payload, `HTTP ${response.status}`)}`);
      }
      return buildCredentials(payload, {
        now,
        tokenEndpoint,
        previousRefresh: credentials.refresh,
        requireRefresh: false,
      });
    },

    getApiKey(credentials: OAuthCredentials): string {
      return credentials.access;
    },
  };
}

export const xaiOAuthProvider = createXaiOAuthProvider();
