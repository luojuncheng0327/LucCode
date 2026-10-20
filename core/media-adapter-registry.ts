import path from "node:path";

/**
 * Generic registry for provider-side media adapters.
 *
 * Provider declarations say a model exists; adapter registration says this
 * runtime can execute the model protocol.
 */

export class MediaAdapterRegistry {
  declare _adapters: Map<string, any>;
  declare _adapterRecords: Map<string, any>;
  declare _protocolAdapters: Map<string, any>;
  declare _adapterKeys: Map<string, any>;

  constructor() {
    this._adapters = new Map();
    this._adapterRecords = new Map();
    this._protocolAdapters = new Map();
    this._adapterKeys = new Map();
  }

  register(adapter: any, options: any = {}) {
    if (!adapter?.id) throw new Error("media adapter requires id");
    const record = {
      adapter,
      owner: normalizeAdapterOwner(options.owner),
    };
    this._adapters.set(adapter.id, adapter);
    this._adapterRecords.set(adapter.id, record);
    const aliases = Array.isArray(adapter.aliases) ? adapter.aliases.filter(Boolean) : [];
    const protocolIds = [
      ...(adapter.protocolId ? [adapter.protocolId] : []),
      ...(Array.isArray(adapter.protocolIds) ? adapter.protocolIds : []),
    ].filter(Boolean);
    for (const alias of aliases) this._adapters.set(alias, adapter);
    for (const protocolId of protocolIds) this._protocolAdapters.set(protocolId, adapter);
    this._adapterKeys.set(adapter.id, { aliases, protocolIds });
  }

  unregister(adapterId: any) {
    const adapter = this._adapters.get(adapterId);
    const canonicalId = adapter?.id || adapterId;
    const keys = this._adapterKeys.get(canonicalId);
    this._adapters.delete(canonicalId);
    this._adapterRecords.delete(canonicalId);
    for (const alias of keys?.aliases || []) this._adapters.delete(alias);
    for (const protocolId of keys?.protocolIds || []) this._protocolAdapters.delete(protocolId);
    this._adapterKeys.delete(canonicalId);
  }

  get(adapterId: any) {
    return this._adapters.get(adapterId) || null;
  }

  getProtocol(protocolId: any) {
    return this._protocolAdapters.get(protocolId) || null;
  }

  getRecord(adapterOrId: any) {
    const adapterId = typeof adapterOrId === "string" ? adapterOrId : adapterOrId?.id;
    if (!adapterId) return null;
    const adapter = this._adapters.get(adapterId) || null;
    const canonicalId = adapter?.id || adapterId;
    return this._adapterRecords.get(canonicalId) || null;
  }

  createSubmitContextForAdapter(adapterOrId: any, baseContext: any = {}) {
    const owner = this.getRecord(adapterOrId)?.owner || null;
    if (!owner) return baseContext;
    return {
      ...baseContext,
      pluginId: owner.pluginId || baseContext.pluginId,
      pluginKey: owner.pluginKey || baseContext.pluginKey,
      pluginSource: owner.source || baseContext.pluginSource,
      pluginDir: owner.pluginDir || baseContext.pluginDir,
      dataDir: owner.dataDir || baseContext.dataDir,
      generatedDir: owner.generatedDir || (owner.dataDir ? path.join(owner.dataDir, "generated") : baseContext.generatedDir),
      config: owner.config || baseContext.config,
      videoConfig: owner.videoConfig || baseContext.videoConfig,
      log: owner.log || baseContext.log,
      owner,
    };
  }

  getByType(type: any) {
    const result = [];
    const seen = new Set();
    for (const adapter of this._adapters.values()) {
      if (!Array.isArray(adapter.types) || !adapter.types.includes(type) || seen.has(adapter.id)) continue;
      seen.add(adapter.id);
      result.push(adapter);
    }
    return result;
  }

  getDefault(type: any) {
    for (const adapter of this._adapters.values()) {
      if (Array.isArray(adapter.types) && adapter.types.includes(type)) return adapter;
    }
    return null;
  }

  list() {
    const seen = new Set();
    const result = [];
    for (const adapter of this._adapters.values()) {
      if (seen.has(adapter.id)) continue;
      seen.add(adapter.id);
      result.push(adapter);
    }
    return result;
  }
}

function normalizeAdapterOwner(owner: any) {
  if (!owner || typeof owner !== "object" || Array.isArray(owner)) return null;
  const pluginId = textOrNull(owner.pluginId);
  const pluginKey = textOrNull(owner.pluginKey) || pluginId;
  if (!pluginId && !pluginKey) return null;
  return {
    kind: owner.kind === "plugin" ? "plugin" : "plugin",
    pluginId,
    pluginKey,
    source: textOrNull(owner.source),
    pluginDir: textOrNull(owner.pluginDir),
    dataDir: textOrNull(owner.dataDir),
    generatedDir: textOrNull(owner.generatedDir),
    config: owner.config || null,
    videoConfig: owner.videoConfig || null,
    log: owner.log || null,
  };
}

function textOrNull(value: any) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
