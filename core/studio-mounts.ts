import fs from "fs";
import path from "path";
import { atomicWriteSync } from "../shared/safe-fs.ts";

export const STUDIO_MOUNTS_FILE = "studio-mounts.json";

const SCHEMA_VERSION = 1;
const SOURCE_KINDS = ["storage", "studio"];
const STORAGE_PROVIDERS = ["local_fs", "webdav", "s3", "google_drive", "luc_cloud"];
const PRESENTATIONS = ["folder", "external_panel", "linked_studio"];
const STATUSES = ["active", "disabled"];
const CAPABILITIES = ["list", "read", "write", "watch", "materialize", "execute"];

export function ensureStudioMountRegistry(lucHome, { now = new Date().toISOString() } = {}) {
  const filePath = path.join(lucHome, STUDIO_MOUNTS_FILE);
  const current = readJsonIfPresent(filePath, STUDIO_MOUNTS_FILE);
  if (current) {
    validateStudioMountRegistry(current);
    return { created: [] };
  }
  writeJsonAtomic(filePath, {
    schemaVersion: SCHEMA_VERSION,
    mounts: [],
    createdAt: now,
    updatedAt: now,
  });
  return { created: [STUDIO_MOUNTS_FILE] };
}

export function loadStudioMountRegistry(lucHome) {
  ensureStudioMountRegistry(lucHome);
  const registry = readJsonRequired(path.join(lucHome, STUDIO_MOUNTS_FILE), STUDIO_MOUNTS_FILE);
  validateStudioMountRegistry(registry);
  return registry;
}

export function upsertStudioMount(lucHome, mount, { now = new Date().toISOString() } = {}) {
  const registry = loadStudioMountRegistry(lucHome);
  const normalized = validateStudioMount({
    ...mount,
    schemaVersion: SCHEMA_VERSION,
    status: mount.status || "active",
    createdAt: mount.createdAt || now,
    updatedAt: mount.updatedAt || now,
  });
  const existingIndex = registry.mounts.findIndex((item) => item.mountId === normalized.mountId);
  if (existingIndex >= 0) {
    registry.mounts[existingIndex] = {
      ...normalized,
      createdAt: registry.mounts[existingIndex].createdAt || normalized.createdAt,
      updatedAt: now,
    };
  } else {
    registry.mounts.push(normalized);
  }
  registry.updatedAt = now;
  validateStudioMountRegistry(registry);
  writeJsonAtomic(path.join(lucHome, STUDIO_MOUNTS_FILE), registry);
  return clonePlain(existingIndex >= 0 ? registry.mounts[existingIndex] : normalized);
}

export function disableStudioMount(
  lucHome,
  mountId,
  options: { hostStudioId?: string; now?: string } = {},
) {
  const { hostStudioId, now = new Date().toISOString() } = options;
  if (!isNonEmptyString(mountId)) throw new Error("mountId required");
  if (hostStudioId !== undefined && !isNonEmptyString(hostStudioId)) throw new Error("hostStudioId required");
  const registry = loadStudioMountRegistry(lucHome);
  const existingIndex = registry.mounts.findIndex((item) =>
    item.mountId === mountId && (hostStudioId === undefined || item.hostStudioId === hostStudioId)
  );
  if (existingIndex < 0) throw new Error(`studio mount not found: ${mountId}`);
  registry.mounts[existingIndex] = {
    ...registry.mounts[existingIndex],
    status: "disabled",
    updatedAt: now,
  };
  registry.updatedAt = now;
  validateStudioMountRegistry(registry);
  writeJsonAtomic(path.join(lucHome, STUDIO_MOUNTS_FILE), registry);
  return clonePlain(registry.mounts[existingIndex]);
}

export function listStudioMountsForStudio(lucHome, hostStudioId) {
  if (!isNonEmptyString(hostStudioId)) throw new Error("hostStudioId required");
  const registry = loadStudioMountRegistry(lucHome);
  return registry.mounts
    .filter((mount) => mount.hostStudioId === hostStudioId)
    .map(clonePlain);
}

