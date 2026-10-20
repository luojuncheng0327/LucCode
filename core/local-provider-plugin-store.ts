import fs from "fs";
import path from "path";
import crypto from "crypto";
import { writeSecretFileSync } from "../shared/secret-fs.ts";
import { normalizeProviderAuthType } from "../shared/provider-auth.ts";

export const LOCAL_PROVIDER_PLUGINS_DIR = "provider-plugins";
export const LOCAL_PROVIDER_PLUGIN_SOURCE_KIND = "local-provider-plugin";
export const LOCAL_PROVIDER_PLUGIN_SCHEMA_VERSION = 1;

const PROVIDER_DEFINITION_KEYS = new Set([
  "id",
  "display_name",
  "displayName",
  "auth_type",
  "authType",
  "base_url",
  "baseUrl",
  "defaultBaseUrl",
  "api",
  "defaultApi",
  "models",
  "runtime",
  "capabilities",
  "description",
  "docsUrl",
  "homepage",
  "icon",
]);

function isPlainObject(value: any): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function cloneData<T>(value: T): T {
  return structuredClone(value);
}

function hasOwn(value: any, key: string) {
  return Object.prototype.hasOwnProperty.call(value || {}, key);
}

function nonEmptyString(value: any) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

export function isSafeLocalProviderPluginId(providerId: any) {
  if (typeof providerId !== "string") return false;
  const id = providerId.trim();
  if (!id || id === "." || id === "..") return false;
  if (id.includes("/") || id.includes("\\") || id.includes("\0")) return false;
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id);
}

export function isSafeLocalProviderPluginProviderId(providerId: any) {
  if (typeof providerId !== "string") return false;
  const id = providerId.trim();
  if (!id || id === "." || id === "..") return false;
  if (id.includes("/") || id.includes("\\") || id.includes("\0")) return false;
  return true;
}

