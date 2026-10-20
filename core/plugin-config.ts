import fs from "fs";
import path from "path";
import { writeSecretFileSync } from "../shared/secret-fs.ts";
import { createModuleLogger } from "../lib/debug-log.ts";

const log = createModuleLogger("plugin-config");

/**
 * Layout of plugin data on disk. Exported because the startup custody pass has
 * to look in exactly the place this module writes to; naming that place twice
 * is how the two would drift apart.
 */
export const PLUGIN_DATA_DIRNAME = "plugin-data";
export const PLUGIN_CONFIG_FILENAME = "config.json";

const SUPPORTED_TYPES = new Set(["string", "number", "integer", "boolean", "object", "array"]);
const SCOPES = new Set(["global", "per-agent", "per-session"]);
const REDACTED_VALUE = "********";

export class PluginConfigValidationError extends Error {
  declare code: string;
  declare errors: any;

  constructor(errors) {
    super("Plugin config validation failed");
    this.name = "PluginConfigValidationError";
    this.code = "PLUGIN_CONFIG_INVALID";
    this.errors = errors;
  }
}

export function normalizePluginConfigSchema(pluginId, rawSchema: Record<string, any> = {}) {
  const rawProperties = rawSchema?.properties && typeof rawSchema.properties === "object"
    ? rawSchema.properties
    : {};
  const properties = {};
  for (const [key, rawProperty] of Object.entries(rawProperties)) {
    properties[key] = normalizeProperty(key, rawProperty);
  }
  return {
    pluginId,
    type: "object",
    properties,
    required: Array.isArray(rawSchema.required) ? rawSchema.required.filter((key) => key in properties) : [],
    migrationVersion: Number.isInteger(rawSchema.migrationVersion) ? rawSchema.migrationVersion : 1,
  };
}

