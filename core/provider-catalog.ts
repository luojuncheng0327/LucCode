import fs from "fs";
import path from "path";
import YAML from "js-yaml";
import { safeReadYAMLSync } from "../shared/safe-fs.ts";
import {
  SECRET_DIR_MODE,
  ensureSecretDirModeSync,
  ensureSecretFileModeSync,
  writeSecretFileSync,
} from "../shared/secret-fs.ts";
import { SEARCH_CAPABILITY_KIND, SEARCH_CAPABILITY_PROVIDERS } from "../shared/search-providers.ts";
import { migrationBackupsRoot } from "./migration-backups.ts";

export const PROVIDER_CATALOG_VERSION = 2;
export const PROVIDER_CATALOG_FILE = "provider-catalog.json";
export const LEGACY_ADDED_MODELS_FILE = "added-models.yaml";

const DELETED_PROVIDERS_KEY = "_deleted_providers";
const DEFAULT_CAPABILITIES = Object.freeze({
  [SEARCH_CAPABILITY_KIND]: Object.freeze({ providers: SEARCH_CAPABILITY_PROVIDERS }),
});

function isPlainObject(value: any): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function cloneData<T>(value: T): T {
  return structuredClone(value);
}

function readJsonTextWithoutBom(filePath: string) {
  const raw = fs.readFileSync(filePath, "utf-8");
  return raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw;
}

function normalizeDeletedProviders(value: any): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(
    value
      .filter((id) => typeof id === "string" && id.trim())
      .map((id) => id.trim()),
  )];
}

function normalizeProviderMap(value: any): Record<string, any> {
  if (!isPlainObject(value)) return {};
  const providers: Record<string, any> = {};
  for (const [providerId, config] of Object.entries(value)) {
    const id = typeof providerId === "string" ? providerId.trim() : "";
    if (!id) continue;
    providers[id] = isPlainObject(config) ? cloneData(config) : { _config_error: "malformed_provider_config" };
  }
  return providers;
}

function mergeProviderMaps(base: any, overlay: any): Record<string, any> {
  const baseProviders = normalizeProviderMap(base);
  const overlayProviders = normalizeProviderMap(overlay);
  const merged: Record<string, any> = {};
  for (const providerId of new Set([...Object.keys(baseProviders), ...Object.keys(overlayProviders)])) {
    merged[providerId] = {
      ...(baseProviders[providerId] || {}),
      ...(overlayProviders[providerId] || {}),
    };
  }
  return merged;
}

function normalizeCapabilities(value: any): Record<string, any> {
  const raw = isPlainObject(value) ? value : {};
  const capabilities: Record<string, any> = {};
  for (const [capability, config] of Object.entries(DEFAULT_CAPABILITIES)) {
    capabilities[capability] = cloneData(config);
  }
  for (const [capability, config] of Object.entries(raw)) {
    if (typeof capability !== "string" || !capability.trim()) continue;
    if (!isPlainObject(config)) continue;
    capabilities[capability.trim()] = cloneData(config);
  }
  return capabilities;
}

export function normalizeProviderCatalog(value: any = {}) {
  const meta = isPlainObject(value.meta) ? cloneData(value.meta) : {};
  const deletedProviders = normalizeDeletedProviders(meta.deletedProviders);
  return {
    catalogVersion: PROVIDER_CATALOG_VERSION,
    providers: normalizeProviderMap(value.providers),
    capabilities: normalizeCapabilities(value.capabilities),
    meta: {
      ...meta,
      ...(deletedProviders.length > 0 ? { deletedProviders } : {}),
    },
  };
}

