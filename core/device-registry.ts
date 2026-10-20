import crypto from "crypto";
import fs from "fs";
import path from "path";
import { writeSecretFileSync } from "../shared/secret-fs.ts";
import { normalizePrincipal } from "./security-principal.ts";

export const DEVICES_FILE = "devices.json";
export const DEVICE_CREDENTIALS_FILE = "device-credentials.json";
export const PAIRING_SESSIONS_FILE = "pairing-sessions.json";

const SCHEMA_VERSION = 1;
const SECRET_PREFIX_LENGTH = 18;
const DEFAULT_PAIRING_TTL_MS = 10 * 60 * 1000;

export function ensureDeviceAccessRegistries(lucHome, { now = new Date().toISOString() } = {}) {
  const created = [];
  const registries: [string, any, (value: any, label: any) => void][] = [
    [DEVICES_FILE, createEmptyDevicesRegistry(now), validateDevicesRegistry],
    [DEVICE_CREDENTIALS_FILE, createEmptyCredentialsRegistry(now), validateCredentialsRegistry],
    [PAIRING_SESSIONS_FILE, createEmptyPairingSessionsRegistry(now), validatePairingSessionsRegistry],
  ];

  for (const [file, emptyRegistry, validate] of registries) {
    const filePath = path.join(lucHome, file);
    const current = readJsonIfPresent(filePath, file);
    if (current) {
      validate(current, file);
      continue;
    }
    writeSecretJson(filePath, emptyRegistry);
    created.push(file);
  }

  return { created };
}

export function loadDeviceAccessRegistries(lucHome) {
  ensureDeviceAccessRegistries(lucHome);
  const devices = readJsonRequired(path.join(lucHome, DEVICES_FILE), DEVICES_FILE);
  const credentials = readJsonRequired(path.join(lucHome, DEVICE_CREDENTIALS_FILE), DEVICE_CREDENTIALS_FILE);
  const pairingSessions = readJsonRequired(path.join(lucHome, PAIRING_SESSIONS_FILE), PAIRING_SESSIONS_FILE);
  validateDevicesRegistry(devices, DEVICES_FILE);
  validateCredentialsRegistry(credentials, DEVICE_CREDENTIALS_FILE);
  validatePairingSessionsRegistry(pairingSessions, PAIRING_SESSIONS_FILE);
  return { devices, credentials, pairingSessions };
}

export function createDeviceCredential(lucHome, input) {
  const now = input?.now || new Date().toISOString();
  const registries = loadDeviceAccessRegistries(lucHome);
  const issued = issueDeviceCredential(registries, input, { now });
  persistDeviceAccessRegistries(lucHome, registries);
  return cloneIssuedCredential(issued);
}

export function authenticateDeviceCredential(lucHome, secret, { now = new Date().toISOString() } = {}) {
  if (!isNonEmptyString(secret)) return null;
  const registries = loadDeviceAccessRegistries(lucHome);
  const credential = registries.credentials.credentials.find((item) => (
    item.status === "active"
    && isNonEmptyString(item.secretPrefix)
    && secret.startsWith(item.secretPrefix)
    && verifySecret(secret, item.secretSalt, item.secretHash)
  ));
  if (!credential) return null;
  if (credential.expiresAt && Date.parse(credential.expiresAt) <= Date.parse(now)) return null;

  const device = registries.devices.devices.find((item) => item.deviceId === credential.deviceId);
  if (!device || device.status !== "active") return null;

  credential.lastUsedAt = now;
  device.lastSeenAt = now;
  persistDeviceAccessRegistries(lucHome, registries);

  const trustState = device.trustState || "lan";
  return normalizePrincipal({
    kind: "device",
    credentialKind: "device_credential",
    connectionKind: trustState === "tunnel" ? "custom_remote" : "lan",
    trustState,
    serverNodeId: credential.serverNodeId,
    userId: credential.userId,
    studioId: credential.studioIds[0] || null,
    studioIds: [...credential.studioIds],
    deviceId: credential.deviceId,
    credentialId: credential.credentialId,
    scopes: [...credential.scopes],
  });
}

export function revokeDeviceCredential(lucHome, credentialId, { now = new Date().toISOString() } = {}) {
  if (!isNonEmptyString(credentialId)) throw new Error("credentialId required");
  const registries = loadDeviceAccessRegistries(lucHome);
  const credential = registries.credentials.credentials.find((item) => item.credentialId === credentialId);
  if (!credential) throw new Error(`device credential not found: ${credentialId}`);
  credential.status = "revoked";
  credential.revokedAt = now;
  registries.credentials.updatedAt = now;
  persistDeviceAccessRegistries(lucHome, registries);
  return clonePlain(credential);
}

