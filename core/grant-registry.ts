import crypto from "crypto";
import fs from "fs";
import path from "path";
import { atomicWriteSync } from "../shared/safe-fs.ts";
import { SECURITY_DIR } from "./security-dir.ts";

export const GRANTS_FILE = "grants.json";

const SCHEMA_VERSION = 1;
const SUBJECT_KINDS = new Set(["user", "device", "agent", "plugin", "bridge", "official_service"]);
const STATUSES = new Set(["active", "revoked", "expired"]);

export function ensureGrantRegistry(lucHome, { now = new Date().toISOString() } = {}) {
  const filePath = grantRegistryPath(lucHome);
  const existing = readGrantRegistryForStartup(filePath, now);
  if (existing) {
    try {
      return validateGrantRegistry(existing, GRANTS_FILE);
    } catch (err) {
      const repaired = repairGrantRegistryShape(existing, now);
      if (repaired) {
        try {
          validateGrantRegistry(repaired, GRANTS_FILE);
          writeJsonAtomic(filePath, repaired);
          return repaired;
        } catch (repairErr) {
          quarantineGrantRegistry(filePath, existing, now, repairErr);
        }
      } else {
        quarantineGrantRegistry(filePath, existing, now, err);
      }
    }
  }
  const registry = createEmptyGrantRegistry(now);
  writeJsonAtomic(filePath, registry);
  return registry;
}

export function loadGrantRegistry(lucHome) {
  ensureGrantRegistry(lucHome);
  return validateGrantRegistry(readJsonRequired(grantRegistryPath(lucHome), GRANTS_FILE), GRANTS_FILE);
}

export function createGrant(lucHome, input: Record<string, any> = {}) {
  const now = input.now || new Date().toISOString();
  const registry = loadGrantRegistry(lucHome);
  const grant = normalizeGrantRecord({
    schemaVersion: SCHEMA_VERSION,
    grantId: input.grantId || `grant_${crypto.randomUUID()}`,
    principalId: input.principalId,
    subjectKind: input.subjectKind,
    scope: input.scope,
    capabilities: input.capabilities,
    constraints: input.constraints || {},
    status: "active",
    createdAt: now,
    updatedAt: now,
  }, "grant");
  registry.grants.push(grant);
  registry.updatedAt = now;
  persistGrantRegistry(lucHome, registry);
  return clonePlain(grant);
}

export function findActiveGrantsForPrincipal(lucHome, principalId, { now = new Date().toISOString() } = {}) {
  if (!isNonEmptyString(principalId)) return [];
  const registry = loadGrantRegistry(lucHome);
  let changed = false;
  const active = [];
  for (const grant of registry.grants) {
    if (grant.status === "active" && grant.constraints?.expiresAt && Date.parse(grant.constraints.expiresAt) <= Date.parse(now)) {
      grant.status = "expired";
      grant.updatedAt = now;
      changed = true;
    }
    if (grant.principalId === principalId && grant.status === "active") {
      active.push(clonePlain(grant));
    }
  }
  if (changed) persistGrantRegistry(lucHome, registry);
  return active;
}

export function revokeGrant(lucHome, grantId, { now = new Date().toISOString() } = {}) {
  assertNonEmptyString(grantId, "grantId");
  const registry = loadGrantRegistry(lucHome);
  const grant = registry.grants.find((item) => item.grantId === grantId);
  if (!grant) throw new Error(`grant not found: ${grantId}`);
  grant.status = "revoked";
  grant.revokedAt = now;
  grant.updatedAt = now;
  registry.updatedAt = now;
  persistGrantRegistry(lucHome, registry);
  return clonePlain(grant);
}

export function persistGrantRegistry(lucHome, registry) {
  validateGrantRegistry(registry, GRANTS_FILE);
  writeJsonAtomic(grantRegistryPath(lucHome), registry);
}

export function grantRegistryPath(lucHome) {
  if (!isNonEmptyString(lucHome)) throw new Error("lucHome required");
  return path.join(lucHome, SECURITY_DIR, GRANTS_FILE);
}

function createEmptyGrantRegistry(now) {
  return {
    schemaVersion: SCHEMA_VERSION,
    grants: [],
    createdAt: now,
    updatedAt: now,
  };
}

function readGrantRegistryForStartup(filePath, now) {
  try {
    return readJsonIfPresent(filePath, GRANTS_FILE);
  } catch (err) {
    quarantineGrantRegistry(filePath, null, now, err);
    return null;
  }
}

function repairGrantRegistryShape(value, now) {
  if (!isPlainObject(value) || value.schemaVersion !== SCHEMA_VERSION || !Array.isArray(value.grants)) {
    return null;
  }
  let changed = false;
  const grants = [];
  for (const grant of value.grants) {
    if (!isPlainObject(grant)) return null;
    const next = { ...grant };
    if (next.schemaVersion === undefined) {
      next.schemaVersion = SCHEMA_VERSION;
      changed = true;
    }
    try {
      normalizeGrantRecord(next, GRANTS_FILE);
    } catch {
      return null;
    }
    grants.push(next);
  }
  if (!changed) return null;
  return {
    ...value,
    grants,
    updatedAt: now,
  };
}