function timestampSlug(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

export class ProviderCatalogStore {
  declare _lucHome: string;

  constructor(lucHome: string) {
    if (!lucHome) throw new Error("ProviderCatalogStore requires lucHome");
    this._lucHome = lucHome;
  }

  get catalogPath() {
    return path.join(this._lucHome, PROVIDER_CATALOG_FILE);
  }

  get legacyAddedModelsPath() {
    return path.join(this._lucHome, LEGACY_ADDED_MODELS_FILE);
  }

  load() {
    const existing = this._readExistingCatalog();
    if (existing) return existing;
    return this._migrateLegacyCatalog();
  }

  cutoverFromLegacy() {
    const existing = this._readExistingCatalog();
    const legacyExists = fs.existsSync(this.legacyAddedModelsPath);
    if (!legacyExists) {
      const current = existing || this._migrateLegacyCatalog();
      return this.save({
        ...current,
        meta: {
          ...(current.meta || {}),
          providerCatalogCutoverAt: new Date().toISOString(),
        },
      });
    }

    const legacy = safeReadYAMLSync(this.legacyAddedModelsPath, {}, YAML) || {};
    const now = new Date().toISOString();
    const legacyDeletedProviders = normalizeDeletedProviders(legacy[DELETED_PROVIDERS_KEY]);
    const existingDeletedProviders = normalizeDeletedProviders(existing?.meta?.deletedProviders);
    const catalog = normalizeProviderCatalog({
      providers: mergeProviderMaps(existing?.providers, legacy.providers),
      capabilities: existing?.capabilities || DEFAULT_CAPABILITIES,
      meta: {
        ...(existing?.meta || {}),
        migratedAt: existing?.meta?.migratedAt || now,
        providerCatalogCutoverAt: now,
        migrationSource: LEGACY_ADDED_MODELS_FILE,
        deletedProviders: legacyDeletedProviders.length > 0 ? legacyDeletedProviders : existingDeletedProviders,
      },
    });
    this._writeMigrationBackup(catalog);
    return this.save(catalog);
  }

  save(catalog: any) {
    const normalized = normalizeProviderCatalog(catalog);
    writeSecretFileSync(this.catalogPath, JSON.stringify(normalized, null, 2) + "\n");
    return normalized;
  }

  getProviders() {
    return cloneData(this.load().providers);
  }

  saveProviders(providers: Record<string, any>, meta: any = {}) {
    const current = this.load();
    const nextMeta = {
      ...(current.meta || {}),
      ...meta,
    };
    if (Array.isArray(meta.deletedProviders)) {
      nextMeta.deletedProviders = normalizeDeletedProviders(meta.deletedProviders);
    }
    return this.save({
      ...current,
      providers,
      meta: nextMeta,
    });
  }

  getDeletedProviders() {
    return normalizeDeletedProviders(this.load().meta?.deletedProviders);
  }

  _readExistingCatalog() {
    let parsed: any = null;
    try {
      parsed = JSON.parse(readJsonTextWithoutBom(this.catalogPath));
    } catch (err: any) {
      if (err?.code === "ENOENT") return null;
      throw err;
    }
    if (parsed?.catalogVersion !== PROVIDER_CATALOG_VERSION) {
      throw new Error(`Unsupported provider catalog version: ${parsed?.catalogVersion ?? "missing"}`);
    }
    return normalizeProviderCatalog(parsed);
  }

  _migrateLegacyCatalog() {
    const legacy = safeReadYAMLSync(this.legacyAddedModelsPath, {}, YAML) || {};
    const providers = normalizeProviderMap(legacy.providers);
    const catalog = normalizeProviderCatalog({
      providers,
      meta: {
        migratedAt: new Date().toISOString(),
        migrationSource: LEGACY_ADDED_MODELS_FILE,
        deletedProviders: normalizeDeletedProviders(legacy[DELETED_PROVIDERS_KEY]),
      },
    });
    this._writeMigrationBackup(catalog);
    return this.save(catalog);
  }

  _writeMigrationBackup(catalog: any) {
    const files = [
      this.legacyAddedModelsPath,
      path.join(this._lucHome, "models.json"),
    ];
    const existingFiles = files.filter((filePath) => fs.existsSync(filePath));
    if (existingFiles.length === 0) return;

    const backupDir = path.join(
      migrationBackupsRoot(this._lucHome),
      `provider-catalog-v1-${timestampSlug()}`,
    );
    fs.mkdirSync(backupDir, { recursive: true, mode: SECRET_DIR_MODE });
    // recursive 创建不会重设已存在目录的权限，显式收紧一次
    ensureSecretDirModeSync(backupDir);

    const copiedFiles = [];
    for (const filePath of existingFiles) {
      const filename = path.basename(filePath);
      const backupPath = path.join(backupDir, filename);
      // 逐字节复制，不做解码再编码：备份必须与源文件完全一致。
      // 复制后立即收紧权限；这中间的瞬时窗口不构成暴露，因为备份目录本身
      // 已经只对当前用户开放。
      fs.copyFileSync(filePath, backupPath);
      ensureSecretFileModeSync(backupPath);
      copiedFiles.push(filename);
    }

    const report = {
      sourceVersion: 1,
      targetVersion: PROVIDER_CATALOG_VERSION,
      migratedAt: catalog.meta?.migratedAt || new Date().toISOString(),
      providers: Object.keys(catalog.providers).sort(),
      copiedFiles,
    };
    writeSecretFileSync(path.join(backupDir, "migration-report.json"), JSON.stringify(report, null, 2) + "\n");
  }
}
