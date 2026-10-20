import fs from "fs";
import path from "path";
import { atomicWriteSync } from "../shared/safe-fs.ts";
import { validateExecutionLease } from "./remote-execution-boundary.ts";
import { SECURITY_DIR } from "./security-dir.ts";

export const EXECUTION_LEASES_FILE = "execution-leases.json";

const SCHEMA_VERSION = 1;
const STATUSES = new Set(["issued", "consumed", "expired", "revoked"]);

export function ensureExecutionLeaseRegistry(lucHome, { now = new Date().toISOString() } = {}) {
  const filePath = executionLeaseRegistryPath(lucHome);
  const existing = readJsonIfPresent(filePath, EXECUTION_LEASES_FILE);
  if (existing) {
    validateExecutionLeaseRegistry(existing, EXECUTION_LEASES_FILE, { now });
    return existing;
  }
  const registry = createEmptyExecutionLeaseRegistry(now);
  writeJsonAtomic(filePath, registry);
  return registry;
}

export function loadExecutionLeaseRegistry(lucHome, { now = new Date().toISOString() } = {}) {
  ensureExecutionLeaseRegistry(lucHome, { now });
  return validateExecutionLeaseRegistry(
    readJsonRequired(executionLeaseRegistryPath(lucHome), EXECUTION_LEASES_FILE),
    EXECUTION_LEASES_FILE,
    { now },
  );
}

export function issueExecutionLease(lucHome, lease, { now = new Date().toISOString() } = {}) {
  const registry = loadExecutionLeaseRegistry(lucHome, { now });
  const record = normalizeLeaseRecord({
    ...lease,
    status: "issued",
    createdAt: lease.createdAt || now,
  }, { now, validateExpiry: true });
  if (registry.leases.some((item) => item.leaseId === record.leaseId)) {
    throw new Error(`execution lease already exists: ${record.leaseId}`);
  }
  registry.leases.push(record);
  registry.updatedAt = now;
  persistExecutionLeaseRegistry(lucHome, registry);
  return clonePlain(record);
}

export function consumeExecutionLease(lucHome, leaseId, { now = new Date().toISOString() } = {}) {
  const registry = loadExecutionLeaseRegistry(lucHome, { now });
  const lease = registry.leases.find((item) => item.leaseId === leaseId);
  if (!lease) throw new Error(`execution lease not found: ${leaseId}`);
  if (lease.status !== "issued") throw new Error(`execution lease is ${lease.status}`);
  validateExecutionLease(lease, { now });
  lease.status = "consumed";
  lease.consumedAt = now;
  registry.updatedAt = now;
  persistExecutionLeaseRegistry(lucHome, registry);
  return clonePlain(lease);
}

export function revokeExecutionLease(lucHome, leaseId, { now = new Date().toISOString() } = {}) {
  const registry = loadExecutionLeaseRegistry(lucHome, { now });
  const lease = registry.leases.find((item) => item.leaseId === leaseId);
  if (!lease) throw new Error(`execution lease not found: ${leaseId}`);
  lease.status = "revoked";
  lease.revokedAt = now;
  registry.updatedAt = now;
  persistExecutionLeaseRegistry(lucHome, registry);
  return clonePlain(lease);
}

export function persistExecutionLeaseRegistry(lucHome, registry) {
  validateExecutionLeaseRegistry(registry, EXECUTION_LEASES_FILE, { validateExpiry: false });
  writeJsonAtomic(executionLeaseRegistryPath(lucHome), registry);
}

export function executionLeaseRegistryPath(lucHome) {
  if (!isNonEmptyString(lucHome)) throw new Error("lucHome required");
  return path.join(lucHome, SECURITY_DIR, EXECUTION_LEASES_FILE);
}

function createEmptyExecutionLeaseRegistry(now) {
  return {
    schemaVersion: SCHEMA_VERSION,
    leases: [],
    createdAt: now,
    updatedAt: now,
  };
}

function validateExecutionLeaseRegistry(value, label, { now = new Date().toISOString(), validateExpiry = false } = {}) {
  if (!isPlainObject(value)) throw new Error(`invalid ${label}: expected object`);
  if (value.schemaVersion !== SCHEMA_VERSION) throw new Error(`invalid ${label}: schemaVersion must be 1`);
  if (!Array.isArray(value.leases)) throw new Error(`invalid ${label}: leases must be an array`);
  const seen = new Set();
  for (const lease of value.leases) {
    const normalized = normalizeLeaseRecord(lease, { now, validateExpiry });
    if (seen.has(normalized.leaseId)) throw new Error(`invalid ${label}: duplicate leaseId ${normalized.leaseId}`);
    seen.add(normalized.leaseId);
  }
  return value;
}

function normalizeLeaseRecord(lease, { now = new Date().toISOString(), validateExpiry = false } = {}) {
  if (!STATUSES.has(lease?.status)) throw new Error("invalid execution lease: status invalid");
  const validationNow = validateExpiry && lease.status === "issued" ? now : "1970-01-01T00:00:00.000Z";
  const validated = validateExecutionLease(lease, { now: validationNow });
  return Object.freeze({
    ...validated,
    capabilityDecisionId: lease.capabilityDecisionId ?? null,
    status: lease.status,
    consumedAt: lease.consumedAt ?? null,
    revokedAt: lease.revokedAt ?? null,
  });
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

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function clonePlain(value) {
  return JSON.parse(JSON.stringify(value));
}
