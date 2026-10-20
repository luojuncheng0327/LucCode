// shared/network-proxy.cjs

const NETWORK_PROXY_MODES = ["system", "manual", "direct"];
const DEFAULT_NO_PROXY = "localhost, 127.0.0.1, ::1";
// Only loopback endpoints are forced direct. Future remote Luc servers need a
// separate frontend-to-server connection policy, not this backend outbound list.
const FORCED_LOCAL_PROXY_BYPASS = Object.freeze(["localhost", "127.0.0.1", "::1"]);

const DEFAULT_NETWORK_PROXY_CONFIG = Object.freeze({
  mode: "system",
  httpProxy: "",
  httpsProxy: "",
  wsProxy: "",
  wssProxy: "",
  noProxy: DEFAULT_NO_PROXY,
});

const ALLOWED_PROXY_PROTOCOLS = new Set(["http:", "https:", "socks:", "socks5:"]);

function hasOwn(obj, key) {
  return !!obj && typeof obj === "object" && Object.prototype.hasOwnProperty.call(obj, key);
}

function normalizeMode(value, strict) {
  if (NETWORK_PROXY_MODES.includes(value)) return value;
  if (strict && value !== undefined) {
    throw new Error("network proxy mode must be system, manual, or direct");
  }
  return DEFAULT_NETWORK_PROXY_CONFIG.mode;
}

function normalizeProxyUrl(value, field, strict) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    if (strict) throw new Error(`${field} must be a valid proxy URL`);
    return "";
  }

  if (!ALLOWED_PROXY_PROTOCOLS.has(parsed.protocol)) {
    if (strict) throw new Error(`${field} must use http, https, socks, or socks5`);
    return "";
  }
  if (!parsed.hostname) {
    if (strict) throw new Error(`${field} must include a host`);
    return "";
  }
  if (parsed.pathname && parsed.pathname !== "/") {
    if (strict) throw new Error(`${field} must not include a path`);
    parsed.pathname = "/";
  }
  parsed.search = "";
  parsed.hash = "";
  return parsed.href.replace(/\/$/, "");
}

function normalizeNoProxy(value) {
  if (Array.isArray(value)) {
    return value.map(v => String(v || "").trim()).filter(Boolean).join(", ");
  }
  return String(value ?? DEFAULT_NO_PROXY)
    .split(/[\s,]+/)
    .map(v => v.trim())
    .filter(Boolean)
    .join(", ");
}

function normalizeNetworkProxyConfig(value, options = {}) {
  const strict = options.strict === true;
  const input = value && typeof value === "object" ? value : {};
  const mode = normalizeMode(input.mode, strict);
  const noProxy = hasOwn(input, "noProxy") ? normalizeNoProxy(input.noProxy) : DEFAULT_NO_PROXY;

  if (mode !== "manual") {
    return {
      ...DEFAULT_NETWORK_PROXY_CONFIG,
      mode,
      noProxy,
    };
  }

  const normalized = {
    ...DEFAULT_NETWORK_PROXY_CONFIG,
    mode,
    httpProxy: normalizeProxyUrl(input.httpProxy, "httpProxy", strict),
    httpsProxy: normalizeProxyUrl(input.httpsProxy, "httpsProxy", strict),
    wsProxy: normalizeProxyUrl(input.wsProxy, "wsProxy", strict),
    wssProxy: normalizeProxyUrl(input.wssProxy, "wssProxy", strict),
    noProxy,
  };

  const hasAnyProxy = normalized.httpProxy
    || normalized.httpsProxy
    || normalized.wsProxy
    || normalized.wssProxy;
  if (!hasAnyProxy) {
    if (!strict) return { ...DEFAULT_NETWORK_PROXY_CONFIG };
    throw new Error("manual network proxy requires at least one proxy URL");
  }

  return normalized;
}

function noProxyEntries(noProxy) {
  return String(noProxy || "")
    .split(/[\s,]+/)
    .map(v => v.trim())
    .filter(Boolean);
}

function withForcedLocalProxyBypass(noProxy, options = {}) {
  const entries = noProxyEntries(noProxy);
  const seen = new Set(entries.map(entry => entry.toLowerCase()));
  for (const entry of FORCED_LOCAL_PROXY_BYPASS) {
    if (seen.has(entry.toLowerCase())) continue;
    entries.push(entry);
    seen.add(entry.toLowerCase());
  }
  if (options.electron === true && !seen.has("<local>")) {
    entries.push("<local>");
  }
  return entries.join(", ");
}

function stripHostBrackets(host) {
  return String(host || "").replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
}

