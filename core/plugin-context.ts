import path from "path";
import { serializeSessionFile } from "../lib/session-files/session-file-response.ts";
import { createPluginConfigStore } from "./plugin-config.ts";

type PluginWatchOptions = {
  purpose?: unknown;
  sessionPath?: unknown;
  sessionRef?: {
    sessionPath?: unknown;
    path?: unknown;
  } | null;
};

type PluginResourceWatchResult = {
  subscriptionId?: unknown;
  resourceKeys?: unknown;
};

/**
 * Create a PluginContext for a plugin.
 * @param {{ pluginId: string, pluginKey?: string, source?: string, pluginDir: string, dataDir: string, bus: object, accessLevel?: "full-access" | "restricted", permissions?: string[], capabilities?: string[] | null, sensitiveCapabilities?: string[] | null, network?: object | null, fetchImpl?: Function, registerSessionFile?: Function, emitResourceChanged?: Function, resourceIO?: object | Function, resourceWatch?: object | Function, configSchema?: object, logSink?: Function, runtimeContext?: object }} opts
 */
export function createPluginContext({ pluginId, pluginKey, source, pluginDir, dataDir, bus, accessLevel, permissions, capabilities, sensitiveCapabilities, network = null, fetchImpl = undefined, registerSessionFile: registerSessionFileImpl, emitResourceChanged, resourceIO = null, resourceWatch = null, configSchema, logSink, runtimeContext }) {
  const config = createPluginConfigStore({ dataDir, schema: configSchema });
  const runtimeScope: any = runtimeContext ? normalizeRuntimeScope(runtimeContext) : {};

  const resolvedAccess = accessLevel || "restricted";
  const grantedPermissions = normalizePermissions(permissions);
  const declaredCapabilities = normalizeCapabilityList(capabilities);
  const declaredSensitiveCapabilities = normalizeCapabilityList(sensitiveCapabilities);
  const pluginNetwork = createPluginNetwork({
    pluginId,
    network,
    capabilities: declaredCapabilities,
    sensitiveCapabilities: declaredSensitiveCapabilities,
    fetchImpl,
  });
  const createScopedPluginResources = (scope: any = {}) => createPluginResources({
    pluginId,
    resourceIO,
    resourceWatch,
    capabilities: declaredCapabilities,
    sensitiveCapabilities: declaredSensitiveCapabilities,
    runtimeScope: normalizeRuntimeScope(scope, runtimeScope),
  });
  const pluginResources = createScopedPluginResources();
  const prefix = `[plugin:${pluginId}]`;
  const recordLog = (level, args) => {
    if (typeof logSink !== "function") return;
    try {
      logSink({ pluginId, level, args, ts: new Date().toISOString() });
    } catch {
      // Logging must never break plugin execution.
    }
  };
  const log = {
    info: (...args) => { recordLog("info", args); console.log(prefix, ...args); },
    warn: (...args) => { recordLog("warn", args); console.warn(prefix, ...args); },
    error: (...args) => { recordLog("error", args); console.error(prefix, ...args); },
    debug: (...args) => { recordLog("debug", args); console.debug(prefix, ...args); },
  };
  const ownerContext = Object.freeze({
    kind: "plugin",
    pluginId,
    pluginKey: pluginKey || pluginId,
    source: source || "community",
    pluginDir,
    dataDir,
    generatedDir: path.join(dataDir, "generated"),
    config,
    log,
  });
  const pluginBus = createPluginBusProxy(bus, {
    ownerContext,
    grantedPermissions,
    allowHandle: resolvedAccess === "full-access",
  });

  function registerSessionFile(entry: any = {}) {
    if (typeof registerSessionFileImpl !== "function") {
      throw new Error("plugin session file registry unavailable");
    }
    const sessionId = textOrNull(entry.sessionId) || textOrNull(runtimeScope.sessionId);
    const sessionPath = textOrNull(entry.sessionPath) || textOrNull(runtimeScope.sessionPath);
    const sessionRef = normalizeSessionRef(entry.sessionRef, {
      ...(runtimeScope.sessionRef || {}),
      sessionId,
      sessionPath,
    }) || runtimeScope.sessionRef || null;
    const { filePath, label, origin = "plugin_output" } = entry;
    const storageKind = origin === "plugin_output" ? "plugin_data" : "external";
    if (!sessionId && !sessionPath) throw new Error("plugin registerSessionFile requires sessionId or sessionPath");
    if (!filePath || !path.isAbsolute(filePath)) {
      throw new Error("plugin registerSessionFile requires an absolute filePath");
    }
    return serializeSessionFile(registerSessionFileImpl({
      ...(sessionId ? { sessionId } : {}),
      sessionPath,
      ...(sessionRef ? { sessionRef } : {}),
      filePath,
      label,
      origin,
      storageKind,
    }), { runtimeContext: runtimeScope });
  }

  function toMediaItem(file) {
    return {
      type: "session_file",
      fileId: file.fileId || file.id,
      sessionId: file.sessionId || file.sessionRef?.sessionId,
      sessionPath: file.sessionPath,
      filePath: file.filePath,
      label: file.label || file.displayName || file.filename,
      ...(file.mime ? { mime: file.mime } : {}),
      ...(file.size !== undefined ? { size: file.size } : {}),
      ...(file.kind ? { kind: file.kind } : {}),
    };
  }

  function stageFile(entry: any = {}) {
    const { origin: _origin, storageKind: _storageKind, ...safeEntry } = entry;
    const file = registerSessionFile({ ...safeEntry, origin: "plugin_output" });
    return { file, mediaItem: toMediaItem(file) };
  }

  const appEvents = Object.freeze({
    emit(type, payload: any = {}) {
      const eventType = textOrNull(type);
      if (!eventType) return false;
      if (!isPlainObject(payload)) return false;
      pluginBus.emit({
        type: "app_event",
        event: {
          type: eventType,
          payload,
          source: `plugin:${pluginId}`,
        },
      }, null);
      return true;
    },
  });

  const resourceEvents = Object.freeze({
    changed(input: any = {}) {
      if (typeof emitResourceChanged !== "function") return false;
      emitResourceChanged(input);
      return true;
    },
  });

  const context = {
    ...runtimeScope,
    pluginId,
    pluginKey: pluginKey || pluginId,
    source: source || "community",
    pluginDir,
    dataDir,
    capabilities: declaredCapabilities,
    sensitiveCapabilities: declaredSensitiveCapabilities,
    bus: pluginBus,
    appEvents,
    resourceEvents,
    resources: pluginResources,
    network: pluginNetwork,
    config,
    log,
    registerSessionFile,
    stageFile,
  };
  Object.defineProperty(context, "__createInvocationResources", {
    value: createScopedPluginResources,
    enumerable: false,
  });
  return context;
}

