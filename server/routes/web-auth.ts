import { Hono } from "hono";
import { safeJson } from "../hono-helpers.ts";
import { verifyLocalAccountPassword } from "../../core/local-user-account.ts";
import {
  WEB_SESSION_COOKIE_NAME,
  createWebSession,
  revokeWebSession,
} from "../../core/web-session-store.ts";
import { normalizeAccessProfile, scopesForAccessProfile } from "../../shared/access-scope-profiles.ts";

const DEFAULT_SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export function createWebAuthRoute({
  lucHome,
  authService,
  getConnectionKind,
  getRuntimeContext,
  secureCookies = false,
  now = () => new Date().toISOString(),
}: {
  lucHome?: any;
  authService?: any;
  getConnectionKind?: any;
  getRuntimeContext?: any;
  secureCookies?: boolean;
  now?: () => string;
} = {}) {
  if (!lucHome) throw new Error("lucHome required");
  if (!authService) throw new Error("authService required");
  const route = new Hono();

  route.post("/web-auth/login", async (c) => {
    const body = await safeJson(c);
    const credential = typeof body.credential === "string"
      ? body.credential.trim()
      : "";

    const connectionKind = resolveConnectionKind(c, getConnectionKind);
    const principal = credential
      ? authService.authenticateToken(credential, {
        connectionKind,
        now: now(),
      })
      : authenticatePasswordLogin(c, {
        lucHome,
        body,
        connectionKind,
        getRuntimeContext,
      });
    if (principal?.error) return c.json({ error: principal.error }, principal.status || 400);
    if (!principal) return c.json({ error: "forbidden" }, 403);

    const issued = createWebSession(lucHome, {
      principal,
      userAgent: c.req.header("user-agent"),
      now: now(),
      ttlMs: DEFAULT_SESSION_TTL_MS,
    });
    c.header("Set-Cookie", createSessionCookie(issued.secret, {
      maxAgeSeconds: Math.floor(DEFAULT_SESSION_TTL_MS / 1000),
      secure: secureCookies === true,
    }));
    return c.json({
      ok: true,
      expiresAt: issued.expiresAt,
      principal: sanitizePrincipal(principal),
    });
  });

  route.get("/web-auth/session", async (c) => {
    const connectionKind = resolveConnectionKind(c, getConnectionKind);
    const principal = authService.authenticateRequest({
      cookieHeader: c.req.header("cookie"),
      connectionKind,
      now: now(),
    });
    if (!principal) {
      return c.json({ authenticated: false, principal: null });
    }
    return c.json({
      authenticated: true,
      principal: sanitizePrincipal(principal),
    });
  });

  route.post("/web-auth/logout", async (c) => {
    revokeWebSession(lucHome, c.req.header("cookie"), { now: now() });
    c.header("Set-Cookie", clearSessionCookie({ secure: secureCookies === true }));
    return c.json({ ok: true });
  });

  return route;
}

function authenticatePasswordLogin(c, {
  lucHome,
  body,
  connectionKind,
  getRuntimeContext,
}) {
  const username = typeof body?.username === "string" ? body.username : "";
  const password = typeof body?.password === "string" ? body.password : "";
  if (!username && !password) return { error: "credential_required", status: 400 };
  if (!username || !password) return null;
  if (connectionKind !== "local" && !isSecureRequest(c)) {
    return { error: "password_login_requires_secure_context", status: 400 };
  }
  const verified = verifyLocalAccountPassword(lucHome, { username, password });
  if (!verified.ok) return null;
  const runtimeContext = typeof getRuntimeContext === "function" ? getRuntimeContext() : {};
  return {
    kind: "account_user",
    credentialKind: "user_session",
    authMethod: "password",
    connectionKind,
    trustState: connectionKind === "custom_remote" ? "tunnel" : connectionKind,
    serverId: runtimeContext?.serverId ?? null,
    serverNodeId: runtimeContext?.serverNodeId ?? runtimeContext?.serverId ?? null,
    userId: verified.userId,
    studioId: runtimeContext?.studioId ?? null,
    platformAccountId: runtimeContext?.platformAccountId ?? null,
    officialServiceKind: runtimeContext?.officialServiceKind ?? null,
    scopes: scopesForAccessProfile(normalizeAccessProfile(body?.clientKind, "mobile")),
  };
}

function isSecureRequest(c) {
  try {
    return new URL(c.req.url).protocol === "https:";
  } catch {
    return false;
  }
}

function resolveConnectionKind(c, getConnectionKind) {
  if (typeof getConnectionKind === "function") {
    const value = getConnectionKind(c);
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  try {
    return c.get("transportConnectionKind") || "local";
  } catch {
    return "local";
  }
}

function createSessionCookie(secret, {
  maxAgeSeconds,
  secure,
}) {
  const parts = [
    `${WEB_SESSION_COOKIE_NAME}=${encodeURIComponent(secret)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

function clearSessionCookie({ secure }) {
  const parts = [
    `${WEB_SESSION_COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    "Max-Age=0",
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

function sanitizePrincipal(principal) {
  return {
    kind: principal.kind || null,
    credentialKind: principal.credentialKind || null,
    connectionKind: principal.connectionKind || null,
    trustState: principal.trustState || null,
    serverId: principal.serverId || null,
    serverNodeId: principal.serverNodeId || null,
    userId: principal.userId || null,
    studioId: principal.studioId || null,
    deviceId: principal.deviceId || null,
    credentialId: principal.credentialId || null,
    platformAccountId: principal.platformAccountId || null,
    officialServiceKind: principal.officialServiceKind || null,
    authMethod: principal.authMethod || null,
    scopes: Array.isArray(principal.scopes) ? [...principal.scopes] : [],
  };
}
