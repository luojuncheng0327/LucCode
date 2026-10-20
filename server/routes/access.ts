import os from "os";
import QRCode from "qrcode";
import { Hono } from "hono";
import { createDeviceCredential, loadDeviceAccessRegistries } from "../../core/device-registry.ts";
import {
  loadServerNetworkConfig,
  saveServerNetworkConfig,
} from "../../core/server-network-config.ts";
import {
  clearLocalAccountPassword,
  getLocalAccountSummary,
  setLocalAccountPassword,
  updateLocalAccountProfile,
} from "../../core/local-user-account.ts";
import { readAuthPrincipal } from "../http/capability-guard.ts";
import { isLocalOwnerPrincipal } from "../http/route-security.ts";
import { recordSecurityAuditEvent } from "../http/security-audit.ts";
import { safeJson } from "../hono-helpers.ts";
import {
  DESKTOP_REMOTE_ACCESS_SCOPES,
  MOBILE_REMOTE_ACCESS_SCOPES,
} from "../../shared/access-scope-profiles.ts";
const ACCESS_PROFILES = Object.freeze({
  mobile: Object.freeze({
    deviceKind: "mobile",
    fallbackDisplayName: "Mobile PWA",
    auditAction: "access.mobile_credential.issue",
    urlField: "lanMobileUrl",
    localUrlField: "localMobileUrl",
    defaultScopes: MOBILE_REMOTE_ACCESS_SCOPES,
    allowedScopes: new Set(MOBILE_REMOTE_ACCESS_SCOPES),
    requiredScopes: Object.freeze(["resources.read"]),
  }),
  desktop: Object.freeze({
    deviceKind: "desktop",
    fallbackDisplayName: "Desktop Frontend",
    auditAction: "access.desktop_credential.issue",
    urlField: "lanDesktopUrl",
    localUrlField: "localDesktopUrl",
    defaultScopes: DESKTOP_REMOTE_ACCESS_SCOPES,
    allowedScopes: new Set(DESKTOP_REMOTE_ACCESS_SCOPES),
    requiredScopes: DESKTOP_REMOTE_ACCESS_SCOPES,
  }),
});

