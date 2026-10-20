import fs from "fs";
import path from "path";
import { atomicWriteSync } from "../shared/safe-fs.ts";

export const SERVER_NETWORK_FILE = "server-network.json";

const SCHEMA_VERSION = 1;
export const DEFAULT_SERVER_LISTEN_PORT = 14500;
const MODES = ["loopback", "lan", "custom_remote"];
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const MIN_USER_PORT = 1024;
const MAX_PORT = 65535;

export function ensureServerNetworkConfig(lucHome, { now = new Date().toISOString() } = {}) {
  const filePath = path.join(lucHome, SERVER_NETWORK_FILE);
  const existing = readJsonIfPresent(filePath, SERVER_NETWORK_FILE);
  if (existing) {
    validateServerNetworkConfig(existing, SERVER_NETWORK_FILE);
    return { created: [] };
  }
  writeJsonAtomic(filePath, createDefaultServerNetworkConfig(now));
  return { created: [SERVER_NETWORK_FILE] };
}

export function loadServerNetworkConfig(lucHome) {
  ensureServerNetworkConfig(lucHome);
  const config = readJsonRequired(path.join(lucHome, SERVER_NETWORK_FILE), SERVER_NETWORK_FILE);
  return validateServerNetworkConfig(config, SERVER_NETWORK_FILE);
}

export function saveServerNetworkConfig(lucHome, config, { now = new Date().toISOString() } = {}) {
  const normalized = validateServerNetworkConfig({
    ...config,
    schemaVersion: SCHEMA_VERSION,
    customRemote: normalizeCustomRemote(config?.customRemote),
    createdAt: config?.createdAt || now,
    updatedAt: now,
  }, SERVER_NETWORK_FILE);
  writeJsonAtomic(path.join(lucHome, SERVER_NETWORK_FILE), normalized);
  return normalized;
}

export function resolveServerListenOptions(lucHome) {
  const config = loadServerNetworkConfig(lucHome);
  return {
    mode: config.mode,
    host: config.listenHost,
    port: config.listenPort,
    config,
  };
}

export function validateServerNetworkConfig(value, label = SERVER_NETWORK_FILE) {
  if (!isPlainObject(value)) throw new Error(`invalid ${label}: expected object`);
  if (value.schemaVersion !== SCHEMA_VERSION) throw new Error(`invalid ${label}: schemaVersion must be 1`);
  if (!MODES.includes(value.mode)) throw new Error(`invalid ${label}: mode must be one of ${MODES.join(", ")}`);
  if (!isNonEmptyString(value.listenHost)) throw new Error(`invalid ${label}: listenHost required`);
  if (value.mode === "loopback" && !isLoopbackHost(value.listenHost)) {
    throw new Error(`invalid ${label}: loopback mode must listen on a loopback host`);
  }
  const listenPort = normalizeListenPort(value.listenPort, label);
  return {
    schemaVersion: SCHEMA_VERSION,
    mode: value.mode,
    listenHost: value.listenHost.trim(),
    listenPort,
    customRemote: normalizeCustomRemote(value.customRemote),
    createdAt: value.createdAt || null,
    updatedAt: value.updatedAt || null,
  };
}

function createDefaultServerNetworkConfig(now) {
  return {
    schemaVersion: SCHEMA_VERSION,
    mode: "loopback",
    listenHost: "127.0.0.1",
    listenPort: DEFAULT_SERVER_LISTEN_PORT,
    customRemote: { enabled: false, baseUrl: null, wsUrl: null },
    createdAt: now,
    updatedAt: now,
  };
}

function normalizeCustomRemote(value) {
  if (value === undefined || value === null) {
    return { enabled: false, baseUrl: null, wsUrl: null };
  }
  if (!isPlainObject(value)) throw new Error(`invalid ${SERVER_NETWORK_FILE}: customRemote must be object`);
  return {
    enabled: value.enabled === true,
    baseUrl: isNonEmptyString(value.baseUrl) ? value.baseUrl.trim() : null,
    wsUrl: isNonEmptyString(value.wsUrl) ? value.wsUrl.trim() : null,
  };
}

function isLoopbackHost(host) {
  return LOOPBACK_HOSTS.has(host.trim().toLowerCase());
}

function normalizeListenPort(value, label) {
  const port = value === undefined || value === null || value === ""
    ? DEFAULT_SERVER_LISTEN_PORT
    : Number(value);
  if (!Number.isInteger(port) || port < MIN_USER_PORT || port > MAX_PORT) {
    throw new Error(`invalid ${label}: listenPort must be between ${MIN_USER_PORT} and ${MAX_PORT}`);
  }
  return port;
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