export function validateStudioMountRegistry(value) {
  if (!isPlainObject(value)) throw new Error(`invalid ${STUDIO_MOUNTS_FILE}: expected object`);
  if (value.schemaVersion !== SCHEMA_VERSION) throw new Error(`invalid ${STUDIO_MOUNTS_FILE}: schemaVersion must be 1`);
  if (!Array.isArray(value.mounts)) throw new Error(`invalid ${STUDIO_MOUNTS_FILE}: mounts must be an array`);
  const seen = new Set();
  for (const mount of value.mounts) {
    const normalized = validateStudioMount(mount);
    if (seen.has(normalized.mountId)) throw new Error(`invalid ${STUDIO_MOUNTS_FILE}: duplicate mountId ${normalized.mountId}`);
    seen.add(normalized.mountId);
  }
}

export function validateStudioMount(value) {
  if (!isPlainObject(value)) throw new Error("invalid studio mount: expected object");
  if (value.schemaVersion !== SCHEMA_VERSION) throw new Error("invalid studio mount: schemaVersion must be 1");
  assertNonEmptyString(value.mountId, "mountId");
  assertNonEmptyString(value.hostStudioId, "hostStudioId");
  if (!SOURCE_KINDS.includes(value.sourceKind)) {
    throw new Error(`sourceKind must be one of ${SOURCE_KINDS.join(", ")}`);
  }
  if (!PRESENTATIONS.includes(value.presentation)) {
    throw new Error(`presentation must be one of ${PRESENTATIONS.join(", ")}`);
  }
  if (!STATUSES.includes(value.status)) throw new Error(`status must be one of ${STATUSES.join(", ")}`);
  assertNonEmptyString(value.label, "label");

  const normalized: {
    schemaVersion: number;
    mountId: any;
    hostStudioId: any;
    sourceKind: any;
    label: any;
    presentation: any;
    capabilities: string[];
    grantId: any;
    status: any;
    createdAt: any;
    updatedAt: any;
    provider?: any;
    rootLocator?: any;
    sourceStudioId?: any;
    sourceResourceId?: any;
  } = {
    schemaVersion: SCHEMA_VERSION,
    mountId: value.mountId,
    hostStudioId: value.hostStudioId,
    sourceKind: value.sourceKind,
    label: value.label,
    presentation: value.presentation,
    capabilities: normalizeMountCapabilities(value.capabilities),
    grantId: value.grantId ?? null,
    status: value.status,
    createdAt: value.createdAt || null,
    updatedAt: value.updatedAt || null,
  };

  if (value.sourceKind === "storage") {
    if (!STORAGE_PROVIDERS.includes(value.provider)) {
      throw new Error(`provider must be one of ${STORAGE_PROVIDERS.join(", ")}`);
    }
    normalized.provider = value.provider;
    if (value.rootLocator !== undefined) normalized.rootLocator = value.rootLocator;
  } else {
    assertNonEmptyString(value.sourceStudioId, "sourceStudioId");
    assertNonEmptyString(value.sourceResourceId, "sourceResourceId");
    assertNonEmptyString(value.grantId, "grantId");
    if (value.sourceStudioId === value.hostStudioId) {
      throw new Error("Studio mount cannot point at its own hostStudioId");
    }
    normalized.sourceStudioId = value.sourceStudioId;
    normalized.sourceResourceId = value.sourceResourceId;
  }
  return normalized;
}

export function normalizeMountCapabilities(capabilities) {
  if (!Array.isArray(capabilities) || capabilities.length === 0) {
    throw new Error("capabilities must be a non-empty array");
  }
  const seen = new Set();
  for (const capability of capabilities) {
    if (!CAPABILITIES.includes(capability)) {
      throw new Error(`unknown mount capability: ${capability}`);
    }
    seen.add(capability);
  }
  return CAPABILITIES.filter((capability) => seen.has(capability));
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