export function revokeDevice(lucHome, deviceId, { now = new Date().toISOString() } = {}) {
  if (!isNonEmptyString(deviceId)) throw new Error("deviceId required");
  const registries = loadDeviceAccessRegistries(lucHome);
  const device = registries.devices.devices.find((item) => item.deviceId === deviceId);
  if (!device) throw new Error(`device not found: ${deviceId}`);
  device.status = "revoked";
  device.revokedAt = now;
  device.updatedAt = now;
  for (const credential of registries.credentials.credentials) {
    if (credential.deviceId === deviceId && credential.status === "active") {
      credential.status = "revoked";
      credential.revokedAt = now;
    }
  }
  registries.devices.updatedAt = now;
  registries.credentials.updatedAt = now;
  persistDeviceAccessRegistries(lucHome, registries);
  return clonePlain(device);
}

export function createPairingSession(lucHome, input) {
  const now = input?.now || new Date().toISOString();
  const ttlMs = Number.isFinite(input?.ttlMs) ? input.ttlMs : DEFAULT_PAIRING_TTL_MS;
  if (ttlMs <= 0) throw new Error("ttlMs must be positive");
  assertNonEmptyString(input?.serverNodeId, "serverNodeId");
  assertNonEmptyString(input?.userId, "userId");
  const requestedDevice = normalizeRequestedDevice(input?.requestedDevice);
  const userCode = createUserCode();
  const userCodeSalt = randomToken(12);
  const pairingSession = {
    schemaVersion: SCHEMA_VERSION,
    pairingSessionId: `pair_${crypto.randomUUID()}`,
    userCodeHash: hashSecret(normalizeUserCode(userCode), userCodeSalt),
    userCodeSalt,
    serverNodeId: input.serverNodeId,
    userId: input.userId,
    requestedDevice,
    status: "pending",
    createdAt: now,
    expiresAt: new Date(Date.parse(now) + ttlMs).toISOString(),
  };

  const registries = loadDeviceAccessRegistries(lucHome);
  registries.pairingSessions.pairingSessions.push(pairingSession);
  registries.pairingSessions.updatedAt = now;
  persistDeviceAccessRegistries(lucHome, registries);
  return {
    pairingSession: clonePlain(pairingSession),
    userCode,
  };
}

export function approvePairingSession(lucHome, input) {
  const now = input?.now || new Date().toISOString();
  assertNonEmptyString(input?.pairingSessionId, "pairingSessionId");
  assertNonEmptyString(input?.userCode, "userCode");
  const registries = loadDeviceAccessRegistries(lucHome);
  const session = registries.pairingSessions.pairingSessions
    .find((item) => item.pairingSessionId === input.pairingSessionId);
  if (!session) throw new Error(`pairing session not found: ${input.pairingSessionId}`);
  if (session.status !== "pending") throw new Error(`pairing session is ${session.status}`);
  if (Date.parse(session.expiresAt) <= Date.parse(now)) {
    session.status = "expired";
    session.expiredAt = now;
    registries.pairingSessions.updatedAt = now;
    persistDeviceAccessRegistries(lucHome, registries);
    throw new Error("pairing session expired");
  }
  if (!verifySecret(normalizeUserCode(input.userCode), session.userCodeSalt, session.userCodeHash)) {
    throw new Error("invalid pairing code");
  }

  const issued = issueDeviceCredential(registries, {
    serverNodeId: session.serverNodeId,
    userId: session.userId,
    studioIds: input.studioIds,
    displayName: session.requestedDevice.displayName,
    deviceKind: session.requestedDevice.deviceKind,
    publicKey: session.requestedDevice.publicKey ?? null,
    trustState: input.trustState,
    scopes: input.scopes,
    expiresAt: input.expiresAt ?? null,
  }, { now });

  session.status = "approved";
  session.approvedAt = now;
  session.deviceId = issued.device.deviceId;
  session.credentialId = issued.credential.credentialId;
  registries.pairingSessions.updatedAt = now;
  persistDeviceAccessRegistries(lucHome, registries);
  return cloneIssuedCredential({
    ...issued,
    pairingSession: session,
  });
}

