import crypto from "crypto";
import fs from "fs";
import path from "path";
import { writeSecretFileSync } from "../shared/secret-fs.ts";
import { normalizePrincipal } from "./security-principal.ts";

export const WEB_SESSIONS_FILE = "web-sessions.json";
export const WEB_SESSION_COOKIE_NAME = "luc_session";

const SCHEMA_VERSION = 1;
const SECRET_PREFIX_LENGTH = 18;
const DEFAULT_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export function ensureWebSessionRegistry(lucHome, { now = new Date().toISOString() } = {}) {
  const filePath = path.join(lucHome, WEB_SESSIONS_FILE);
  const existing = readJsonIfPresent(filePath, WEB_SESSIONS_FILE);
  if (existing) {
    validateWebSessionRegistry(existing, WEB_SESSIONS_FILE);
    return { created: [] };
  }
  writeSecretJson(filePath, createEmptyRegistry(now));
  return { created: [WEB_SESSIONS_FILE] };
}

export function loadWebSessionRegistry(lucHome) {
  ensureWebSessionRegistry(lucHome);
  const registry = readJsonRequired(path.join(lucHome, WEB_SESSIONS_FILE), WEB_SESSIONS_FILE);
  return validateWebSessionRegistry(registry, WEB_SESSIONS_FILE);
}

export function createWebSession(lucHome, input: { principal?: any; now?: string; ttlMs?: number; userAgent?: string } = {}) {
  assertNonEmptyString(lucHome, "lucHome");
  if (!isPlainObject(input.principal)) throw new Error("principal required");

  const now = input.now || new Date().toISOString();
  const ttlMs = Number.isFinite(input.ttlMs) && input.ttlMs > 0 ? input.ttlMs : DEFAULT_TTL_MS;
  const secret = `luc_web_${randomToken(32)}`;
  const secretSalt = randomToken(16);
  const session = {
    schemaVersion: SCHEMA_VERSION,
    sessionId: `web_${crypto.randomUUID()}`,
    secretPrefix: secret.slice(0, SECRET_PREFIX_LENGTH),
    secretHash: hashSecret(secret, secretSalt),
    secretSalt,
    status: "active",
    principal: sanitizePrincipal(input.principal),
    userAgent: isNonEmptyString(input.userAgent) ? input.userAgent.trim().slice(0, 256) : null,
    createdAt: now,
    updatedAt: now,
    lastUsedAt: null,
    expiresAt: new Date(Date.parse(now) + ttlMs).toISOString(),
  };

  const registry = loadWebSessionRegistry(lucHome);
  registry.sessions.push(session);
  registry.updatedAt = now;
  persistWebSessionRegistry(lucHome, registry);
  return {
    session: sanitizeSession(session),
    secret,
    cookieName: WEB_SESSION_COOKIE_NAME,
    expiresAt: session.expiresAt,
  };
}

export function authenticateWebSession(lucHome, cookieHeader, { now = new Date().toISOString() } = {}) {
  const secret = parseCookie(cookieHeader, WEB_SESSION_COOKIE_NAME);
  if (!isNonEmptyString(secret)) return null;
  const registry = loadWebSessionRegistry(lucHome);
  const session = registry.sessions.find((item) => (
    item.status === "active"
    && isNonEmptyString(item.secretPrefix)
    && secret.startsWith(item.secretPrefix)
    && verifySecret(secret, item.secretSalt, item.secretHash)
  ));
  if (!session) return null;
  if (session.expiresAt && Date.parse(session.expiresAt) <= Date.parse(now)) {
    session.status = "expired";
    session.updatedAt = now;
    registry.updatedAt = now;
    persistWebSessionRegistry(lucHome, registry);
    return null;
  }

  session.lastUsedAt = now;
  session.updatedAt = now;
  registry.updatedAt = now;
  persistWebSessionRegistry(lucHome, registry);
  return deepFreeze(clonePlain(session.principal));
}

export function revokeWebSession(lucHome, cookieHeader, { now = new Date().toISOString() } = {}) {
  const secret = parseCookie(cookieHeader, WEB_SESSION_COOKIE_NAME);
  if (!isNonEmptyString(secret)) return false;
  const registry = loadWebSessionRegistry(lucHome);
  const session = registry.sessions.find((item) => (
    item.status === "active"
    && isNonEmptyString(item.secretPrefix)
    && secret.startsWith(item.secretPrefix)
    && verifySecret(secret, item.secretSalt, item.secretHash)
  ));
  if (!session) return false;
  session.status = "revoked";
  session.updatedAt = now;
  session.revokedAt = now;
  registry.updatedAt = now;
  persistWebSessionRegistry(lucHome, registry);
  return true;
}

export function parseCookie(cookieHeader, name) {
  if (!isNonEmptyString(cookieHeader) || !isNonEmptyString(name)) return null;
  const target = name.trim();
  for (const part of cookieHeader.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    if (key !== target) continue;
    try {
      return decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      return part.slice(index + 1).trim();
    }
  }
  return null;
}

function persistWebSessionRegistry(lucHome, registry) {
  validateWebSessionRegistry(registry, WEB_SESSIONS_FILE);
  writeSecretJson(path.join(lucHome, WEB_SESSIONS_FILE), registry);
}

function validateWebSessionRegistry(value, label) {
  if (!isPlainObject(value)) throw new Error(`invalid ${label}: expected object`);
  if (value.schemaVersion !== SCHEMA_VERSION) throw new Error(`invalid ${label}: schemaVersion must be 1`);
  if (!Array.isArray(value.sessions)) throw new Error(`invalid ${label}: sessions must be an array`);
  for (const session of value.sessions) validateWebSessionRecord(session, label);
  return value;
}

function validateWebSessionRecord(session, label) {
  if (!isPlainObject(session)) throw new Error(`invalid ${label}: session must be object`);
  for (const field of ["sessionId", "secretPrefix", "secretHash", "secretSalt", "status", "createdAt", "updatedAt", "expiresAt"]) {
    assertRecordString(session[field], label, field);
  }
  if (!["active", "expired", "revoked"].includes(session.status)) {
    throw new Error(`invalid ${label}: session.status invalid`);
  }
  if (!isPlainObject(session.principal)) throw new Error(`invalid ${label}: session.principal required`);
}

function createEmptyRegistry(now) {
  return {
    schemaVersion: SCHEMA_VERSION,
    sessions: [],
    createdAt: now,
    updatedAt: now,
  };
}

function sanitizePrincipal(principal) {
  return normalizePrincipal(principal);
}

function sanitizeSession(session) {
  const {
    secretHash,
    secretSalt,
    secretPrefix,
    ...safe
  } = session;
  return clonePlain(safe);
}

function hashSecret(secret, salt) {
  return crypto.createHash("sha256").update(`${salt}:${secret}`).digest("hex");
}

function verifySecret(secret, salt, hash) {
  if (!isNonEmptyString(secret) || !isNonEmptyString(salt) || !isNonEmptyString(hash)) return false;
  const candidate = hashSecret(secret, salt);
  const a = Buffer.from(candidate, "hex");
  const b = Buffer.from(hash, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function randomToken(bytes) {
  return crypto.randomBytes(bytes).toString("base64url");
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

function assertRecordString(value, label, field) {
  if (!isNonEmptyString(value)) throw new Error(`invalid ${label}: ${field} required`);
}

function assertNonEmptyString(value, label) {
  if (!isNonEmptyString(value)) throw new Error(`${label} required`);
}

function stringOrNull(value) {
  return isNonEmptyString(value) ? value.trim() : null;
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function clonePlain(value) {
  return JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