function isForcedLocalHost(host) {
  const normalized = stripHostBrackets(host);
  if (normalized === "localhost" || normalized === "::1") return true;
  return /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

function splitNoProxyEntry(entry) {
  const raw = String(entry || "").trim();
  if (!raw) return null;
  if (raw === "*") return { host: "*", port: "" };

  if (raw.startsWith("[")) {
    const end = raw.indexOf("]");
    if (end >= 0) {
      const host = raw.slice(1, end).toLowerCase();
      const rest = raw.slice(end + 1);
      const port = rest.startsWith(":") ? rest.slice(1) : "";
      return { host, port };
    }
  }

  const colonCount = (raw.match(/:/g) || []).length;
  if (colonCount === 1) {
    const idx = raw.lastIndexOf(":");
    return {
      host: stripHostBrackets(raw.slice(0, idx)),
      port: raw.slice(idx + 1),
    };
  }

  return { host: stripHostBrackets(raw), port: "" };
}

function hostMatchesNoProxy(host, pattern) {
  if (pattern === "*") return true;
  if (!host || !pattern) return false;
  if (pattern.startsWith("*.")) {
    const suffix = pattern.slice(1);
    return host.endsWith(suffix);
  }
  if (pattern.startsWith(".")) {
    return host === pattern.slice(1) || host.endsWith(pattern);
  }
  return host === pattern;
}

function effectiveUrlPort(parsed) {
  if (parsed.port) return parsed.port;
  if (parsed.protocol === "http:" || parsed.protocol === "ws:") return "80";
  if (parsed.protocol === "https:" || parsed.protocol === "wss:") return "443";
  return "";
}

function isNoProxyMatch(targetUrl, noProxy) {
  let parsed;
  try {
    parsed = targetUrl instanceof URL ? targetUrl : new URL(String(targetUrl));
  } catch {
    return false;
  }
  const host = stripHostBrackets(parsed.hostname);
  const port = effectiveUrlPort(parsed);
  if (isForcedLocalHost(host)) return true;
  if (!noProxy) return false;

  for (const entry of noProxyEntries(noProxy)) {
    const rule = splitNoProxyEntry(entry);
    if (!rule) continue;
    if (rule.port && rule.port !== port) continue;
    if (hostMatchesNoProxy(host, rule.host)) return true;
  }
  return false;
}

function envValue(env, keys) {
  for (const key of keys) {
    if (env?.[key]) return String(env[key]).trim();
  }
  return "";
}

function proxyConfigFromEnvironment(env = process.env) {
  const httpProxy = envValue(env, ["HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"]);
  const httpsProxy = envValue(env, [
    "HTTPS_PROXY",
    "https_proxy",
    "HTTP_PROXY",
    "http_proxy",
    "ALL_PROXY",
    "all_proxy",
  ]);
  const wsProxy = envValue(env, ["WS_PROXY", "ws_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"]);
  const wssProxy = envValue(env, [
    "WSS_PROXY",
    "wss_proxy",
    "HTTPS_PROXY",
    "https_proxy",
    "HTTP_PROXY",
    "http_proxy",
    "ALL_PROXY",
    "all_proxy",
  ]);
  const noProxy = envValue(env, ["NO_PROXY", "no_proxy"]);
  return normalizeNetworkProxyConfig({
    mode: (httpProxy || httpsProxy || wsProxy || wssProxy) ? "manual" : "direct",
    httpProxy,
    httpsProxy,
    wsProxy,
    wssProxy,
    noProxy: noProxy || "",
  });
}

function resolveProxyForUrl(targetUrl, config, env = process.env) {
  const base = normalizeNetworkProxyConfig(config);
  if (base.mode === "direct") return "";

  const effective = base.mode === "system"
    ? proxyConfigFromEnvironment(env)
    : base;

  if (effective.mode === "direct") return "";

  let parsed;
  try {
    parsed = targetUrl instanceof URL ? targetUrl : new URL(String(targetUrl));
  } catch {
    return "";
  }

  if (isNoProxyMatch(parsed, effective.noProxy)) return "";

  switch (parsed.protocol) {
    case "http:":
      return effective.httpProxy || effective.httpsProxy || "";
    case "https:":
      return effective.httpsProxy || effective.httpProxy || "";
    case "ws:":
      return effective.wsProxy || effective.httpProxy || effective.httpsProxy || "";
    case "wss:":
      return effective.wssProxy || effective.httpsProxy || effective.httpProxy || effective.wsProxy || "";
    default:
      return "";
  }
}

function proxyConfigToEnvironment(config, baseEnv = process.env) {
  const normalized = normalizeNetworkProxyConfig(config);
  const env = { ...(baseEnv || {}) };
  for (const key of [
    "HTTP_PROXY",
    "http_proxy",
    "HTTPS_PROXY",
    "https_proxy",
    "WS_PROXY",
    "ws_proxy",
    "WSS_PROXY",
    "wss_proxy",
    "NO_PROXY",
    "no_proxy",
    "ALL_PROXY",
    "all_proxy",
  ]) {
    delete env[key];
  }
  if (normalized.mode === "system") return { ...(baseEnv || {}) };
  if (normalized.mode === "direct") return env;

  const httpProxy = normalized.httpProxy || normalized.httpsProxy || "";
  const httpsProxy = normalized.httpsProxy || normalized.httpProxy || "";
  const wsProxy = normalized.wsProxy || httpProxy || httpsProxy || "";
  const wssProxy = normalized.wssProxy || httpsProxy || httpProxy || wsProxy || "";
  if (httpProxy) env.HTTP_PROXY = env.http_proxy = httpProxy;
  if (httpsProxy) env.HTTPS_PROXY = env.https_proxy = httpsProxy;
  if (wsProxy) env.WS_PROXY = env.ws_proxy = wsProxy;
  if (wssProxy) env.WSS_PROXY = env.wss_proxy = wssProxy;
  const noProxy = withForcedLocalProxyBypass(normalized.noProxy);
  if (noProxy) env.NO_PROXY = env.no_proxy = noProxy;
  return env;
}

function systemProxyConfigToEnvironment(resolved, baseEnv = process.env, config = {}) {
  const noProxy = withForcedLocalProxyBypass(resolved?.noProxy || config?.noProxy || "");
  const candidate = normalizeNetworkProxyConfig({
    mode: "manual",
    httpProxy: resolved?.httpProxy || "",
    httpsProxy: resolved?.httpsProxy || "",
    wsProxy: resolved?.wsProxy || "",
    wssProxy: resolved?.wssProxy || "",
    noProxy,
  });

  if (candidate.mode === "manual") {
    return proxyConfigToEnvironment(candidate, baseEnv);
  }

  const env = proxyConfigToEnvironment({ mode: "direct" }, baseEnv);
  if (noProxy) env.NO_PROXY = env.no_proxy = noProxy;
  return env;
}

function formatElectronProxyServer(proxyUrl) {
  if (!proxyUrl) return "";
  const parsed = new URL(proxyUrl);
  const auth = parsed.username
    ? `${decodeURIComponent(parsed.username)}${parsed.password ? `:${decodeURIComponent(parsed.password)}` : ""}@`
    : "";
  return `${parsed.protocol}//${auth}${parsed.host}`;
}

function electronProxyRulesForConfig(config) {
  const normalized = normalizeNetworkProxyConfig(config);
  if (normalized.mode !== "manual") return "";
  const rules = [];
  const httpProxy = normalized.httpProxy || normalized.httpsProxy || "";
  const httpsProxy = normalized.httpsProxy || normalized.httpProxy || "";
  const wsProxy = normalized.wsProxy || httpProxy || httpsProxy || "";
  const wssProxy = normalized.wssProxy || httpsProxy || httpProxy || wsProxy || "";
  if (httpProxy) rules.push(`http=${formatElectronProxyServer(httpProxy)}`);
  if (httpsProxy) rules.push(`https=${formatElectronProxyServer(httpsProxy)}`);
  if (wsProxy) rules.push(`ws=${formatElectronProxyServer(wsProxy)}`);
  if (wssProxy) rules.push(`wss=${formatElectronProxyServer(wssProxy)}`);
  return rules.join(";");
}

function electronProxyBypassRulesForConfig(config) {
  const normalized = normalizeNetworkProxyConfig(config);
  return noProxyEntries(withForcedLocalProxyBypass(normalized.noProxy, { electron: true })).join(",");
}

module.exports = {
  NETWORK_PROXY_MODES,
  DEFAULT_NO_PROXY,
  FORCED_LOCAL_PROXY_BYPASS,
  DEFAULT_NETWORK_PROXY_CONFIG,
  normalizeNetworkProxyConfig,
  noProxyEntries,
  withForcedLocalProxyBypass,
  isNoProxyMatch,
  proxyConfigFromEnvironment,
  resolveProxyForUrl,
  proxyConfigToEnvironment,
  systemProxyConfigToEnvironment,
  formatElectronProxyServer,
  electronProxyRulesForConfig,
  electronProxyBypassRulesForConfig,
};