export function createAccessRoute({
  engine,
  runtimeState = {} as Record<string, any>,
  listLanAddresses = getLanAddresses,
  now = () => new Date().toISOString(),
}: {
  engine?: any;
  runtimeState?: Record<string, any>;
  listLanAddresses?: () => string[];
  now?: () => string;
} = {}) {
  if (!engine?.luccodeHome) throw new Error("engine.luccodeHome required");
  const route = new Hono();

  route.get("/access/summary", (c) => {
    const denied = requireLocalOwner(c);
    if (denied) return denied;
    return c.json(createAccessSummary(engine, runtimeState, listLanAddresses));
  });

  route.get("/access/mobile-qr.svg", async (c) => {
    const denied = requireLocalOwner(c);
    if (denied) return denied;
    const summary = createAccessSummary(engine, runtimeState, listLanAddresses);
    const port = normalizeQrPort(c.req.query("port"), summary.network.actualPort);
    const url = buildLanMobileUrl(summary.network.lanAddresses, port);
    if (!url) {
      return c.json({ error: "lan_address_unavailable" }, 400);
    }
    const svg = await QRCode.toString(url, {
      type: "svg",
      margin: 1,
      errorCorrectionLevel: "M",
    });
    c.header("Content-Type", "image/svg+xml; charset=utf-8");
    c.header("Cache-Control", "no-store");
    return c.body(svg);
  });

  route.put("/access/network", async (c) => {
    const denied = requireLocalOwner(c);
    if (denied) return denied;
    try {
      const body = await safeJson(c);
      const existing = loadServerNetworkConfig(engine.luccodeHome);
      const mode = normalizeNetworkMode(body?.mode);
      const listenPort = normalizePort(body?.listenPort ?? body?.configuredPort ?? existing.listenPort);
      const listenHost = mode === "lan" ? "0.0.0.0" : "127.0.0.1";
      const network = saveServerNetworkConfig(engine.luccodeHome, {
        ...existing,
        mode,
        listenHost,
        listenPort,
      }, { now: now() });
      runtimeState.configuredMode = network.mode;
      runtimeState.configuredListenHost = network.listenHost;
      runtimeState.configuredPort = network.listenPort;
      recordSecurityAuditEvent(c, engine, {
        action: "access.network.update",
        target: "server-network",
        metadata: { mode: network.mode, listenPort: network.listenPort },
      } as any);
      return c.json({
        ok: true,
        network: createNetworkSummary(network, runtimeState, listLanAddresses),
      });
    } catch (err) {
      return c.json({ error: err.message }, 400);
    }
  });

  route.post("/access/mobile-credentials", async (c) => {
    return issueAccessCredential(c, ACCESS_PROFILES.mobile);
  });

  route.post("/access/desktop-credentials", async (c) => {
    return issueAccessCredential(c, ACCESS_PROFILES.desktop);
  });

  async function issueAccessCredential(c, profile) {
    const denied = requireLocalOwner(c);
    if (denied) return denied;
    try {
      const body = await safeJson(c);
      const runtimeContext = resolveRuntimeContext(c, engine);
      const scopes = normalizeScopes(body?.scopes, profile);
      const issued = createDeviceCredential(engine.luccodeHome, {
        serverNodeId: runtimeContext.serverNodeId,
        userId: runtimeContext.userId,
        studioIds: [runtimeContext.studioId],
        displayName: normalizeDisplayName(body?.displayName, profile.fallbackDisplayName),
        deviceKind: profile.deviceKind,
        trustState: "lan",
        scopes,
        expiresAt: body?.expiresAt ?? null,
        now: now(),
      });
      const summary = createAccessSummary(engine, runtimeState, listLanAddresses);
      recordSecurityAuditEvent(c, engine, {
        action: profile.auditAction,
        target: issued.device.deviceId,
        secretFields: ["secret"],
        metadata: {
          credentialId: issued.credential.credentialId,
          scopes: issued.credential.scopes,
        },
      } as any);
      return c.json({
        ok: true,
        secret: issued.secret,
        accessUrl: summary.network[profile.urlField] || summary.network[profile.localUrlField],
        device: sanitizeDevice(issued.device),
        credential: sanitizeCredential(issued.credential),
      });
    } catch (err) {
      return c.json({ error: err.message }, 400);
    }
  }

  route.put("/access/account/profile", async (c) => {
    const denied = requireLocalOwner(c);
    if (denied) return denied;
    try {
      const body = await safeJson(c);
      const account = updateLocalAccountProfile(engine.luccodeHome, {
        username: body?.username,
        displayName: body?.displayName,
        now: now(),
      } as any);
      recordSecurityAuditEvent(c, engine, {
        action: "access.account.profile.update",
        target: account.userId,
      } as any);
      return c.json({ ok: true, account });
    } catch (err) {
      return c.json({ error: err.message }, 400);
    }
  });

  route.put("/access/account/password", async (c) => {
    const denied = requireLocalOwner(c);
    if (denied) return denied;
    try {
      const body = await safeJson(c);
      const account = setLocalAccountPassword(engine.luccodeHome, {
        password: body?.password,
        now: now(),
      } as any);
      recordSecurityAuditEvent(c, engine, {
        action: "access.account.password.update",
        target: account.userId,
        secretFields: ["password"],
      } as any);
      return c.json({ ok: true, account });
    } catch (err) {
      return c.json({ error: err.message }, 400);
    }
  });

  route.delete("/access/account/password", async (c) => {
    const denied = requireLocalOwner(c);
    if (denied) return denied;
    try {
      const account = clearLocalAccountPassword(engine.luccodeHome, { now: now() });
      recordSecurityAuditEvent(c, engine, {
        action: "access.account.password.clear",
        target: account.userId,
      } as any);
      return c.json({ ok: true, account });
    } catch (err) {
      return c.json({ error: err.message }, 400);
    }
  });

  return route;
}

export function createAccessSummary(engine, runtimeState, listLanAddresses = getLanAddresses) {
  const network = loadServerNetworkConfig(engine.luccodeHome);
  const registries = loadDeviceAccessRegistries(engine.luccodeHome);
  return {
    network: createNetworkSummary(network, runtimeState, listLanAddresses),
    account: getLocalAccountSummary(engine.luccodeHome),
    devices: registries.devices.devices.map(sanitizeDevice),
    credentials: registries.credentials.credentials.map(sanitizeCredential),
  };
}