export function createPluginConfigStore({ dataDir, schema }) {
  const configPath = path.join(dataDir, PLUGIN_CONFIG_FILENAME);
  const normalizedSchema = schema || normalizePluginConfigSchema("", {});

  function readState() {
    const raw = readJson(configPath);
    const state = normalizeState(raw);
    state.global = applyDefaults(normalizedSchema, state.global);
    return state;
  }

  function writeState(state) {
    fs.mkdirSync(dataDir, { recursive: true });
    const next = {
      schemaVersion: 1,
      global: state.global || {},
      agents: state.agents || {},
      sessions: state.sessions || {},
    };
    // Plugin configuration carries whatever a plugin asks its user for, which
    // for connector-style plugins is service credentials and access tokens.
    writeSecretFileSync(configPath, `${JSON.stringify(next, null, 2)}\n`);
  }

  function resolveBucket(state, options: Record<string, any> = {}, create = false) {
    const scope = normalizeScope(options.scope);
    if (scope === "global") return state.global;
    if (scope === "per-agent") {
      const agentId = requireScopeId("agentId", options.agentId);
      if (create && !state.agents[agentId]) state.agents[agentId] = {};
      return state.agents[agentId] || {};
    }
    const { key: sessionKey, legacyKeys } = resolveSessionConfigKey(options);
    const legacyKey = legacyKeys.find((key) => isPlainObject(state.sessions[key]));
    if (create && !state.sessions[sessionKey]) {
      state.sessions[sessionKey] = legacyKey
        ? structuredClone(state.sessions[legacyKey])
        : {};
    }
    return state.sessions[sessionKey] || (legacyKey ? state.sessions[legacyKey] : {});
  }

  return {
    get(key, options = {}) {
      const state = readState();
      const bucket = resolveBucket(state, options);
      if (!key) return structuredClone(bucket);
      return bucket[key];
    },
    getAll(options: Record<string, any> = {}) {
      const state = readState();
      const values = resolveBucket(state, options);
      return options.redacted ? redactConfigValues(normalizedSchema, values) : structuredClone(values);
    },
    set(key, value, options = {}) {
      if (!key) throw new Error("plugin config key is required");
      const state = readState();
      const bucket = resolveBucket(state, options, true);
      const errors = validatePluginConfigPatch(normalizedSchema, { [key]: value }, options);
      if (errors.length > 0) throw new PluginConfigValidationError(errors);
      if (value === undefined) delete bucket[key];
      else bucket[key] = value;
      writeState(state);
    },
    setMany(values, options = {}) {
      if (!values || typeof values !== "object" || Array.isArray(values)) {
        throw new Error("plugin config values must be an object");
      }
      const errors = validatePluginConfigPatch(normalizedSchema, values, options);
      if (errors.length > 0) throw new PluginConfigValidationError(errors);
      const state = readState();
      const bucket = resolveBucket(state, options, true);
      for (const [key, value] of Object.entries(values)) {
        if (value === undefined) delete bucket[key];
        else bucket[key] = value;
      }
      writeState(state);
      return structuredClone(bucket);
    },
    getSchema() {
      return structuredClone(normalizedSchema);
    },
    getState(options: Record<string, any> = {}) {
      const state = readState();
      return options.redacted
        ? {
            ...state,
            global: redactConfigValues(normalizedSchema, state.global),
            agents: redactScopedValues(normalizedSchema, state.agents),
            sessions: redactScopedValues(normalizedSchema, state.sessions),
          }
        : structuredClone(state);
    },
    forkSession({
      sourceSessionId,
      sourceSessionPath = null,
      targetSessionId,
    }: Record<string, any> = {}) {
      const sourceId = requireScopeId("sourceSessionId", sourceSessionId);
      const targetId = requireScopeId("targetSessionId", targetSessionId);
      if (sourceId === targetId) {
        throw new Error("plugin config fork requires distinct source and target session ids");
      }
      const state = readState();
      if (Object.prototype.hasOwnProperty.call(state.sessions, targetId)) {
        throw new Error(`plugin config target session already exists: ${targetId}`);
      }
      const sourceKeys = [sourceId, text(sourceSessionPath, "")].filter(Boolean);
      const sourceKey = sourceKeys.find((key) => isPlainObject(state.sessions[key]));
      if (!sourceKey) {
        return { copied: false, sourceSessionId: sourceId, targetSessionId: targetId };
      }
      state.sessions[targetId] = structuredClone(state.sessions[sourceKey]);
      writeState(state);
      return {
        copied: true,
        sourceSessionId: sourceId,
        sourceKey,
        targetSessionId: targetId,
      };
    },
    discardSession({ sessionId }: Record<string, any> = {}) {
      const targetId = requireScopeId("sessionId", sessionId);
      const state = readState();
      if (!Object.prototype.hasOwnProperty.call(state.sessions, targetId)) return false;
      delete state.sessions[targetId];
      writeState(state);
      return true;
    },
  };

}

export function validatePluginConfigPatch(schema, values, options: Record<string, any> = {}) {
  const errors = [];
  const scope = normalizeScope(options.scope);
  const properties = schema.properties || {};
  const schemaIsOpen = Object.keys(properties).length === 0;
  for (const [key, value] of Object.entries(values || {})) {
    const property = properties[key];
    if (!property) {
      if (schemaIsOpen) continue;
      errors.push({ key, code: "UNKNOWN_FIELD", message: `Unknown config field "${key}"` });
      continue;
    }
    if (property.scope !== scope) {
      errors.push({
        key,
        code: "WRONG_SCOPE",
        message: `Config field "${key}" belongs to scope "${property.scope}"`,
      });
      continue;
    }
    const error = validateValue(key, property, value);
    if (error) errors.push(error);
  }
  return errors;
}

export function redactConfigValues(schema, values = {}) {
  const output = structuredClone(values || {});
  for (const [key, property] of Object.entries(schema.properties || {}) as [string, any][]) {
    if (property.sensitive && output[key] !== undefined && output[key] !== null && output[key] !== "") {
      output[key] = REDACTED_VALUE;
    }
  }
  return output;
}

