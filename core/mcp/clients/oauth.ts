import crypto from "node:crypto";
import { MCP_PROTOCOL_VERSION } from "./stdio-client.ts";
import { McpHttpError } from "./http-client.ts";
import {
  MCP_PROTOCOL_VERSION_HEADER,
  resolveInitialMcpProtocolVersion,
} from "./protocol-version.ts";

export function parseWwwAuthenticate(value) {
  const header = String(value || "");
  const params: any = {};
  const bearer = header.replace(/^Bearer\s+/i, "");
  const pattern = /([a-zA-Z_][a-zA-Z0-9_-]*)=(?:"([^"]*)"|([^,\s]+))/g;
  let match;
  while ((match = pattern.exec(bearer))) {
    params[match[1]] = match[2] ?? match[3] ?? "";
  }
  return params;
}

export function createPkcePair() {
  const codeVerifier = base64url(crypto.randomBytes(32));
  const codeChallenge = base64url(crypto.createHash("sha256").update(codeVerifier).digest());
  return { codeVerifier, codeChallenge };
}

export function createOAuthState() {
  return base64url(crypto.randomBytes(24));
}

export async function discoverMcpOAuth({
  connectorUrl, headers = {} as any,
  protocolVersion = "",
  fetchImpl = globalThis.fetch,
}: any = {}) {
  if (!connectorUrl) throw new Error("connectorUrl is required");
  const initialProtocolVersion = resolveInitialMcpProtocolVersion({ headers, protocolVersion });
  const challenge = await fetchAuthChallenge(connectorUrl, fetchImpl, initialProtocolVersion);
  const challengeParams = parseWwwAuthenticate(challenge.wwwAuthenticate);
  const resourceMetadata = await fetchProtectedResourceMetadata({
    connectorUrl,
    resourceMetadataUrl: challengeParams.resource_metadata,
    fetchImpl,
  });
  const authServer = firstString(resourceMetadata.authorization_servers);
  if (!authServer) throw new Error("MCP OAuth protected resource metadata did not include authorization_servers");
  const authMetadata = await fetchAuthorizationServerMetadata(authServer, fetchImpl);
  const authorizationEndpoint = stringOrEmpty(authMetadata.authorization_endpoint);
  const tokenEndpoint = stringOrEmpty(authMetadata.token_endpoint);
  if (!authorizationEndpoint || !tokenEndpoint) {
    throw new Error("MCP OAuth authorization server metadata is missing authorization_endpoint or token_endpoint");
  }
  return {
    connectorUrl,
    resourceMetadataUrl: resourceMetadata.url,
    authorizationServer: authServer,
    authorizationEndpoint,
    tokenEndpoint,
    // RFC 7591: the AS advertises its dynamic client registration endpoint here.
    // Empty when the server does not support DCR — callers must fall back to a
    // manually configured client id and error out rather than guess.
    registrationEndpoint: stringOrEmpty(authMetadata.registration_endpoint),
    scope: stringOrEmpty(challengeParams.scope) || scopeFromResource(resourceMetadata),
    // Raw capability lists kept so the authorization flow can decide whether to
    // request offline_access and persist what the server actually supports.
    scopesSupported: stringArray(authMetadata.scopes_supported),
    grantTypesSupported: stringArray(authMetadata.grant_types_supported),
    resourceMetadata,
    authorizationMetadata: authMetadata,
  };
}