function createPluginBusProxy(bus, { ownerContext, grantedPermissions, allowHandle }) {
  const fullAccess = allowHandle === true;
  const canReadUsage = fullAccess || hasPermission(grantedPermissions, "usage.read");
  const getCapability = typeof bus.getCapability === "function"
    ? bus.getCapability.bind(bus)
    : () => null;
  const assertUsagePermission = (type, action) => {
    const capability = getCapability(type);
    if (capability?.permission !== "usage.read") return;
    if (canReadUsage) return;
    throw forbiddenBusError(type, action, "usage.read");
  };

  const proxy: Record<string, any> = {
    emit(event, sessionPath) {
      if (!fullAccess && event?.type === "llm_usage") {
        throw forbiddenBusError("llm_usage", "emit", "usage.read");
      }
      return bus.emit(event, sessionPath);
    },
    subscribe(callback, filter = {}) {
      const requestedTypes = typesFromFilter(filter);
      if (!fullAccess && !canReadUsage && requestedTypes?.has("llm_usage")) {
        throw forbiddenBusError("llm_usage", "subscribe", "usage.read");
      }
      const wrapped = (event, sessionPath) => {
        if (!fullAccess && !canReadUsage && event?.type === "llm_usage") return;
        return callback(event, sessionPath);
      };
      return bus.subscribe(wrapped, filter);
    },
    async request(type, payload, options) {
      assertUsagePermission(type, "request");
      if (typeof bus.request !== "function") {
        throw new Error("plugin bus request unavailable");
      }
      return bus.request(type, payload, {
        ...(options || {}),
        caller: ownerContext,
      });
    },
    hasHandler: typeof bus.hasHandler === "function" ? bus.hasHandler.bind(bus) : () => false,
    listCapabilities: typeof bus.listCapabilities === "function" ? bus.listCapabilities.bind(bus) : () => [],
    getCapability,
  };

  if (allowHandle && typeof bus.handle === "function") {
    proxy.handle = bus.handle.bind(bus);
  }

  return Object.freeze(proxy);
}

