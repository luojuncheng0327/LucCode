const { execFile: defaultExecFile } = require("child_process");
const path = require("path");

const MACHINE_ENVIRONMENT_KEY = "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment";
const USER_ENVIRONMENT_KEY = "HKCU\\Environment";
const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";
const DEFAULT_COMSPEC = "C:\\Windows\\System32\\cmd.exe";

function normalizeWin32ProcessEnv(env, options = {}) {
  const source = env || {};
  const next = { ...source };
  const pathEntries = [
    ...(options.prependPathEntries || []),
    ...collectPathEntries(source),
    ...(options.appendPathEntries || []),
  ];

  for (const key of Object.keys(next)) {
    if (key.toLowerCase() === "path") delete next[key];
  }
  next.PATH = uniquePathEntries(pathEntries).join(";");

  if (!hasEnvKey(next, "PATHEXT")) {
    next.PATHEXT = options.defaultPathext || DEFAULT_PATHEXT;
  }
  if (!hasEnvKey(next, "ComSpec") && !hasEnvKey(next, "COMSPEC")) {
    next.ComSpec = options.defaultComSpec || DEFAULT_COMSPEC;
  }

  return next;
}

async function readWin32RegistryPathEntries(options = {}) {
  const execFile = options.execFile || defaultExecFile;
  const env = options.env || process.env;
  const values = await Promise.all([
    readRegistryPathValue(MACHINE_ENVIRONMENT_KEY, { execFile, env }),
    readRegistryPathValue(USER_ENVIRONMENT_KEY, { execFile, env }),
  ]);
  return uniquePathEntries(values.flatMap((value) => splitPathList(expandWin32EnvVars(value, env))));
}

async function buildWin32ServerEnv(env, options = {}) {
  const readRegistryPathEntries = options.readRegistryPathEntries || (() => readWin32RegistryPathEntries(options));
  let registryPathEntries = [];
  try {
    registryPathEntries = await readRegistryPathEntries();
  } catch {
    registryPathEntries = [];
  }
  return normalizeWin32ProcessEnv(env, {
    ...options,
    appendPathEntries: [
      ...(options.appendPathEntries || []),
      ...registryPathEntries,
    ],
  });
}

function collectPathEntries(env) {
  const entries = [];
  for (const key of Object.keys(env || {})) {
    if (key.toLowerCase() !== "path") continue;
    entries.push(...splitPathList(env[key]));
  }
  return entries;
}

function splitPathList(value) {
  return String(value || "")
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function uniquePathEntries(entries) {
  const seen = new Set();
  const result = [];
  for (const entry of entries || []) {
    const normalized = String(entry || "").trim();
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

function hasEnvKey(env, name) {
  const target = String(name).toLowerCase();
  return Object.keys(env || {}).some((key) => key.toLowerCase() === target);
}

function readRegistryPathValue(key, { execFile, env }) {
  return new Promise((resolve) => {
    execFile(regExecutableForEnv(env), ["query", key, "/v", "Path"], {
      windowsHide: true,
      encoding: "utf8",
      env,
    }, (err, stdout) => {
      if (err) {
        resolve("");
        return;
      }
      resolve(parseRegistryPathValue(stdout));
    });
  });
}

function regExecutableForEnv(env) {
  const windowsRoot = getEnvValue(env, "SystemRoot") || getEnvValue(env, "windir");
  return windowsRoot ? path.win32.join(windowsRoot, "System32", "reg.exe") : "reg.exe";
}

function parseRegistryPathValue(output) {
  const lines = String(output || "").split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/i);
    if (match) return match[1].trim();
  }
  return "";
}

function expandWin32EnvVars(value, env) {
  return String(value || "").replace(/%([^%]+)%/g, (match, name) => {
    const resolved = getEnvValue(env, name);
    return resolved == null ? match : resolved;
  });
}

function getEnvValue(env, name) {
  const target = String(name || "").toLowerCase();
  const key = Object.keys(env || {}).find((item) => item.toLowerCase() === target);
  return key ? env[key] : undefined;
}

module.exports = {
  buildWin32ServerEnv,
  normalizeWin32ProcessEnv,
  readWin32RegistryPathEntries,
  _testing: {
    expandWin32EnvVars,
    parseRegistryPathValue,
    regExecutableForEnv,
    splitPathList,
    uniquePathEntries,
  },
};