// RFC 7591 §2/§3.1: register a public (PKCE) OAuth client with the authorization
// server. We always request both authorization_code and refresh_token grants so
// the resulting client can mint refresh tokens; token_endpoint_auth_method "none"
// matches a native app that authenticates the token endpoint via PKCE, not a
// client secret. A returned client_secret (some servers issue one anyway) is
// passed back for the caller to persist.
export async function registerMcpOAuthClient({
  registrationEndpoint,
  redirectUri,
  scope = "",
  clientName = "Luc",
  fetchImpl = globalThis.fetch,
}: any = {}) {
  if (!registrationEndpoint) throw new Error("registrationEndpoint is required");
  if (!redirectUri) throw new Error("redirectUri is required");

  const metadata = {
    client_name: clientName,
    redirect_uris: [redirectUri],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
  if (scope) (metadata as any).scope = scope;

  const response = await fetchImpl(registrationEndpoint, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(metadata),
  });
  const text = await response.text();
  const data = parseJsonOrEmpty(text);
  if (!response.ok) {
    const oauthError = stringOrEmpty(data?.error);
    throw new McpHttpError(
      registrationFailureMessage(response.status, text, data),
      { status: response.status, body: text, headers: response.headers, oauthError },
    );
  }
  const clientId = stringOrEmpty(data.client_id);
  if (!clientId) throw new Error("OAuth dynamic client registration response did not include client_id");
  return {
    clientId,
    clientSecret: stringOrEmpty(data.client_secret),
    registrationAccessToken: stringOrEmpty(data.registration_access_token),
    registrationClientUri: stringOrEmpty(data.registration_client_uri),
  };
}

export async function createMcpOAuthAuthorization({
  connector,
  redirectUri,
  state = createOAuthState(),
  codeVerifier,
  codeChallenge,
  fetchImpl = globalThis.fetch,
}: any = {}) {
  if (!connector?.id) throw new Error("connector.id is required");
  if (!connector?.url) throw new Error("connector.url is required");
  if (!redirectUri) throw new Error("redirectUri is required");
  const pkce = codeVerifier && codeChallenge ? { codeVerifier, codeChallenge } : createPkcePair();
  const discovery = await discoverMcpOAuth({
    connectorUrl: connector.url,
    headers: connector.headers,
    fetchImpl,
  });

  // Request offline_access only when the AS advertises it, so the token endpoint
  // will mint a refresh token (RFC 6749 §6 + OIDC offline_access). Deduplicated
  // because the base scope may already include it from a different source.
  const scope = withOfflineAccess(discovery.scope, discovery.scopesSupported);

  // Client id resolution. Priority: a manually configured client id wins; only
  // when none is set do we fall back to Dynamic Client Registration (RFC 7591).
  // No client id and no registration endpoint is a hard error — we never invent
  // or guess a client id and never silently continue.
  const manualClientId = stringOrEmpty(connector.oauthClientId);
  let clientId = manualClientId;
  let clientSecret = stringOrEmpty(connector.oauthClientSecret);
  let clientIdSource = manualClientId ? "manual" : "";
  let registration = null;
  if (!clientId) {
    if (!discovery.registrationEndpoint) {
      throw new Error(
        "OAuth client ID is required: the authorization server does not support dynamic client registration. "
        + "Set the connector's OAuth Client ID manually.",
      );
    }
    registration = await registerMcpOAuthClient({
      registrationEndpoint: discovery.registrationEndpoint,
      redirectUri,
      scope,
      fetchImpl,
    });
    clientId = registration.clientId;
    clientSecret = registration.clientSecret;
    clientIdSource = "dcr";
  }

  const url = new URL(discovery.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("resource", connector.url);
  if (scope) url.searchParams.set("scope", scope);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", pkce.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return {
    url: url.href,
    session: {
      state,
      connectorId: connector.id,
      connectorUrl: connector.url,
      clientId,
      clientSecret,
      clientIdSource,
      // Carried so the runtime can persist DCR products (RFC 7592 reuse later).
      registrationAccessToken: registration?.registrationAccessToken || "",
      registrationClientUri: registration?.registrationClientUri || "",
      redirectUri,
      codeVerifier: pkce.codeVerifier,
      tokenEndpoint: discovery.tokenEndpoint,
      scope,
      resource: connector.url,
      createdAt: Date.now(),
    },
    discovery,
  };
}