function issueDeviceCredential(registries, input, { now }) {
  assertNonEmptyString(input?.serverNodeId, "serverNodeId");
  assertNonEmptyString(input?.userId, "userId");
  const studioIds = normalizeStringArray(input?.studioIds, "studioIds");
  const scopes = normalizeStringArray(input?.scopes ?? ["chat"], "scopes");
  const deviceKind = normalizeEnum(input?.deviceKind || "unknown", ["desktop", "mobile", "browser", "cli", "unknown"], "deviceKind");
  const trustState = normalizeEnum(input?.trustState || "lan", ["lan", "tunnel"], "trustState");
  const displayName = isNonEmptyString(input?.displayName) ? input.displayName.trim() : "Paired Device";
  const deviceId = input.deviceId || `device_${crypto.randomUUID()}`;
  const credentialId = `cred_${crypto.randomUUID()}`;
  const secret = `luc_dev_${randomToken(32)}`;
  const secretSalt = randomToken(16);
  const credential = {
    schemaVersion: SCHEMA_VERSION,
    credentialId,
    deviceId,
    serverNodeId: input.serverNodeId,
    userId: input.userId,
    studioIds,
    secretHash: hashSecret(secret, secretSalt),
    secretSalt,
    secretPrefix: secret.slice(0, SECRET_PREFIX_LENGTH),
    status: "active",
    scopes,
    createdAt: now,
    expiresAt: input.expiresAt ?? null,
    lastUsedAt: null,
  };
  const device = {
    schemaVersion: SCHEMA_VERSION,
    deviceId,
    serverNodeId: input.serverNodeId,
    userId: input.userId,
    studioIds,
    displayName,
    deviceKind,
    publicKey: input.publicKey ?? null,
    credentialIds: [credentialId],
    status: "active",
    trustState,
    createdAt: now,
    approvedAt: now,
    updatedAt: now,
  };

  registries.devices.devices.push(device);
  registries.credentials.credentials.push(credential);
  registries.devices.updatedAt = now;
  registries.credentials.updatedAt = now;
  return { device, credential, secret };
}

function persistDeviceAccessRegistries(lucHome, registries) {
  validateDevicesRegistry(registries.devices, DEVICES_FILE);
  validateCredentialsRegistry(registries.credentials, DEVICE_CREDENTIALS_FILE);
  validatePairingSessionsRegistry(registries.pairingSessions, PAIRING_SESSIONS_FILE);
  writeSecretJson(path.join(lucHome, DEVICES_FILE), registries.devices);
  writeSecretJson(path.join(lucHome, DEVICE_CREDENTIALS_FILE), registries.credentials);
  writeSecretJson(path.join(lucHome, PAIRING_SESSIONS_FILE), registries.pairingSessions);
}

function createEmptyDevicesRegistry(now) {
  return { schemaVersion: SCHEMA_VERSION, devices: [], createdAt: now, updatedAt: now };
}

function createEmptyCredentialsRegistry(now) {
  return { schemaVersion: SCHEMA_VERSION, credentials: [], createdAt: now, updatedAt: now };
}

function createEmptyPairingSessionsRegistry(now) {
  return { schemaVersion: SCHEMA_VERSION, pairingSessions: [], createdAt: now, updatedAt: now };
}

function validateDevicesRegistry(value, label) {
  validateRegistryEnvelope(value, label);
  if (!Array.isArray(value.devices)) throw new Error(`invalid ${label}: devices must be an array`);
  const seen = new Set();
  for (const device of value.devices) {
    if (!isPlainObject(device)) throw new Error(`invalid ${label}: device must be object`);
    assertRecordString(device.deviceId, label, "deviceId");
    if (seen.has(device.deviceId)) throw new Error(`invalid ${label}: duplicate deviceId ${device.deviceId}`);
    seen.add(device.deviceId);
    assertRecordString(device.serverNodeId, label, "serverNodeId");
    assertRecordString(device.userId, label, "userId");
    if (!Array.isArray(device.studioIds) || device.studioIds.length === 0) {
      throw new Error(`invalid ${label}: studioIds must be a non-empty array`);
    }
    assertRecordString(device.displayName, label, "displayName");
    if (!["desktop", "mobile", "browser", "cli", "unknown"].includes(device.deviceKind)) {
      throw new Error(`invalid ${label}: deviceKind invalid`);
    }
    if (!["pending", "active", "revoked"].includes(device.status)) {
      throw new Error(`invalid ${label}: status invalid`);
    }
    if (!["lan", "tunnel"].includes(device.trustState)) {
      throw new Error(`invalid ${label}: trustState invalid`);
    }
  }
}

function validateCredentialsRegistry(value, label) {
  validateRegistryEnvelope(value, label);
  if (!Array.isArray(value.credentials)) throw new Error(`invalid ${label}: credentials must be an array`);
  const seen = new Set();
  for (const credential of value.credentials) {
    if (!isPlainObject(credential)) throw new Error(`invalid ${label}: credential must be object`);
    assertRecordString(credential.credentialId, label, "credentialId");
    if (seen.has(credential.credentialId)) {
      throw new Error(`invalid ${label}: duplicate credentialId ${credential.credentialId}`);
    }
    seen.add(credential.credentialId);
    assertRecordString(credential.deviceId, label, "deviceId");
    assertRecordString(credential.serverNodeId, label, "serverNodeId");
    assertRecordString(credential.userId, label, "userId");
    assertRecordString(credential.secretHash, label, "secretHash");
    assertRecordString(credential.secretSalt, label, "secretSalt");
    assertRecordString(credential.secretPrefix, label, "secretPrefix");
    if (!Array.isArray(credential.studioIds) || credential.studioIds.length === 0) {
      throw new Error(`invalid ${label}: studioIds must be a non-empty array`);
    }
    if (!Array.isArray(credential.scopes)) throw new Error(`invalid ${label}: scopes must be an array`);
    if (!["active", "revoked", "rotated"].includes(credential.status)) {
      throw new Error(`invalid ${label}: status invalid`);
    }
  }
}

