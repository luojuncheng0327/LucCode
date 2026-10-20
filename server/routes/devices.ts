import { Hono } from "hono";
import {
  approvePairingSession,
  createPairingSession,
  loadDeviceAccessRegistries,
  revokeDevice,
  revokeDeviceCredential,
} from "../../core/device-registry.ts";
import { isLocalOwnerPrincipal } from "../http/route-security.ts";
import { readAuthPrincipal } from "../http/capability-guard.ts";
import { recordSecurityAuditEvent } from "../http/security-audit.ts";
import { safeJson } from "../hono-helpers.ts";

const DEFAULT_DEVICE_SCOPES = Object.freeze(["chat", "resources.read", "files.read", "files.write"]);

export function createDevicesRoute(engine) {
  const route = new Hono();

  route.get("/devices", (c) => {
    const denied = requireLocalOwner(c);
    if (denied) return denied;
    try {
      const registries = loadDeviceAccessRegistries(engine.luccodeHome);
      return c.json({
        devices: registries.devices.devices.map(sanitizeDevice),
        credentials: registries.credentials.credentials.map(sanitizeCredential),
        pairingSessions: registries.pairingSessions.pairingSessions.map(sanitizePairingSession),
      });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  route.post("/devices/pairing-sessions", async (c) => {
    const denied = requireLocalOwner(c);
    if (denied) return denied;
    try {
      const body = await safeJson(c);
      const runtimeContext = resolveRuntimeContext(c, engine);
      const created = createPairingSession(engine.luccodeHome, {
        serverNodeId: runtimeContext.serverNodeId,
        userId: runtimeContext.userId,
        requestedDevice: body?.requestedDevice,
        ttlMs: body?.ttlMs,
      });
      recordSecurityAuditEvent(c, engine, {
        action: "devices.pairing.create",
        target: created.pairingSession.pairingSessionId,
        metadata: {
          deviceKind: created.pairingSession.requestedDevice.deviceKind,
        },
      });
      return c.json({
        pairingSessionId: created.pairingSession.pairingSessionId,
        userCode: created.userCode,
        expiresAt: created.pairingSession.expiresAt,
        requestedDevice: created.pairingSession.requestedDevice,
      });
    } catch (err) {
      return c.json({ error: err.message }, 400);
    }
  });

  route.post("/devices/pairing-sessions/:pairingSessionId/approve", async (c) => {
    const denied = requireLocalOwner(c);
    if (denied) return denied;
    try {
      const body = await safeJson(c);
      const runtimeContext = resolveRuntimeContext(c, engine);
      const issued = approvePairingSession(engine.luccodeHome, {
        pairingSessionId: c.req.param("pairingSessionId"),
        userCode: body?.userCode,
        studioIds: normalizeStudioIds(body?.studioIds, runtimeContext.studioId),
        trustState: body?.trustState || "lan",
        scopes: normalizeScopes(body?.scopes),
        expiresAt: body?.expiresAt ?? null,
      });
      recordSecurityAuditEvent(c, engine, {
        action: "devices.pairing.approve",
        target: issued.device.deviceId,
        metadata: {
          credentialId: issued.credential.credentialId,
          pairingSessionId: issued.pairingSession.pairingSessionId,
          scopes: issued.credential.scopes,
        },
      });
      return c.json({
        secret: issued.secret,
        device: sanitizeDevice(issued.device),
        credential: sanitizeCredential(issued.credential),
        pairingSession: sanitizePairingSession(issued.pairingSession),
      });
    } catch (err) {
      return c.json({ error: err.message }, 400);
    }
  });

  route.post("/devices/:deviceId/revoke", async (c) => {
    const denied = requireLocalOwner(c);
    if (denied) return denied;
    try {
      const device = revokeDevice(engine.luccodeHome, c.req.param("deviceId"));
      recordSecurityAuditEvent(c, engine, {
        action: "devices.revoke",
        target: device.deviceId,
      });
      return c.json({ ok: true, device: sanitizeDevice(device) });
    } catch (err) {
      return c.json({ error: err.message }, 400);
    }
  });

  route.post("/devices/credentials/:credentialId/revoke", async (c) => {
    const denied = requireLocalOwner(c);
    if (denied) return denied;
    try {
      const credential = revokeDeviceCredential(engine.luccodeHome, c.req.param("credentialId"));
      recordSecurityAuditEvent(c, engine, {
        action: "devices.credential.revoke",
        target: credential.credentialId,
        metadata: { deviceId: credential.deviceId },
      });
      return c.json({ ok: true, credential: sanitizeCredential(credential) });
    } catch (err) {
      return c.json({ error: err.message }, 400);
    }
  });

  return route;
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

function normalizeStudioIds(value, fallbackStudioId) {
  if (Array.isArray(value) && value.length > 0) return value;
  return [fallbackStudioId];
}

function normalizeScopes(value) {
  if (Array.isArray(value) && value.length > 0) return value;
  return [...DEFAULT_DEVICE_SCOPES];
}

function sanitizeDevice(device) {
  const {
    publicKey,
    ...safe
  } = device || {};
  return publicKey ? { ...safe, publicKey } : safe;
}

function sanitizeCredential(credential) {
  const {
    secretHash,
    secretSalt,
    ...safe
  } = credential || {};
  return safe;
}

function sanitizePairingSession(session) {
  const {
    userCodeHash,
    userCodeSalt,
    ...safe
  } = session || {};
  return safe;
}