export async function exchangeMcpOAuthCode({
  tokenEndpoint,
  code,
  redirectUri,
  clientId,
  clientSecret = "",
  codeVerifier,
  resource,
  fetchImpl = globalThis.fetch,
}: any = {}) {
  if (!tokenEndpoint) throw new Error("tokenEndpoint is required");
  if (!code) throw new Error("code is required");
  if (!redirectUri) throw new Error("redirectUri is required");
  if (!clientId) throw new Error("clientId is required");
  if (!codeVerifier) throw new Error("codeVerifier is required");

  const body = new URLSearchParams();
  body.set("grant_type", "authorization_code");
  body.set("code", code);
  body.set("redirect_uri", redirectUri);
  body.set("client_id", clientId);
  body.set("code_verifier", codeVerifier);
  if (clientSecret) body.set("client_secret", clientSecret);
  if (resource) body.set("resource", resource);

  return postTokenRequest({ tokenEndpoint, body, fetchImpl, failurePrefix: "OAuth token exchange" });
}

// RFC 6749 §6: exchange a refresh token for a fresh access token. Returns the
// same shape as exchangeMcpOAuthCode so callers persist tokens uniformly. The
// authorization server MAY omit a new refresh_token (it is allowed not to
// rotate); in that case we preserve the caller's existing refresh token rather
// than blanking it, otherwise the next refresh would have nothing to present.
export async function refreshMcpOAuthToken({
  tokenEndpoint,
  refreshToken,
  clientId,
  clientSecret = "",
  scope = "",
  resource,
  fetchImpl = globalThis.fetch,
}: any = {}) {
  if (!tokenEndpoint) throw new Error("tokenEndpoint is required");
  if (!refreshToken) throw new Error("refreshToken is required");
  if (!clientId) throw new Error("clientId is required");

  const body = new URLSearchParams();
  body.set("grant_type", "refresh_token");
  body.set("refresh_token", refreshToken);
  body.set("client_id", clientId);
  if (clientSecret) body.set("client_secret", clientSecret);
  if (scope) body.set("scope", scope);
  if (resource) body.set("resource", resource);

  const token = await postTokenRequest({ tokenEndpoint, body, fetchImpl, failurePrefix: "OAuth token refresh" });
  // Keep the old refresh token when the server did not issue a new one.
  if (!token.refreshToken) token.refreshToken = stringOrEmpty(refreshToken);
  return token;
}

async function postTokenRequest({ tokenEndpoint, body, fetchImpl, failurePrefix }) {
  const response = await fetchImpl(tokenEndpoint, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  const text = await response.text();
  // The token endpoint usually returns JSON, but a 5xx from a fronting proxy may
  // return HTML/plain text. Parse defensively so a non-JSON error body surfaces
  // the HTTP status (transient → backoff) instead of crashing with a SyntaxError.
  const data = parseJsonOrEmpty(text);
  if (!response.ok) {
    // Throw a structured error carrying the HTTP status AND the OAuth error code
    // (RFC 6749 §5.2). Downstream classification (live-401 self-heal,
    // reconnect-attempt, pre-refresh) routes invalid_grant / 401 / 403 to
    // needs-auth and leaves transient 5xx/network failures on backoff reconnect.
    const oauthError = stringOrEmpty(data?.error);
    throw new McpHttpError(
      data?.error_description || data?.error || `${failurePrefix} failed with status ${response.status}`,
      { status: response.status, body: text, headers: response.headers, oauthError },
    );
  }
  const accessToken = stringOrEmpty(data.access_token);
  if (!accessToken) throw new Error(`${failurePrefix} response did not include access_token`);
  return {
    accessToken,
    refreshToken: stringOrEmpty(data.refresh_token),
    expiresIn: Number.isFinite(data.expires_in) ? data.expires_in : Number(data.expires_in || 0),
    scope: stringOrEmpty(data.scope),
    tokenType: stringOrEmpty(data.token_type) || "Bearer",
    tokenEndpoint,
    obtainedAt: Date.now(),
  };
}

async function fetchAuthChallenge(connectorUrl, fetchImpl, protocolVersion = MCP_PROTOCOL_VERSION) {
  const response = await fetchImpl(connectorUrl, {
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      [MCP_PROTOCOL_VERSION_HEADER]: protocolVersion,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion,
        capabilities: {},
        clientInfo: { name: "luc", title: "Luc", version: "0.1.0" },
      },
    }),
  });
  return {
    status: response.status,
    wwwAuthenticate: response.headers.get("WWW-Authenticate") || "",
  };
}