function validatePairingSessionsRegistry(value, label) {
  validateRegistryEnvelope(value, label);
  if (!Array.isArray(value.pairingSessions)) {
    throw new Error(`invalid ${label}: pairingSessions must be an array`);
  }
  const seen = new Set();
  for (const session of value.pairingSessions) {
    if (!isPlainObject(session)) throw new Error(`invalid ${label}: pairingSession must be object`);
    assertRecordString(session.pairingSessionId, label, "pairingSessionId");
    if (seen.has(session.pairingSessionId)) {
      throw new Error(`invalid ${label}: duplicate pairingSessionId ${session.pairingSessionId}`);
    }
    seen.add(session.pairingSessionId);
    assertRecordString(session.userCodeHash, label, "userCodeHash");
    assertRecordString(session.userCodeSalt, label, "userCodeSalt");
    assertRecordString(session.serverNodeId, label, "serverNodeId");
    assertRecordString(session.userId, label, "userId");
    if (!isPlainObject(session.requestedDevice)) {
      throw new Error(`invalid ${label}: requestedDevice must be object`);
    }
    if (!["pending", "approved", "denied", "expired"].includes(session.status)) {
      throw new Error(`invalid ${label}: status invalid`);
    }
    assertRecordString(session.expiresAt, label, "expiresAt");
  }
}

function validateRegistryEnvelope(value, label) {
  if (!isPlainObject(value)) throw new Error(`invalid ${label}: expected object`);
  if (value.schemaVersion !== SCHEMA_VERSION) throw new Error(`invalid ${label}: schemaVersion must be 1`);
}

function readJsonRequired(filePath, label) {
  const value = readJsonIfPresent(filePath, label);
  if (!value) throw new Error(`${label} not found`);
  return value;
}

function readJsonIfPresent(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (err) {
    if (err.code === "ENOENT") return null;
    if (err instanceof SyntaxError) throw new Error(`invalid ${label}: ${err.message}`);
    throw new Error(`failed to read ${label}: ${err.message}`);
  }
}

function writeSecretJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  writeSecretFileSync(filePath, JSON.stringify(data, null, 2) + "\n");
}

function hashSecret(secret, salt) {
  return crypto.scryptSync(secret, salt, 32).toString("base64url");
}

function verifySecret(secret, salt, expectedHash) {
  if (!isNonEmptyString(salt) || !isNonEmptyString(expectedHash)) return false;
  const actual = Buffer.from(hashSecret(secret, salt));
  const expected = Buffer.from(expectedHash);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function randomToken(byteLength) {
  return crypto.randomBytes(byteLength).toString("base64url");
}

function createUserCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 8; i++) {
    code += alphabet[crypto.randomInt(0, alphabet.length)];
  }
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

function normalizeUserCode(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function normalizeRequestedDevice(value) {
  if (!isPlainObject(value)) throw new Error("requestedDevice required");
  return {
    displayName: isNonEmptyString(value.displayName) ? value.displayName.trim() : "New Device",
    deviceKind: normalizeEnum(value.deviceKind || "unknown", ["desktop", "mobile", "browser", "cli", "unknown"], "deviceKind"),
    publicKey: value.publicKey ?? null,
  };
}

function normalizeStringArray(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must be a non-empty array`);
  }
  const normalized = [];
  const seen = new Set();
  for (const item of value) {
    if (!isNonEmptyString(item)) throw new Error(`${label} entries must be non-empty strings`);
    const key = item.trim();
    if (!seen.has(key)) {
      seen.add(key);
      normalized.push(key);
    }
  }
  return normalized;
}

function normalizeEnum(value, allowed, label) {
  if (!allowed.includes(value)) throw new Error(`${label} must be one of ${allowed.join(", ")}`);
  return value;
}

function assertNonEmptyString(value, label) {
  if (!isNonEmptyString(value)) throw new Error(`${label} required`);
}

function assertRecordString(value, fileLabel, fieldLabel) {
  if (!isNonEmptyString(value)) throw new Error(`invalid ${fileLabel}: ${fieldLabel} required`);
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function cloneIssuedCredential(issued) {
  return {
    ...clonePlain(issued),
    secret: issued.secret,
  };
}

function clonePlain(value) {
  return JSON.parse(JSON.stringify(value));
}