function normalizeProperty(key, raw: Record<string, any> = {}) {
  const type = SUPPORTED_TYPES.has(raw.type) ? raw.type : inferType(raw.default);
  const scope = SCOPES.has(raw.scope) ? raw.scope : "global";
  return {
    type,
    title: text(raw.title, key),
    description: text(raw.description, ""),
    default: raw.default,
    enum: Array.isArray(raw.enum) ? [...raw.enum] : undefined,
    scope,
    sensitive: raw.sensitive === true,
    ui: raw.ui && typeof raw.ui === "object" && !Array.isArray(raw.ui) ? structuredClone(raw.ui) : {},
    reloadRequired: raw.reloadRequired === true,
    migrationVersion: Number.isInteger(raw.migrationVersion) ? raw.migrationVersion : undefined,
  };
}

function inferType(defaultValue) {
  if (typeof defaultValue === "boolean") return "boolean";
  if (typeof defaultValue === "number") return Number.isInteger(defaultValue) ? "integer" : "number";
  if (Array.isArray(defaultValue)) return "array";
  if (defaultValue && typeof defaultValue === "object") return "object";
  return "string";
}

function validateValue(key, property, value) {
  if (value === undefined) return null;
  if (property.enum && !property.enum.includes(value)) {
    return { key, code: "INVALID_ENUM", message: `Config field "${key}" must be one of its enum values` };
  }
  if (property.type === "array") {
    return Array.isArray(value) ? null : typeError(key, property.type);
  }
  if (property.type === "integer") {
    return Number.isInteger(value) ? null : typeError(key, property.type);
  }
  if (property.type === "object") {
    return value && typeof value === "object" && !Array.isArray(value) ? null : typeError(key, property.type);
  }
  return typeof value === property.type ? null : typeError(key, property.type);
}

function typeError(key, type) {
  return { key, code: "INVALID_TYPE", message: `Config field "${key}" must be ${type}` };
}

function applyDefaults(schema, values = {}) {
  const next = { ...(values || {}) };
  for (const [key, property] of Object.entries(schema.properties || {}) as [string, any][]) {
    if (property.scope !== "global") continue;
    if (next[key] === undefined && property.default !== undefined) {
      next[key] = structuredClone(property.default);
    }
  }
  return next;
}

function normalizeState(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { schemaVersion: 1, global: {}, agents: {}, sessions: {} };
  }
  if ("global" in raw || "agents" in raw || "sessions" in raw || "schemaVersion" in raw) {
    return {
      schemaVersion: 1,
      global: isPlainObject(raw.global) ? raw.global : {},
      agents: isPlainObject(raw.agents) ? raw.agents : {},
      sessions: isPlainObject(raw.sessions) ? raw.sessions : {},
    };
  }
  return { schemaVersion: 1, global: raw, agents: {}, sessions: {} };
}

function redactScopedValues(schema, records = {}) {
  const output = {};
  for (const [id, values] of Object.entries(records || {})) {
    output[id] = redactConfigValues(schema, values);
  }
  return output;
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (err) {
    if (err.code !== "ENOENT") log.warn(`failed to read ${filePath}: ${err.message}`);
    return {};
  }
}

function normalizeScope(scope) {
  return SCOPES.has(scope) ? scope : "global";
}

function requireScopeId(label, value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`plugin config ${label} is required for scoped config`);
  }
  return value;
}

function resolveSessionConfigKey(options: Record<string, any> = {}) {
  const sessionId = text(options.sessionId, "");
  if (sessionId) {
    const legacyKeys = [
      text(options.sessionPath, ""),
      text(options.legacySessionPath, ""),
    ].filter(Boolean);
    return { key: sessionId, legacyKeys };
  }
  const sessionPath = requireScopeId("sessionId or sessionPath", options.sessionPath);
  return { key: sessionPath, legacyKeys: [] };
}

function isPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function text(value, fallback) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}