async function fetchProtectedResourceMetadata({ connectorUrl, resourceMetadataUrl, fetchImpl }) {
  const urls = resourceMetadataUrl
    ? [resourceMetadataUrl]
    : protectedResourceMetadataUrls(connectorUrl);
  for (const url of urls) {
    const response = await fetchImpl(url);
    if (!response.ok) continue;
    const metadata = await response.json();
    return { ...metadata, url };
  }
  throw new Error("Unable to discover MCP OAuth protected resource metadata");
}

async function fetchAuthorizationServerMetadata(issuer, fetchImpl) {
  for (const url of authorizationServerMetadataUrls(issuer)) {
    const response = await fetchImpl(url);
    if (!response.ok) continue;
    return response.json();
  }
  throw new Error("Unable to discover MCP OAuth authorization server metadata");
}

export function protectedResourceMetadataUrls(connectorUrl) {
  const url = new URL(connectorUrl);
  const path = url.pathname.replace(/^\/+/, "").replace(/\/+$/, "");
  const urls = [];
  if (path) urls.push(`${url.origin}/.well-known/oauth-protected-resource/${path}`);
  urls.push(`${url.origin}/.well-known/oauth-protected-resource`);
  return urls;
}

export function authorizationServerMetadataUrls(issuer) {
  const url = new URL(issuer);
  const path = url.pathname.replace(/^\/+/, "").replace(/\/+$/, "");
  if (!path) {
    return [
      `${url.origin}/.well-known/oauth-authorization-server`,
      `${url.origin}/.well-known/openid-configuration`,
    ];
  }
  return [
    `${url.origin}/.well-known/oauth-authorization-server/${path}`,
    `${url.origin}/.well-known/openid-configuration/${path}`,
    `${url.origin}/${path}/.well-known/openid-configuration`,
  ];
}

function scopeFromResource(resourceMetadata) {
  if (Array.isArray(resourceMetadata.scopes_supported) && resourceMetadata.scopes_supported.length > 0) {
    return resourceMetadata.scopes_supported.filter((scope) => typeof scope === "string" && scope).join(" ");
  }
  return "";
}

function stringArray(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string" && item) : [];
}

// Add offline_access to the requested scope iff the AS advertises support for it,
// without duplicating it if the base scope already asked. A space-delimited scope
// string is returned (RFC 6749 §3.3).
function withOfflineAccess(scope, scopesSupported) {
  if (!stringArray(scopesSupported).includes("offline_access")) return scope || "";
  const scopes = stringOrEmpty(scope).split(/\s+/).filter(Boolean);
  if (!scopes.includes("offline_access")) scopes.push("offline_access");
  return scopes.join(" ");
}

function firstString(values) {
  return Array.isArray(values) ? values.find((value) => typeof value === "string" && value) : "";
}

function stringOrEmpty(value) {
  return typeof value === "string" ? value.trim() : "";
}

function registrationFailureMessage(status, text, data) {
  const structured = stringOrEmpty(data?.error_description) || stringOrEmpty(data?.error);
  if (structured) return structured;
  const body = stringOrEmpty(text).replace(/\s+/g, " ").slice(0, 240);
  return `OAuth dynamic client registration failed with status ${status}${body ? `: ${body}` : ""}`;
}

// Parse a token-endpoint body, tolerating a non-JSON payload (e.g. an HTML 5xx
// from a gateway). Returns {} on empty or unparseable text so the caller can
// still surface the HTTP status rather than throwing a SyntaxError.
function parseJsonOrEmpty(text) {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function base64url(buffer) {
  return Buffer.from(buffer)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}