function createNetworkSummary(network, runtimeState, listLanAddresses) {
  const actualPort = Number.isInteger(runtimeState?.actualPort)
    ? runtimeState.actualPort
    : network.listenPort;
  const runtimeMode = runtimeState?.mode || network.mode;
  const runtimeHost = runtimeState?.listenHost || network.listenHost;
  const lanAddresses = listLanAddresses();
  const localServerUrl = buildServerUrl("127.0.0.1", actualPort);
  const candidateLanServerUrl = buildLanServerUrl(lanAddresses, network.listenPort);
  const lanRuntimeActive = runtimeMode === "lan" && runtimeHost === "0.0.0.0";
  const lanServerUrl = lanRuntimeActive && lanAddresses.length > 0
    ? buildServerUrl(lanAddresses[0], actualPort)
    : null;
  const localMobileUrl = buildMobileUrl("127.0.0.1", actualPort);
  const candidateLanMobileUrl = buildLanMobileUrl(lanAddresses, network.listenPort);
  const lanMobileUrl = lanRuntimeActive && lanAddresses.length > 0
    ? buildMobileUrl(lanAddresses[0], actualPort)
    : null;
  const localDesktopUrl = buildDesktopUrl("127.0.0.1", actualPort);
  const candidateLanDesktopUrl = buildLanDesktopUrl(lanAddresses, network.listenPort);
  const lanDesktopUrl = lanRuntimeActive && lanAddresses.length > 0
    ? buildDesktopUrl(lanAddresses[0], actualPort)
    : null;
  return {
    mode: network.mode,
    listenHost: network.listenHost,
    configuredPort: network.listenPort,
    actualPort,
    runtimeMode,
    runtimeHost,
    restartRequired: runtimeMode !== network.mode
      || runtimeHost !== network.listenHost
      || actualPort !== network.listenPort,
    lanAddresses,
    localServerUrl,
    candidateLanServerUrl,
    lanServerUrl,
    localMobileUrl,
    candidateLanMobileUrl,
    lanMobileUrl,
    localDesktopUrl,
    candidateLanDesktopUrl,
    lanDesktopUrl,
  };
}

function buildServerUrl(host, port) {
  return `http://${formatUrlHost(host)}:${port}/`;
}

function buildMobileUrl(host, port) {
  return `http://${formatUrlHost(host)}:${port}/mobile/`;
}

function buildDesktopUrl(host, port) {
  return `http://${formatUrlHost(host)}:${port}/desktop/`;
}

function buildLanServerUrl(lanAddresses, port) {
  const host = Array.isArray(lanAddresses) ? lanAddresses[0] : null;
  return host ? buildServerUrl(host, port) : null;
}

function buildLanMobileUrl(lanAddresses, port) {
  const host = Array.isArray(lanAddresses) ? lanAddresses[0] : null;
  return host ? buildMobileUrl(host, port) : null;
}

function buildLanDesktopUrl(lanAddresses, port) {
  const host = Array.isArray(lanAddresses) ? lanAddresses[0] : null;
  return host ? buildDesktopUrl(host, port) : null;
}

function formatUrlHost(host) {
  const value = String(host || "");
  return value.includes(":") && !value.startsWith("[") ? `[${value}]` : value;
}

function requireLocalOwner(c) {
  if (isLocalOwnerPrincipal(readAuthPrincipal(c))) return null;
  return c.json({ error: "local_only_route" }, 403);
}

function resolveRuntimeContext(c, engine) {
  const principal = readAuthPrincipal(c);
  const runtimeContext = typeof engine.getRuntimeContext === "function" ? engine.getRuntimeContext() : {};
  const serverNodeId = principal?.serverNodeId || runtimeContext?.serverNodeId || runtimeContext?.serverId;
  const userId = principal?.userId || runtimeContext?.userId;
  const studioId = principal?.studioId || runtimeContext?.studioId;
  if (!serverNodeId) throw new Error("serverNodeId unavailable");
  if (!userId) throw new Error("userId unavailable");
  if (!studioId) throw new Error("studioId unavailable");
  return { serverNodeId, userId, studioId };
}

function normalizeNetworkMode(value) {
  if (value === "loopback" || value === "lan") return value;
  throw new Error("mode must be loopback or lan");
}

function normalizePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error("listenPort must be between 1024 and 65535");
  }
  return port;
}

function normalizeQrPort(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  return normalizePort(value);
}

function normalizeDisplayName(value, fallback) {
  if (typeof value !== "string" || !value.trim()) return fallback;
  return value.trim().slice(0, 80);
}

function normalizeScopes(value, profile) {
  const defaultScopes = profile?.defaultScopes || MOBILE_REMOTE_ACCESS_SCOPES;
  const allowedScopes = profile?.allowedScopes || new Set(defaultScopes);
  const requiredScopes = profile?.requiredScopes || [];
  const raw = Array.isArray(value) && value.length > 0 ? value : defaultScopes;
  const validScopes = raw
    .filter((scope) => typeof scope === "string" && allowedScopes.has(scope));
  if (validScopes.length === 0) throw new Error("at least one supported scope is required");
  const scopeSet = new Set(validScopes);
  for (const scope of requiredScopes) scopeSet.add(scope);
  return defaultScopes.filter((scope) => scopeSet.has(scope));
}

function sanitizeDevice(device) {
  const { publicKey, ...safe } = device || {};
  return publicKey ? { ...safe, publicKey } : safe;
}

function sanitizeCredential(credential) {
  const { secretHash, secretSalt, ...safe } = credential || {};
  return safe;
}

export function getLanAddresses() {
  const out = [];
  const interfaces = os.networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      out.push(entry.address);
    }
  }
  return out;
}