function isLegacyLocalProviderPluginPathSegment(providerId: any) {
  if (!isSafeLocalProviderPluginProviderId(providerId)) return false;
  return !/[<>:"|?*]/.test(providerId.trim());
}

function assertSafeLocalProviderPluginProviderId(providerId: any) {
  if (!isSafeLocalProviderPluginProviderId(providerId)) {
    throw new Error(`Invalid local provider plugin id: ${String(providerId)}`);
  }
  return providerId.trim();
}

function assertSafeLocalProviderPluginStorageId(storageId: any) {
  if (!isSafeLocalProviderPluginId(storageId)) {
    throw new Error(`Invalid local provider plugin storage id: ${String(storageId)}`);
  }
  return storageId.trim();
}

export function localProviderPluginStorageId(providerId: any) {
  const id = assertSafeLocalProviderPluginProviderId(providerId);
  if (isSafeLocalProviderPluginId(id)) return id;
  const digest = crypto.createHash("sha256").update(id).digest("hex").slice(0, 16);
  return `provider-${digest}`;
}

function normalizeModels(value: any) {
  if (!Array.isArray(value)) return [];
  const models = [];
  for (const model of value) {
    if (typeof model === "string" && model.trim()) {
      models.push(model.trim());
      continue;
    }
    if (isPlainObject(model) && typeof model.id === "string" && model.id.trim()) {
      models.push({ ...cloneData(model), id: model.id.trim() });
    }
  }
  return models;
}

function modelIdOf(model: any) {
  return typeof model === "object" && model !== null ? model.id : model;
}

function mergeModelEntries(base: any, overlay: any) {
  const baseIsObject = isPlainObject(base);
  const overlayIsObject = isPlainObject(overlay);
  const id = String(modelIdOf(overlay) || modelIdOf(base) || "").trim();
  if (!id) return null;
  if (!baseIsObject && !overlayIsObject) return id;
  return {
    ...(baseIsObject ? cloneData(base) : { id }),
    ...(overlayIsObject ? cloneData(overlay) : {}),
    id,
  };
}

export function mergeProviderModelEntries(baseModels: any, overlayModels: any) {
  const base = normalizeModels(baseModels);
  const overlay = normalizeModels(overlayModels);
  if (base.length === 0) return overlay;
  if (overlay.length === 0) return base;

  const byId = new Map<string, any>();
  const order: string[] = [];
  for (const model of base) {
    const id = String(modelIdOf(model) || "").trim();
    if (!id) continue;
    byId.set(id, model);
    order.push(id);
  }
  for (const model of overlay) {
    const id = String(modelIdOf(model) || "").trim();
    if (!id) continue;
    const merged = mergeModelEntries(byId.get(id), model);
    if (!merged) continue;
    if (!byId.has(id)) order.push(id);
    byId.set(id, merged);
  }
  return order.map((id) => byId.get(id)).filter(Boolean);
}

export function replaceProviderModelEntries(baseModels: any, nextModels: any) {
  const base = normalizeModels(baseModels);
  const next = normalizeModels(nextModels);
  if (base.length === 0) return next;
  if (next.length === 0) return [];

  const baseById = new Map<string, any>();
  for (const model of base) {
    const id = String(modelIdOf(model) || "").trim();
    if (id) baseById.set(id, model);
  }

  return next
    .map((model) => mergeModelEntries(baseById.get(String(modelIdOf(model) || "").trim()), model))
    .filter(Boolean);
}

function normalizeCapabilities(config: Record<string, any>) {
  const capabilities = isPlainObject(config.capabilities) ? cloneData(config.capabilities) : {};
  if (isPlainObject(config.media)) {
    capabilities.media = {
      ...(isPlainObject(capabilities.media) ? capabilities.media : {}),
      ...cloneData(config.media),
    };
  }
  return Object.keys(capabilities).length > 0 ? capabilities : null;
}

function pickProviderDefinitionFields(config: Record<string, any>) {
  const picked: Record<string, any> = {};
  for (const [key, value] of Object.entries(config || {})) {
    if (PROVIDER_DEFINITION_KEYS.has(key)) picked[key] = value;
  }
  return picked;
}

function normalizeLocalProviderPlugin(providerId: string, config: Record<string, any>) {
  const id = assertSafeLocalProviderPluginProviderId(providerId);
  const models = normalizeModels(config.models);
  const runtime = isPlainObject(config.runtime) ? cloneData(config.runtime) : null;
  const capabilities = normalizeCapabilities(config);
  const displayName = nonEmptyString(config.displayName)
    || nonEmptyString(config.display_name)
    || id;
  const defaultBaseUrl = nonEmptyString(config.defaultBaseUrl)
    || nonEmptyString(config.baseUrl)
    || nonEmptyString(config.base_url);
  const defaultApi = nonEmptyString(config.defaultApi)
    || nonEmptyString(config.api)
    || "openai-completions";

  return {
    id,
    displayName,
    authType: normalizeProviderAuthType(config.authType || config.auth_type),
    defaultBaseUrl,
    defaultApi,
    ...(models.length > 0 ? { models } : {}),
    ...(runtime ? { runtime } : {}),
    ...(capabilities ? { capabilities } : {}),
    ...(nonEmptyString(config.description) ? { description: nonEmptyString(config.description) } : {}),
    ...(nonEmptyString(config.docsUrl) ? { docsUrl: nonEmptyString(config.docsUrl) } : {}),
    ...(nonEmptyString(config.homepage) ? { homepage: nonEmptyString(config.homepage) } : {}),
    ...(nonEmptyString(config.icon) ? { icon: nonEmptyString(config.icon) } : {}),
  };
}

export function isLocalProviderPlugin(plugin: any) {
  return plugin?.source?.kind === LOCAL_PROVIDER_PLUGIN_SOURCE_KIND;
}

export function providerPluginToCatalogDefinition(plugin: any) {
  if (!plugin?.id) return {};
  return {
    display_name: plugin.displayName || plugin.id,
    auth_type: normalizeProviderAuthType(plugin.authType),
    base_url: plugin.defaultBaseUrl || "",
    api: plugin.defaultApi || "openai-completions",
    ...(Array.isArray(plugin.models) ? { models: cloneData(plugin.models) } : {}),
    ...(isPlainObject(plugin.runtime) ? { runtime: cloneData(plugin.runtime) } : {}),
    ...(isPlainObject(plugin.capabilities) ? { capabilities: cloneData(plugin.capabilities) } : {}),
  };
}

export function splitLocalProviderConfig(providerId: string, config: Record<string, any>, existingPlugin: any = null) {
  const raw = isPlainObject(config) ? cloneData(config) : {};
  const existingDefinition: Record<string, any> = existingPlugin ? providerPluginToCatalogDefinition(existingPlugin) : {};
  const definitionFields = pickProviderDefinitionFields(raw);
  if (hasOwn(definitionFields, "models")) {
    definitionFields.models = replaceProviderModelEntries(existingDefinition.models, definitionFields.models);
  }
  const plugin = normalizeLocalProviderPlugin(providerId, {
    ...existingDefinition,
    ...definitionFields,
  });
  const overlay: Record<string, any> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (PROVIDER_DEFINITION_KEYS.has(key)) continue;
    overlay[key] = value;
  }
  return { plugin, overlay };
}