function quarantineGrantRegistry(filePath, parsedValue, now, err) {
  try {
    if (!fs.existsSync(filePath)) return;
    const stamp = now.replace(/[:.]/g, "-");
    const quarantinePath = `${filePath}.quarantine-${stamp}`;
    fs.renameSync(filePath, quarantinePath);
    const reasonPath = `${quarantinePath}.reason.txt`;
    const reason = [
      `quarantinedAt=${now}`,
      `reason=${err?.message || String(err)}`,
      parsedValue ? `schemaVersion=${parsedValue.schemaVersion ?? "(missing)"}` : "schemaVersion=(unreadable)",
    ].join("\n") + "\n";
    fs.writeFileSync(reasonPath, reason, "utf-8");
  } catch {
    // Startup repair must never make a bad grants file fatal.
  }
}

function validateGrantRegistry(value, label) {
  if (!isPlainObject(value)) throw new Error(`invalid ${label}: expected object`);
  if (value.schemaVersion !== SCHEMA_VERSION) throw new Error(`invalid ${label}: schemaVersion must be 1`);
  if (!Array.isArray(value.grants)) throw new Error(`invalid ${label}: grants must be an array`);
  const seen = new Set();
  for (const grant of value.grants) {
    const normalized = normalizeGrantRecord(grant, label);
    if (seen.has(normalized.grantId)) throw new Error(`invalid ${label}: duplicate grantId ${normalized.grantId}`);
    seen.add(normalized.grantId);
  }
  return value;
}

function normalizeGrantRecord(value, label) {
  if (!isPlainObject(value)) throw new Error(`invalid ${label}: grant must be object`);
  if (value.schemaVersion !== SCHEMA_VERSION) throw new Error(`invalid ${label}: grant.schemaVersion must be 1`);
  assertRecordString(value.grantId, label, "grantId");
  assertRecordString(value.principalId, label, "principalId");
  if (!SUBJECT_KINDS.has(value.subjectKind)) throw new Error(`invalid ${label}: subjectKind invalid`);
  if (!STATUSES.has(value.status)) throw new Error(`invalid ${label}: status invalid`);
  if (!isPlainObject(value.scope)) throw new Error(`invalid ${label}: scope must be object`);
  assertRecordString(value.scope.studioId, label, "scope.studioId");
  if (!Array.isArray(value.capabilities) || value.capabilities.length === 0) {
    throw new Error(`invalid ${label}: capabilities must be a non-empty array`);
  }
  const capabilities = normalizeStringArray(value.capabilities, "capabilities");
  const constraints = isPlainObject(value.constraints) ? value.constraints : {};
  if (constraints.transportKinds !== undefined) {
    normalizeStringArray(constraints.transportKinds, "transportKinds");
  }
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    grantId: value.grantId,
    principalId: value.principalId,
    subjectKind: value.subjectKind,
    scope: sanitizeScope(value.scope),
    capabilities,
    constraints: sanitizeConstraints(constraints),
    status: value.status,
    createdAt: value.createdAt || null,
    updatedAt: value.updatedAt || null,
    ...(value.revokedAt ? { revokedAt: value.revokedAt } : {}),
  });
}

function sanitizeScope(scope) {
  const out: Record<string, any> = {};
  for (const key of ["studioId", "agentId", "sessionId", "sessionPath", "resourceId", "mountId", "serverNodeId"]) {
    if (isNonEmptyString(scope[key])) out[key] = scope[key].trim();
  }
  return out;
}

function sanitizeConstraints(constraints) {
  const out: Record<string, any> = {};
  if (Array.isArray(constraints.transportKinds)) {
    out.transportKinds = normalizeStringArray(constraints.transportKinds, "transportKinds");
  }
  if (isNonEmptyString(constraints.expiresAt)) out.expiresAt = constraints.expiresAt.trim();
  if (Number.isFinite(constraints.maxBytesPerRequest)) out.maxBytesPerRequest = constraints.maxBytesPerRequest;
  if (typeof constraints.allowSecretRead === "boolean") out.allowSecretRead = constraints.allowSecretRead;
  return out;
}

function normalizeStringArray(value, label) {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} must be a non-empty array`);
  const out = [];
  const seen = new Set();
  for (const item of value) {
    if (!isNonEmptyString(item)) throw new Error(`${label} entries must be non-empty strings`);
    const trimmed = item.trim();
    if (!seen.has(trimmed)) {
      seen.add(trimmed);
      out.push(trimmed);
    }
  }
  return out;
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

function writeJsonAtomic(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  atomicWriteSync(filePath, JSON.stringify(data, null, 2) + "\n");
}

function assertRecordString(value, fileLabel, fieldLabel) {
  if (!isNonEmptyString(value)) throw new Error(`invalid ${fileLabel}: ${fieldLabel} required`);
}

function assertNonEmptyString(value, label) {
  if (!isNonEmptyString(value)) throw new Error(`${label} required`);
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