function normalizePermissions(permissions) {
  if (!Array.isArray(permissions)) return new Set();
  return new Set(permissions.filter((permission) => typeof permission === "string" && permission.trim()).map((permission) => permission.trim()));
}

function normalizeCapabilityList(capabilities) {
  if (!Array.isArray(capabilities)) return [];
  return [...new Set(capabilities
    .filter((capability) => typeof capability === "string" && capability.trim())
    .map((capability) => capability.trim()))];
}

function hasPermission(grantedPermissions, permission) {
  if (grantedPermissions.has("*")) return true;
  if (grantedPermissions.has(permission)) return true;
  const [namespace] = permission.split(".");
  return grantedPermissions.has(`${namespace}.*`);
}

function typesFromFilter(filter) {
  const types = filter?.types;
  if (types instanceof Set) return types;
  if (Array.isArray(types)) return new Set(types);
  return null;
}

function forbiddenBusError(type, action, permission) {
  const err: any = new Error(`Plugin bus ${action} "${type}" requires permission "${permission}"`);
  err.code = "FORBIDDEN";
  err.type = type;
  err.permission = permission;
  return err;
}

function clonePlain(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function textOrNull(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeSessionRef(value, fallback: any = {}) {
  const sessionId = textOrNull(value?.sessionId) || textOrNull(fallback.sessionId);
  if (!sessionId) return null;
  const sessionPath = textOrNull(value?.sessionPath) || textOrNull(value?.path) || textOrNull(fallback.sessionPath);
  const legacySessionPath = textOrNull(value?.legacySessionPath) || textOrNull(fallback.legacySessionPath);
  return {
    sessionId,
    ...(sessionPath ? { sessionPath } : {}),
    ...(legacySessionPath ? { legacySessionPath } : {}),
  };
}

function normalizeRuntimeScope(value: any = {}, fallback: any = {}) {
  const sessionId = textOrNull(value?.sessionId)
    || textOrNull(value?.sessionRef?.sessionId)
    || textOrNull(fallback.sessionId);
  const sessionPath = textOrNull(value?.sessionPath)
    || textOrNull(value?.sessionRef?.sessionPath)
    || textOrNull(value?.sessionRef?.path)
    || textOrNull(fallback.sessionPath);
  const requestId = textOrNull(value?.requestId) || textOrNull(fallback.requestId);
  const sessionRef = normalizeSessionRef(value?.sessionRef, {
    ...(fallback.sessionRef || {}),
    sessionId,
    sessionPath,
  }) || fallback.sessionRef || null;
  return {
    serverId: value?.serverId ?? fallback.serverId,
    serverNodeId: value?.serverNodeId ?? value?.serverId ?? fallback.serverNodeId ?? fallback.serverId,
    userId: value?.userId ?? fallback.userId,
    studioId: value?.studioId ?? fallback.studioId,
    connectionKind: value?.connectionKind ?? fallback.connectionKind,
    credentialKind: value?.credentialKind ?? fallback.credentialKind,
    platformAccountId: value?.platformAccountId ?? fallback.platformAccountId ?? null,
    officialServiceKind: value?.officialServiceKind ?? fallback.officialServiceKind ?? null,
    executionBoundary: clonePlain(value?.executionBoundary ?? fallback.executionBoundary),
    sessionId: sessionId || null,
    sessionPath: sessionPath || null,
    requestId: requestId || null,
    sessionRef,
  };
}

function createPluginResources({ pluginId, resourceIO, resourceWatch, capabilities, sensitiveCapabilities, runtimeScope }) {
  const getResourceIO = () => {
    const resolved = typeof resourceIO === "function" ? resourceIO() : resourceIO;
    if (resolved && typeof resolved === "object") return resolved;
    throw pluginResourceError(
      "PLUGIN_RESOURCE_IO_UNAVAILABLE",
      "Plugin ResourceIO is unavailable in this runtime",
      { pluginId },
    );
  };
  const getResourceWatch = () => {
    const resolved = typeof resourceWatch === "function" ? resourceWatch() : resourceWatch;
    if (
      resolved
      && typeof resolved === "object"
      && typeof resolved.subscribe === "function"
      && typeof resolved.unsubscribe === "function"
    ) {
      return resolved;
    }
    throw pluginResourceError(
      "PLUGIN_RESOURCE_WATCH_UNAVAILABLE",
      "Plugin ResourceIO watch subscription is unavailable in this runtime",
      { pluginId },
    );
  };
  const assertCapability = (capability) => {
    if (
      hasCapabilityDeclaration(capabilities, capability)
      || hasCapabilityDeclaration(sensitiveCapabilities, capability)
    ) {
      return;
    }
    throw pluginResourceError(
      "PLUGIN_RESOURCE_CAPABILITY_NOT_DECLARED",
      `Plugin ResourceIO operation requires manifest capability "${capability}"`,
      { pluginId, capability },
    );
  };
  const operationOptions = (operation, options: any = {}) => {
    const sessionId = textOrNull(runtimeScope?.sessionId) || null;
    const sessionPath = textOrNull(runtimeScope?.sessionPath) || null;
    const requestId = textOrNull(runtimeScope?.requestId) || null;
    return {
      ...(options?.emit === false ? { emit: false } : {}),
      ...(options?.auditRead === true ? { auditRead: true } : {}),
      source: "plugin",
      reason: `plugin:${pluginId}:${operation}`,
      sessionId,
      sessionPath,
      requestId,
      principal: {
        kind: "plugin",
        pluginId,
        userId: textOrNull(runtimeScope?.userId) || null,
        studioId: textOrNull(runtimeScope?.studioId) || null,
        sessionId,
        sessionPath,
        connectionKind: textOrNull(runtimeScope?.connectionKind) || null,
        credentialKind: textOrNull(runtimeScope?.credentialKind) || null,
        requestId,
      },
    };
  };
  const watchOptions = (operation, options: PluginWatchOptions = {}) => ({
    purpose: textOrNull(options?.purpose) || `plugin:${pluginId}:${operation}`,
    sessionPath: textOrNull(options?.sessionPath)
      || textOrNull(options?.sessionRef?.sessionPath)
      || textOrNull(options?.sessionRef?.path)
      || textOrNull(runtimeScope?.sessionPath)
      || null,
  });

  return Object.freeze({
    async stat(ref, options: any = {}) {
      assertCapability("resource.read");
      return getResourceIO().stat(ref, operationOptions("stat", options));
    },
    async read(ref, options: any = {}) {
      assertCapability("resource.read");
      return getResourceIO().read(ref, operationOptions("read", options));
    },
    async list(ref, options: any = {}) {
      assertCapability("resource.read");
      return getResourceIO().list(ref, operationOptions("list", options));
    },
    async search(ref, options: any = {}, operationContext: any = {}) {
      assertCapability("resource.search");
      return getResourceIO().search(ref, options, operationOptions("search", operationContext));
    },
    async materialize(ref, options: any = {}) {
      assertCapability("resource.materialize");
      return getResourceIO().materialize(ref, operationOptions("materialize", options));
    },
    async write(ref, content, options: any = {}) {
      assertCapability("resource.write");
      return getResourceIO().write(ref, content, operationOptions("write", options));
    },
    async writeExpectedVersion(ref, content, expectedVersion, options: any = {}) {
      assertCapability("resource.write");
      return getResourceIO().writeExpectedVersion(ref, content, expectedVersion, operationOptions("writeExpectedVersion", options));
    },
    async edit(ref, edits, options: any = {}) {
      assertCapability("resource.write");
      return getResourceIO().edit(ref, edits, operationOptions("edit", options));
    },
    async mkdir(ref, options: any = {}) {
      assertCapability("resource.write");
      return getResourceIO().mkdir(ref, operationOptions("mkdir", options));
    },
    async delete(ref, options: any = {}) {
      assertCapability("resource.write");
      return getResourceIO().delete(ref, operationOptions("delete", options));
    },
    async copy(from, to, options: any = {}) {
      assertCapability("resource.write");
      return getResourceIO().copy(from, to, operationOptions("copy", options));
    },
    async rename(from, to, options: any = {}) {
      assertCapability("resource.write");
      return getResourceIO().rename(from, to, operationOptions("rename", options));
    },
    async move(from, to, options: any = {}) {
      assertCapability("resource.write");
      return getResourceIO().move(from, to, operationOptions("move", options));
    },
    async trash(ref, trashOptions: any = {}, options: any = {}) {
      assertCapability("resource.write");
      return getResourceIO().trash(ref, trashOptions, operationOptions("trash", options));
    },
    watch(ref, options: PluginWatchOptions = {}) {
      assertCapability("resource.watch");
      const watcher = getResourceWatch();
      const result = watcher.subscribe({
        resource: ref,
        ...watchOptions("watch", options),
      });
      return createPluginResourceWatchHandle(pluginId, watcher, result);
    },
    subscribe(resources, options: PluginWatchOptions = {}) {
      assertCapability("resource.watch");
      const watcher = getResourceWatch();
      const result = watcher.subscribe({
        resources: normalizeWatchResources(pluginId, resources),
        ...watchOptions("subscribe", options),
      });
      return createPluginResourceWatchHandle(pluginId, watcher, result);
    },
    resolveWatchTarget(ref, options: any = {}) {
      assertCapability("resource.watch");
      const io = getResourceIO();
      if (typeof io.resolveWatchTarget !== "function") {
        throw pluginResourceError(
          "PLUGIN_RESOURCE_WATCH_UNAVAILABLE",
          "Plugin ResourceIO watch target resolution is unavailable in this runtime",
          { pluginId },
        );
      }
      return io.resolveWatchTarget(ref, operationOptions("watch", options));
    },
  });
}

function normalizeWatchResources(pluginId, resources) {
  if (!Array.isArray(resources) || resources.length === 0) {
    throw pluginResourceError(
      "PLUGIN_RESOURCE_WATCH_INVALID_RESOURCES",
      "Plugin ResourceIO subscribe requires a non-empty resources array",
      { pluginId },
    );
  }
  return resources;
}

function createPluginResourceWatchHandle(pluginId, watcher, result: PluginResourceWatchResult = {}) {
  const subscriptionId = textOrNull(result?.subscriptionId);
  if (!subscriptionId) {
    throw pluginResourceError(
      "PLUGIN_RESOURCE_WATCH_INVALID_SUBSCRIPTION",
      "Plugin ResourceIO watch subscription did not return a subscriptionId",
      { pluginId },
    );
  }
  const resourceKeys = Array.isArray(result.resourceKeys)
    ? result.resourceKeys.filter((key) => typeof key === "string" && key)
    : [];
  let closed = false;
  const unsubscribe = () => {
    if (closed) return false;
    const released = watcher.unsubscribe(subscriptionId);
    closed = true;
    return released !== false;
  };
  return Object.freeze({
    subscriptionId,
    resourceKeys,
    unsubscribe,
    close: unsubscribe,
  });
}

function pluginResourceError(code, message, extra: any = {}) {
  const err: any = new Error(message);
  err.code = code;
  Object.assign(err, extra);
  return err;
}

const DEFAULT_NETWORK_TIMEOUT_MS = 15_000;
const DEFAULT_NETWORK_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

function createPluginNetwork({ pluginId, network, capabilities, sensitiveCapabilities, fetchImpl }) {
  const policy = normalizeNetworkPolicy(network);
  const cache = new Map();

  return Object.freeze({
    async fetch(input, init: any = {}) {
      const fetchFn = typeof fetchImpl === "function"
        ? fetchImpl
        : typeof globalThis.fetch === "function"
          ? globalThis.fetch.bind(globalThis)
          : null;
      if (!fetchFn) {
        throw pluginNetworkError(
          "PLUGIN_NETWORK_FETCH_UNAVAILABLE",
          "Plugin network fetch is unavailable in this runtime",
          { pluginId },
        );
      }

      assertNetworkCapability(pluginId, capabilities, sensitiveCapabilities);
      const url = parseNetworkUrl(pluginId, input);
      const method = normalizeHttpMethod(init?.method || requestMethodFromInput(input) || "GET");
      validateNetworkTarget(pluginId, url, method, policy);

      const requestInit = buildNetworkRequestInit(input, init, method);
      const timeoutMs = normalizePositiveInteger(init?.timeoutMs ?? policy.defaultTimeoutMs, DEFAULT_NETWORK_TIMEOUT_MS);
      const maxResponseBytes = normalizePositiveInteger(init?.maxResponseBytes ?? policy.maxResponseBytes, DEFAULT_NETWORK_MAX_RESPONSE_BYTES);
      const cacheTtlMs = normalizeCacheTtl(init?.cacheTtlMs);
      const cacheKey = method === "GET" && cacheTtlMs > 0 ? `${method} ${url.href}` : null;

      if (cacheKey) {
        const hit = cache.get(cacheKey);
        if (hit && hit.expiresAt > Date.now()) {
          return responseFromSnapshot(hit.response);
        }
        cache.delete(cacheKey);
      }

      const { init: timedInit, cleanup } = attachTimeoutSignal(requestInit, timeoutMs);
      try {
        const response = await fetchFn(url.href, timedInit);
        const snapshot = await snapshotNetworkResponse(pluginId, response, maxResponseBytes);
        if (cacheKey && response.ok) {
          cache.set(cacheKey, {
            expiresAt: Date.now() + cacheTtlMs,
            response: snapshot,
          });
        }
        return responseFromSnapshot(snapshot);
      } finally {
        cleanup();
      }
    },
  });
}

function normalizeNetworkPolicy(network) {
  const source = network && typeof network === "object" ? network : {};
  return {
    allowedHosts: normalizeAllowedHosts((source as any).allowedHosts || (source as any).hosts),
    methods: normalizeHttpMethods((source as any).methods),
    allowLocalhost: (source as any).allowLocalhost === true,
    defaultTimeoutMs: normalizePositiveInteger((source as any).defaultTimeoutMs, DEFAULT_NETWORK_TIMEOUT_MS),
    maxResponseBytes: normalizePositiveInteger((source as any).maxResponseBytes, DEFAULT_NETWORK_MAX_RESPONSE_BYTES),
  };
}

function normalizeAllowedHosts(hosts) {
  if (!Array.isArray(hosts)) return [];
  return [...new Set(hosts
    .filter((host) => typeof host === "string" && host.trim())
    .map((host) => normalizeHostPattern(host.trim()))
    .filter(Boolean))];
}

function normalizeHostPattern(pattern) {
  const value = String(pattern || "").trim().toLowerCase();
  if (!value) return "";
  if (value.startsWith("http://") || value.startsWith("https://")) {
    try {
      return new URL(value).hostname.toLowerCase();
    } catch {
      return "";
    }
  }
  return value;
}

function normalizeHttpMethods(methods) {
  if (!Array.isArray(methods) || methods.length === 0) return new Set(["GET"]);
  const normalized = methods
    .filter((method) => typeof method === "string" && method.trim())
    .map((method) => normalizeHttpMethod(method));
  return new Set(normalized.length ? normalized : ["GET"]);
}

function normalizeHttpMethod(method) {
  return String(method || "GET").trim().toUpperCase();
}

function normalizePositiveInteger(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return Math.floor(numeric);
}

function normalizeCacheTtl(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return Math.floor(numeric);
}

function assertNetworkCapability(pluginId, capabilities, sensitiveCapabilities) {
  if (
    hasCapabilityDeclaration(capabilities, "network.fetch")
    || hasCapabilityDeclaration(sensitiveCapabilities, "network.fetch")
  ) {
    return;
  }
  throw pluginNetworkError(
    "PLUGIN_NETWORK_CAPABILITY_NOT_DECLARED",
    'Plugin network.fetch requires manifest capability "network.fetch"',
    { pluginId, capability: "network.fetch" },
  );
}

function hasCapabilityDeclaration(capabilities, capability) {
  if (!Array.isArray(capabilities)) return false;
  if (capabilities.includes("*") || capabilities.includes(capability)) return true;
  return capabilities.some((declared) => capability.startsWith(`${declared}.`));
}

function parseNetworkUrl(pluginId, input) {
  const rawUrl = typeof input === "string" || input instanceof URL
    ? String(input)
    : input?.url;
  try {
    return new URL(rawUrl);
  } catch {
    throw pluginNetworkError(
      "PLUGIN_NETWORK_URL_INVALID",
      "Plugin network.fetch requires an absolute HTTP(S) URL",
      { pluginId },
    );
  }
}

function requestMethodFromInput(input) {
  if (input && typeof input === "object" && typeof input.method === "string") {
    return input.method;
  }
  return null;
}

function buildNetworkRequestInit(input, init, method) {
  const requestLike = input && typeof input === "object" && !(input instanceof URL) ? input : null;
  const safeInit = { ...(init || {}) };
  delete safeInit.cacheTtlMs;
  delete safeInit.maxResponseBytes;
  delete safeInit.timeoutMs;
  return {
    ...(requestLike?.headers && !safeInit.headers ? { headers: requestLike.headers } : {}),
    ...(requestLike?.body && !safeInit.body && method !== "GET" && method !== "HEAD" ? { body: requestLike.body } : {}),
    ...safeInit,
    method,
  };
}

function validateNetworkTarget(pluginId, url, method, policy) {
  const host = url.hostname.toLowerCase();
  const isHttpUrl = url.protocol === "http:" || url.protocol === "https:";
  if (isHttpUrl && isPrivateNetworkHost(host) && !policy.allowLocalhost) {
    throw pluginNetworkError(
      "PLUGIN_NETWORK_PRIVATE_HOST_FORBIDDEN",
      "Plugin network.fetch blocks localhost and private network targets unless allowLocalhost is declared",
      { pluginId, host },
    );
  }

  if (url.protocol !== "https:" && !(url.protocol === "http:" && policy.allowLocalhost)) {
    throw pluginNetworkError(
      "PLUGIN_NETWORK_SCHEME_NOT_ALLOWED",
      "Plugin network.fetch only allows HTTPS by default; HTTP is limited to explicitly declared localhost targets",
      { pluginId, scheme: url.protocol.replace(":", "") },
    );
  }

  if (!isAllowedNetworkHost(host, policy.allowedHosts)) {
    throw pluginNetworkError(
      "PLUGIN_NETWORK_HOST_NOT_ALLOWED",
      `Plugin network.fetch host "${host}" is not declared in manifest network.allowedHosts`,
      { pluginId, host, allowedHosts: policy.allowedHosts },
    );
  }

  if (!policy.methods.has(method)) {
    throw pluginNetworkError(
      "PLUGIN_NETWORK_METHOD_NOT_ALLOWED",
      `Plugin network.fetch method "${method}" is not declared in manifest network.methods`,
      { pluginId, method, allowedMethods: [...policy.methods] },
    );
  }
}

function isAllowedNetworkHost(host, allowedHosts) {
  return allowedHosts.some((pattern) => {
    if (pattern.startsWith("*.")) {
      const suffix = pattern.slice(1);
      return host.endsWith(suffix) && host.length > suffix.length;
    }
    return host === pattern;
  });
}

function isPrivateNetworkHost(host) {
  if (!host) return true;
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "::" || host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
  if (host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:")) return true;

  const octets = host.split(".").map((part) => Number(part));
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }

  const [a, b] = octets;
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168);
}

function attachTimeoutSignal(init, timeoutMs) {
  if (typeof AbortController === "undefined" || !timeoutMs) {
    return { init, cleanup: () => {} };
  }

  const controller = new AbortController();
  const existingSignal = init.signal;
  const abortFromExisting = () => {
    try {
      controller.abort(existingSignal?.reason);
    } catch {
      controller.abort();
    }
  };

  if (existingSignal?.aborted) {
    abortFromExisting();
  } else if (existingSignal?.addEventListener) {
    existingSignal.addEventListener("abort", abortFromExisting, { once: true });
  }

  const timer = setTimeout(() => {
    controller.abort(new Error(`Plugin network.fetch timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  timer.unref?.();

  return {
    init: { ...init, signal: controller.signal },
    cleanup: () => {
      clearTimeout(timer);
      existingSignal?.removeEventListener?.("abort", abortFromExisting);
    },
  };
}

async function snapshotNetworkResponse(pluginId, response, maxResponseBytes) {
  const body = await response.arrayBuffer();
  if (body.byteLength > maxResponseBytes) {
    throw pluginNetworkError(
      "PLUGIN_NETWORK_RESPONSE_TOO_LARGE",
      `Plugin network.fetch response exceeded ${maxResponseBytes} bytes`,
      { pluginId, maxResponseBytes, responseBytes: body.byteLength },
    );
  }
  return {
    body,
    status: response.status,
    statusText: response.statusText,
    headers: Array.from(response.headers.entries()),
  };
}

function responseFromSnapshot(snapshot) {
  return new Response(snapshot.body.slice(0), {
    status: snapshot.status,
    statusText: snapshot.statusText,
    headers: snapshot.headers,
  });
}

function pluginNetworkError(code, message, details = {}) {
  const err: any = new Error(message);
  err.code = code;
  Object.assign(err, details);
  return err;
}