export function providerConfigHasLocalDefinition(config: any) {
  if (!isPlainObject(config)) return false;
  return [...PROVIDER_DEFINITION_KEYS].some((key) => hasOwn(config, key));
}

export class LocalProviderPluginStore {
  declare _lucHome: string;

  constructor(lucHome: string) {
    if (!lucHome) throw new Error("LocalProviderPluginStore requires lucHome");
    this._lucHome = lucHome;
  }

  get rootDir() {
    return path.join(this._lucHome, LOCAL_PROVIDER_PLUGINS_DIR);
  }

  providerDir(providerId: string) {
    return path.join(this.rootDir, localProviderPluginStorageId(providerId));
  }

  manifestPath(providerId: string) {
    return path.join(this.providerDir(providerId), "manifest.json");
  }

  providerPath(providerId: string) {
    const storageId = localProviderPluginStorageId(providerId);
    return path.join(this.providerDir(providerId), "providers", `${storageId}.json`);
  }

  readAll() {
    if (!fs.existsSync(this.rootDir)) return [];
    const plugins = [];
    for (const dirent of fs.readdirSync(this.rootDir, { withFileTypes: true })) {
      if (!dirent.isDirectory() || !isSafeLocalProviderPluginProviderId(dirent.name)) continue;
      const storageId = dirent.name;
      const dir = path.join(this.rootDir, storageId);
      const manifestPath = path.join(dir, "manifest.json");
      const manifest = fs.existsSync(manifestPath)
        ? JSON.parse(fs.readFileSync(manifestPath, "utf-8"))
        : null;
      const providerId = assertSafeLocalProviderPluginProviderId(manifest?.provider || storageId);
      const providerPath = path.join(dir, "providers", `${storageId}.json`);
      if (!fs.existsSync(providerPath)) continue;
      const raw = JSON.parse(fs.readFileSync(providerPath, "utf-8"));
      const plugin = normalizeLocalProviderPlugin(providerId, { ...raw, id: providerId });
      plugins.push({
        ...plugin,
        source: { kind: LOCAL_PROVIDER_PLUGIN_SOURCE_KIND },
      });
    }
    return plugins;
  }

  writeProvider(providerId: string, config: Record<string, any>) {
    const id = assertSafeLocalProviderPluginProviderId(providerId);
    const storageId = assertSafeLocalProviderPluginStorageId(localProviderPluginStorageId(id));
    const plugin = normalizeLocalProviderPlugin(id, config);
    fs.mkdirSync(path.dirname(this.providerPath(id)), { recursive: true });
    writeSecretFileSync(this.manifestPath(id), JSON.stringify({
      id: storageId,
      type: "provider-plugin",
      schemaVersion: LOCAL_PROVIDER_PLUGIN_SCHEMA_VERSION,
      provider: id,
    }, null, 2) + "\n");
    writeSecretFileSync(this.providerPath(id), JSON.stringify(plugin, null, 2) + "\n");
    return {
      ...plugin,
      source: { kind: LOCAL_PROVIDER_PLUGIN_SOURCE_KIND },
    };
  }

  removeProvider(providerId: string) {
    if (!isSafeLocalProviderPluginProviderId(providerId)) return;
    fs.rmSync(this.providerDir(providerId), { recursive: true, force: true });
    const legacyDir = path.join(this.rootDir, providerId.trim());
    if (legacyDir !== this.providerDir(providerId) && isLegacyLocalProviderPluginPathSegment(providerId)) {
      fs.rmSync(legacyDir, { recursive: true, force: true });
    }
  }
}
