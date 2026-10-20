import fs from "fs";
import os from "os";
import path from "path";
import { COMPUTER_USE_ERRORS, computerUseError } from "../errors.ts";
import { createCommandRunner } from "./command-runner.ts";

const LUC_CURSOR_BLOOM_COLOR = "#537D96";
const LUC_CURSOR_GRADIENT_COLORS = Object.freeze(["#FFFDF8", "#8FAABD", "#2F4A56"]);
const LUC_CUA_CURSOR_STYLE = Object.freeze({
  gradient_colors: LUC_CURSOR_GRADIENT_COLORS,
  bloom_color: LUC_CURSOR_BLOOM_COLOR,
  image_path: "",
});
const LUC_AGENT_CURSOR_CONFIG_ENV = "LUC_AGENT_CURSOR_CONFIG_JSON";
const LUC_AGENT_SOCKET_PATH_ENV = "LUC_COMPUTER_USE_SOCKET_PATH";
const LUC_CURSOR_MOTION = Object.freeze({
  start_handle: 0.38,
  end_handle: 0.28,
  arc_size: 0.08,
  arc_flow: 0,
  spring: 1,
  glide_duration_ms: 520,
  dwell_after_click_ms: 160,
  idle_hide_ms: 2600,
});
const MACOS_CUA_ALLOWED_ACTIONS = [
  "click_element",
  "type_text",
  "press_key",
  "scroll",
  "perform_secondary_action",
  "stop",
];
const MACOS_CUA_DISABLED_PIXEL_ACTIONS = new Set(["click_point", "double_click", "drag"]);

function expandHome(filePath: any, homeDir = os.homedir()) {
  const value = typeof filePath === "string" ? filePath.trim() : "";
  if (!value || !value.startsWith("~/")) return value || null;
  return path.posix.join(homeDir, value.slice(2));
}

function helperPath(root: any) {
  return path.posix.join(root, "luc-computer-use-helper");
}

function defaultLucComputerUseSocketPath(homeDir = os.homedir()) {
  return path.join(homeDir, "Library", "Caches", "luc-computer-use", "luc-computer-use-helper.sock");
}

function commandIsBundledLucHelper(command: any) {
  return path.posix.basename(String(command || "")) === "luc-computer-use-helper";
}

function normalizedAbsolutePosixPath(value: any) {
  const candidate = typeof value === "string" ? value.trim() : "";
  if (!candidate || candidate.includes("\0") || !path.posix.isAbsolute(candidate)) return null;
  return path.posix.normalize(candidate);
}

function macAppResourcesRoot(value: any) {
  const resourcesRoot = normalizedAbsolutePosixPath(value);
  if (!resourcesRoot || path.posix.basename(resourcesRoot) !== "Resources") return null;
  const contentsRoot = path.posix.dirname(resourcesRoot);
  if (path.posix.basename(contentsRoot) !== "Contents") return null;
  const appRoot = path.posix.dirname(contentsRoot);
  if (!path.posix.basename(appRoot).endsWith(".app")) return null;
  return resourcesRoot;
}

function resourcesRootFromPackagedAppPath(value: any) {
  const appPath = normalizedAbsolutePosixPath(value);
  if (!appPath || path.posix.basename(appPath) !== "app.asar") return null;
  return macAppResourcesRoot(path.posix.dirname(appPath));
}

function resourcesRootFromPackagedExecPath(value: any) {
  const execPath = normalizedAbsolutePosixPath(value);
  if (!execPath) return null;
  const macosRoot = path.posix.dirname(execPath);
  if (path.posix.basename(macosRoot) !== "MacOS") return null;
  const contentsRoot = path.posix.dirname(macosRoot);
  if (path.posix.basename(contentsRoot) !== "Contents") return null;
  const appRoot = path.posix.dirname(contentsRoot);
  if (!path.posix.basename(appRoot).endsWith(".app")) return null;
  return path.posix.join(contentsRoot, "Resources");
}

function resourcesRootFromLegacyLucRoot(value: any) {
  const lucRoot = normalizedAbsolutePosixPath(value);
  if (!lucRoot || path.posix.basename(lucRoot) !== "server") return null;
  return macAppResourcesRoot(path.posix.dirname(lucRoot));
}

function pushUniquePosixPath(out: string[], value: any) {
  if (!value) return;
  const normalized = path.posix.normalize(String(value));
  if (!out.includes(normalized)) out.push(normalized);
}

function packagedHelperCandidates({ env, lucRoot }: any) {
  const roots: string[] = [];
  if (env.LUC_DESKTOP_IS_PACKAGED === "1") {
    pushUniquePosixPath(roots, macAppResourcesRoot(env.LUC_DESKTOP_RESOURCES_PATH));
    pushUniquePosixPath(roots, resourcesRootFromPackagedAppPath(env.LUC_DESKTOP_APP_PATH));
    pushUniquePosixPath(roots, resourcesRootFromPackagedExecPath(env.LUC_DESKTOP_EXEC_PATH));
  }
  // Shells predating the desktop path contract launched the server directly
  // from Contents/Resources/server. Accept only that exact app-bundle shape;
  // an OTA artifact root must never become a source of native helper code.
  pushUniquePosixPath(roots, resourcesRootFromLegacyLucRoot(lucRoot));
  return roots.map((root) => helperPath(path.posix.join(root, "computer-use", "macos")));
}

function developmentHelperCandidates({ env, lucRoot, cwd, arch }: any) {
  if (env.LUC_DESKTOP_IS_PACKAGED === "1") return [];
  const candidates: string[] = [];
  const normalizedLucRoot = normalizedAbsolutePosixPath(lucRoot);
  const normalizedCwd = normalizedAbsolutePosixPath(cwd);
  if (normalizedLucRoot) {
    pushUniquePosixPath(
      candidates,
      helperPath(path.posix.join(normalizedLucRoot, "dist-computer-use", `mac-${arch}`)),
    );
  }
  if (normalizedCwd) {
    pushUniquePosixPath(
      candidates,
      helperPath(path.posix.join(normalizedCwd, "dist-computer-use", `mac-${arch}`)),
    );
  }
  return candidates;
}

export function resolveCuaDriverCommand({
  env = process.env,
  homeDir = os.homedir(),
  existsSync = fs.existsSync,
  lucRoot = env.LUC_ROOT,
  cwd = process.cwd(),
  arch = process.arch,
} = {}) {
  const explicitHelper = expandHome(env.LUC_COMPUTER_USE_HELPER_PATH, homeDir);
  if (explicitHelper) return explicitHelper;

  const explicitRuntimeRoot = expandHome(env.LUC_COMPUTER_USE_RUNTIME_ROOT, homeDir);
  if (explicitRuntimeRoot) return helperPath(explicitRuntimeRoot);

  const packagedCandidates = packagedHelperCandidates({ env, lucRoot });
  for (const candidate of packagedCandidates) {
    if (existsSync(candidate)) return candidate;
  }
  // A valid packaged-app root is authoritative. Falling through to an
  // unrelated external driver would hide a damaged installation and change
  // the daemon/cursor capability contract.
  if (packagedCandidates.length > 0) return packagedCandidates[0];

  const candidates = [
    ...developmentHelperCandidates({ env, lucRoot, cwd, arch }),
    env.LUC_CUA_DRIVER_PATH,
    "~/.local/bin/cua-driver",
    "/usr/local/bin/cua-driver",
    "/Applications/CuaDriver.app/Contents/MacOS/cua-driver",
  ].filter(Boolean).map((p) => expandHome(p, homeDir));

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return "cua-driver";
}

function parseJsonMaybe(stdout: any) {
  const text = String(stdout || "").trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { content: [{ type: "text", text }], structuredContent: null };
  }
}

function getStructured(result: any) {
  return result?.structuredContent
    || result?.structured_content
    || result?.data
    || null;
}

function getContent(result: any) {
  return Array.isArray(result?.content) ? result.content : [];
}

function getText(result: any) {
  return getContent(result)
    .filter((block) => block?.type === "text")
    .map((block) => block.text || "")
    .join("\n");
}

function getImage(result: any) {
  return getContent(result).find((block) => block?.type === "image") || null;
}

function parsePermissionText(text: any) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .map((line) => {
      const match = line.match(/(?:✅|❌)?\s*([^:]+):\s*(.+)$/u);
      if (!match) return null;
      return {
        name: match[1].trim(),
        granted: !/not\s+granted|missing|denied|false/i.test(match[2]),
      };
    })
    .filter(Boolean);
}

function normalizePermissions(result: any) {
  const structured = getStructured(result);
  if (Array.isArray(structured?.permissions)) return structured.permissions;
  return parsePermissionText(getText(result));
}

function normalizeWindows(windows: any[] = []) {
  if (!Array.isArray(windows)) return [];
  return windows.map((win) => ({
    windowId: String(win.window_id ?? win.windowId ?? win.id ?? ""),
    title: win.title || win.name || "",
    bounds: win.bounds || null,
    isOnScreen: win.is_on_screen ?? win.isOnScreen ?? null,
    onCurrentSpace: win.on_current_space ?? win.onCurrentSpace ?? null,
    layer: win.layer ?? null,
    zIndex: win.z_index ?? win.zIndex ?? null,
  })).filter((win) => win.windowId);
}

function normalizeAppsPayload(payload: any) {
  const apps = Array.isArray(payload) ? payload : (payload?.apps || payload?.items || []);
  if (!Array.isArray(apps)) return [];
  return apps.map((app) => {
    const bundleId = app.bundle_id || app.bundleId || app.appId || app.id || null;
    const pid = app.pid ?? app.process_id ?? app.processId ?? null;
    const appId = bundleId || (pid != null ? `pid:${pid}` : app.name || "unknown");
    return {
      appId,
      name: app.name || app.localized_name || app.displayName || appId,
      pid,
      active: app.active ?? app.is_active ?? null,
      windows: normalizeWindows(app.windows),
      providerData: {
        bundleId,
        pid,
      },
    };
  });
}

function normalizeWindowsPayload(payload: any) {
  const windows = Array.isArray(payload) ? payload : (payload?.windows || payload?.items || []);
  return normalizeWindows(windows);
}

function windowArea(win: any) {
  const width = Number(win?.bounds?.width || 0);
  const height = Number(win?.bounds?.height || 0);
  return Number.isFinite(width) && Number.isFinite(height) ? width * height : 0;
}

function scoreLaunchWindow(win: any) {
  let score = 0;
  if (win?.isOnScreen === true) score += 1000;
  if (win?.onCurrentSpace === true) score += 500;
  if (String(win?.title || "").trim()) score += 100;
  const area = windowArea(win);
  score += Math.min(80, area / 10000);
  if (Number(win?.bounds?.height || 0) > 80) score += 50;
  return score;
}

function selectLaunchWindow(windows: any, targetWindowId: any = null) {
  if (!Array.isArray(windows) || !windows.length) return null;
  if (targetWindowId) {
    const explicit = windows.find((win) => String(win.windowId) === String(targetWindowId));
    if (explicit) return explicit;
  }
  return [...windows].sort((a, b) => scoreLaunchWindow(b) - scoreLaunchWindow(a))[0] || null;
}

function normalizeLaunchPayload(payload: any, target: any) {
  const data = payload || {};
  const windows = normalizeWindows(data.windows);
  const pid = data.pid ?? data.process_id ?? data.processId ?? target?.pid ?? null;
  const selectedWindow = selectLaunchWindow(windows, target?.windowId);
  const windowId = target?.windowId || selectedWindow?.windowId || null;
  if (pid == null || windowId == null) {
    throw computerUseError(
      COMPUTER_USE_ERRORS.TARGET_NOT_FOUND,
      "Cua Driver did not return a pid and window id for the requested target.",
      { target },
    );
  }
  return {
    appId: data.bundle_id || data.bundleId || target?.appId || `pid:${pid}`,
    windowId: String(windowId),
    providerState: {
      pid: Number(pid),
      windowId: Number(windowId),
      appName: data.name || data.app_name || target?.name || null,
      bundleId: data.bundle_id || data.bundleId || target?.appId || null,
    },
  };
}

function sameAppId(left: any, right: any) {
  return String(left || "").trim().toLowerCase() === String(right || "").trim().toLowerCase();
}

function appMatchesTarget(app: any, target: any = {}) {
  if (target.appId) {
    return [
      app?.appId,
      app?.providerData?.bundleId,
    ].some((value) => sameAppId(value, target.appId));
  }
  const targetName = String(target.name || target.appName || "").trim().toLowerCase();
  if (!targetName) return false;
  return [
    app?.name,
    app?.appId,
    app?.providerData?.bundleId,
  ].some((value) => String(value || "").trim().toLowerCase() === targetName);
}

function runningPid(app: any) {
  const pid = Number(app?.pid ?? app?.providerData?.pid);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

function normalizeRunningAppLease(app: any, windows: any, target: any = {}) {
  const pid = runningPid(app);
  const selectedWindow = selectLaunchWindow(windows, target.windowId);
  if (!pid || !selectedWindow) return null;
  const bundleId = app?.providerData?.bundleId || app?.appId || target.appId || null;
  return {
    appId: bundleId || `pid:${pid}`,
    windowId: String(selectedWindow.windowId),
    providerState: {
      pid,
      windowId: Number(selectedWindow.windowId),
      appName: app?.name || target.name || target.appName || null,
      bundleId,
    },
  };
}

function sleep(ms: number) {
  if (!ms) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseElementsFromMarkdown(markdown: any) {
  const elements = [];
  const lines = String(markdown || "").split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = line.match(/^(\s*)-\s+\[(\d+)\]\s+([A-Za-z0-9_]+)(.*)$/);
    if (!match) continue;
    const indent = match[1].length;
    const rest = match[4] || "";
    const childLabels = [];
    for (let childIndex = index + 1; childIndex < lines.length; childIndex += 1) {
      const child = lines[childIndex];
      const childIndent = child.match(/^\s*/)?.[0]?.length || 0;
      if (childIndent <= indent && /^\s*-\s+/.test(child)) break;
      if (/AX(?:StaticText|Image|Button|Heading|TextField)\b/.test(child)) {
        const label = labelFromMarkdownFragment(child);
        if (label) childLabels.push(label);
      }
    }
    elements.push({
      elementId: match[2],
      role: match[3],
      label: labelFromMarkdownFragment(rest) || uniqueLabelParts(childLabels).join(" "),
      actions: actionsFromMarkdownFragment(rest),
      enabled: !/\bDISABLED\b/.test(rest),
      bounds: null,
    });
  }
  return elements;
}

function actionsFromMarkdownFragment(fragment: any) {
  const match = String(fragment || "").match(/\bactions=\[([^\]]*)\]/);
  if (!match?.[1]) return [];
  return match[1]
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function labelFromMarkdownFragment(fragment: any) {
  const text = String(fragment || "");
  const quoted = text.match(/"([^"]+)"/);
  if (quoted?.[1]) return quoted[1].trim();
  const value = text.match(/=\s*"([^"]+)"/);
  if (value?.[1]) return value[1].trim();
  const parenthetical = text.match(/\(([^)]+)\)/);
  if (parenthetical?.[1]) return parenthetical[1].trim();
  return "";
}

function uniqueLabelParts(labels: any[]) {
  const seen = new Set();
  const result = [];
  for (const label of labels) {
    const normalized = String(label || "").trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function normalizeWindowState(result: any, lease: any) {
  const structured = getStructured(result) || {};
  const text = getText(result);
  const image = getImage(result);
  if (!image?.data) {
    throw computerUseError(
      COMPUTER_USE_ERRORS.PROVIDER_CRASHED,
      "Cua Driver response did not include screenshot image data.",
      { leaseId: lease.leaseId },
    );
  }
  const screenshot = {
    type: "image",
    mimeType: image.mimeType || image.mime_type || "image/png",
    data: image.data,
  };
  const display = normalizeScreenshotDisplay(structured);

  const elements = Array.isArray(structured.elements)
    ? structured.elements.map((el, index) => ({
        elementId: String(el.element_index ?? el.elementId ?? el.id ?? index),
        role: el.role || el.ax_role || el.type || "element",
        label: el.label || el.name || el.title || "",
        value: el.value,
        actions: Array.isArray(el.actions) ? el.actions.map(String).filter(Boolean) : [],
        bounds: el.bounds || null,
        enabled: el.enabled !== false,
      }))
    : parseElementsFromMarkdown(structured.tree_markdown || structured.treeMarkdown || text);

  return {
    mode: "vision-native",
    appId: lease.appId,
    windowId: lease.windowId,
    screenshot,
    display,
    focusedElementId: structured.focusedElementId || null,
    elements,
    providerState: lease.providerState,
  };
}

function finiteNumber(value: any, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function positiveNumber(value: any, fallback = 1) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function normalizeScreenshotDisplay(structured: any = {}) {
  const source = structured.display || structured.screen || {};
  const width = positiveNumber(structured.screenshot_width ?? source.width, 1568);
  const height = positiveNumber(structured.screenshot_height ?? source.height, 1000);
  const originalWidth = positiveNumber(
    structured.screenshot_original_width ?? source.originalWidth ?? source.original_width,
    width,
  );
  const originalHeight = positiveNumber(
    structured.screenshot_original_height ?? source.originalHeight ?? source.original_height,
    height,
  );
  return {
    x: finiteNumber(source.x, 0),
    y: finiteNumber(source.y, 0),
    width,
    height,
    originalWidth,
    originalHeight,
    scaleFactor: positiveNumber(structured.screenshot_scale_factor ?? source.scaleFactor ?? source.scale_factor, 1),
  };
}

function elementIndexFromId(elementId: any) {
  const raw = String(elementId || "").replace(/^cua:/, "");
  const n = Number(raw);
  if (!Number.isInteger(n)) {
    throw computerUseError(COMPUTER_USE_ERRORS.TARGET_NOT_FOUND, `Invalid Cua element id: ${elementId}`, { elementId });
  }
  return n;
}

function requireElementIndex(action: any) {
  if (action?.elementId) return elementIndexFromId(action.elementId);
  throw computerUseError(
    COMPUTER_USE_ERRORS.TARGET_NOT_FOUND,
    `Computer action requires an elementId from the latest Cua snapshot: ${action?.type}`,
    { action: action?.type || null },
  );
}

function rejectDisabledPixelAction(action: any = {}) {
  throw computerUseError(
    COMPUTER_USE_ERRORS.CAPABILITY_UNSUPPORTED,
    `macOS Cua pixel input is disabled for clean background control: ${action.type}`,
    { action: action.type || null },
  );
}

function advertisedActions(snapshotElement: any = {}) {
  return Array.isArray(snapshotElement?.actions)
    ? snapshotElement.actions.map(String).filter(Boolean)
    : [];
}

function semanticClickActionForElement(snapshotElement: any = {}) {
  const actions = advertisedActions(snapshotElement);
  if (!actions.length || actions.includes("AXPress")) return null;
  if (actions.includes("AXShowDefaultUI")) return "show_default_ui";
  if (actions.includes("AXOpen")) return "open";
  return null;
}

function normalizeCursorStyle({ cursorStyle, cursorImagePath, cursorBloomColor }: any) {
  if (cursorStyle === false || cursorStyle == null) return null;
  if (cursorImagePath) {
    return {
      image_path: cursorImagePath,
      bloom_color: cursorBloomColor,
    };
  }
  if (typeof cursorStyle !== "object") return null;
  const normalized: Record<string, any> = {};
  if (Array.isArray(cursorStyle.gradient_colors)) {
    normalized.gradient_colors = [...cursorStyle.gradient_colors];
  }
  normalized.bloom_color = typeof cursorStyle.bloom_color === "string"
    ? cursorStyle.bloom_color
    : cursorBloomColor;
  if (typeof cursorStyle.image_path === "string") {
    normalized.image_path = cursorStyle.image_path;
  }
  return normalized;
}

export function createMacosCuaProvider({
  providerId = "macos:cua",
  platform = process.platform,
  command = resolveCuaDriverCommand(),
  cursorStyle = LUC_CUA_CURSOR_STYLE,
  cursorImagePath = null,
  cursorBloomColor = LUC_CURSOR_BLOOM_COLOR,
  cursorEnabled = true,
  cursorMotion = LUC_CURSOR_MOTION,
  runner = createCommandRunner(),
  timeoutMs = 30000,
  launchRetryAttempts = 3,
  launchRetryDelayMs = 350,
  socketPath = process.env[LUC_AGENT_SOCKET_PATH_ENV] || defaultLucComputerUseSocketPath(),
  autoStartDaemon = null,
  daemonStartupTimeoutMs = 5000,
} = {}) {
  let nativeCursorConfigPromise = null;
  let daemonStartPromise = null;
  let daemonStopPromise = null;
  let managedDaemonActive = false;
  let spawnedDaemonChild = null;
  let spawnedDaemonPid = null;
  const bundledLucHelper = commandIsBundledLucHelper(command);
  const shouldAutoStartDaemon = autoStartDaemon ?? bundledLucHelper;
  const resolvedCursorStyle = normalizeCursorStyle({ cursorStyle, cursorImagePath, cursorBloomColor });
  const nativeCursorEnabled = bundledLucHelper && cursorEnabled !== false && Boolean(resolvedCursorStyle);
  const lucCursorRuntimeConfig = resolvedCursorStyle && bundledLucHelper
    ? {
        enabled: cursorEnabled !== false,
        style: { ...resolvedCursorStyle },
        motion: cursorMotion && typeof cursorMotion === "object" ? { ...cursorMotion } : {},
      }
    : null;

  function runEnv(baseEnv: any) {
    return {
      ...(baseEnv || process.env),
      [LUC_AGENT_SOCKET_PATH_ENV]: socketPath,
      ...(lucCursorRuntimeConfig
        ? { [LUC_AGENT_CURSOR_CONFIG_ENV]: JSON.stringify(lucCursorRuntimeConfig) }
        : {}),
    };
  }

  async function runRaw(args: any, options: any = {}) {
    let result: any;
    try {
      result = await runner.run(command, args, {
        timeoutMs: options.timeoutMs || timeoutMs,
        env: runEnv(options.env),
      });
    } catch (err) {
      if (err?.code === "ENOENT") {
        throw computerUseError(
          COMPUTER_USE_ERRORS.PROVIDER_UNAVAILABLE,
          `Computer Use helper executable was not found: ${command}`,
          { providerId, command, launchCode: err.code },
        );
      }
      throw computerUseError(
        COMPUTER_USE_ERRORS.PROVIDER_CRASHED,
        `Computer Use helper could not be launched: ${err?.message || String(err)}`,
        { providerId, command, launchCode: err?.code || null },
      );
    }
    if (result.exitCode !== 0) {
      const stderr = result.stderr || "";
      const parsed = parseJsonMaybe(result.stdout);
      const helperMessage = getText(parsed);
      const permissionDenied = /permission|accessibility|screen recording|tcc/i.test(stderr);
      throw computerUseError(
        permissionDenied ? COMPUTER_USE_ERRORS.OS_PERMISSION_DENIED : COMPUTER_USE_ERRORS.PROVIDER_CRASHED,
        helperMessage || stderr.trim() || `cua-driver exited with code ${result.exitCode}`,
        { providerId, exitCode: result.exitCode },
      );
    }
    const parsed = parseJsonMaybe(result.stdout);
    if (parsed?.isError) {
      throw computerUseError(COMPUTER_USE_ERRORS.PROVIDER_CRASHED, getText(parsed) || "Cua Driver returned an error", { providerId });
    }
    return parsed;
  }

  async function runTool(name: any, payload: any = null) {
    const args = payload == null
      ? [name, "--raw", "--compact", "--socket", socketPath]
      : [name, JSON.stringify(payload), "--raw", "--compact", "--socket", socketPath];
    return runRaw(args);
  }

  async function isDaemonRunning() {
    try {
      const result: any = await runner.run(command, ["status", "--socket", socketPath], {
        timeoutMs: 2000,
        env: runEnv(process.env),
      });
      return result.exitCode === 0;
    } catch {
      return false;
    }
  }

  async function ensureDaemonRunning() {
    if (!shouldAutoStartDaemon) return;
    if (await isDaemonRunning()) {
      managedDaemonActive = true;
      return;
    }
    if (!daemonStartPromise) {
      daemonStartPromise = (async () => {
        if (typeof runner.spawn !== "function") {
          throw computerUseError(
            COMPUTER_USE_ERRORS.PROVIDER_UNAVAILABLE,
            "Computer Use helper runner cannot start the Cua daemon.",
            { providerId, command },
          );
        }
        try {
          spawnedDaemonChild = runner.spawn(command, ["serve", "--socket", socketPath], {
            env: runEnv(process.env),
            detached: true,
            stdio: "ignore",
          });
        } catch (err) {
          throw computerUseError(
            COMPUTER_USE_ERRORS.PROVIDER_UNAVAILABLE,
            `Computer Use helper daemon could not be launched: ${err?.message || String(err)}`,
            { providerId, command, launchCode: err?.code || null },
          );
        }
        const pid = Number(spawnedDaemonChild?.pid);
        spawnedDaemonPid = Number.isFinite(pid) && pid > 0 ? pid : null;
        let daemonLaunchError: any = null;
        const onDaemonLaunchError = (err: any) => {
          daemonLaunchError = computerUseError(
            COMPUTER_USE_ERRORS.PROVIDER_UNAVAILABLE,
            `Computer Use helper daemon could not be launched: ${err?.message || String(err)}`,
            { providerId, command, launchCode: err?.code || null },
          );
        };
        const observesLaunchErrors = typeof spawnedDaemonChild?.once === "function";
        if (observesLaunchErrors) {
          spawnedDaemonChild.once("error", onDaemonLaunchError);
        }
        try {
          const deadline = Date.now() + daemonStartupTimeoutMs;
          while (Date.now() < deadline) {
            if (daemonLaunchError) throw daemonLaunchError;
            if (await isDaemonRunning()) {
              managedDaemonActive = true;
              return;
            }
            // The child may emit ENOENT while the status probe is in flight.
            // Check again before sleeping so a failed launch cannot leave a
            // detached readiness loop polling in the background.
            if (daemonLaunchError) throw daemonLaunchError;
            await sleep(120);
          }
          if (daemonLaunchError) throw daemonLaunchError;
          throw computerUseError(
            COMPUTER_USE_ERRORS.PROVIDER_UNAVAILABLE,
            "Computer Use helper daemon did not become ready in time.",
            { providerId, command, socketPath },
          );
        } finally {
          if (observesLaunchErrors && typeof spawnedDaemonChild?.removeListener === "function") {
            spawnedDaemonChild.removeListener("error", onDaemonLaunchError);
          }
        }
      })().catch((err) => {
        daemonStartPromise = null;
        throw err;
      });
    }
    try {
      await daemonStartPromise;
    } finally {
      daemonStartPromise = null;
    }
  }

  function markDaemonInactive() {
    managedDaemonActive = false;
    nativeCursorConfigPromise = null;
    spawnedDaemonChild = null;
    spawnedDaemonPid = null;
  }

  function killSpawnedDaemon(signal: any) {
    if (!spawnedDaemonPid || platform !== "darwin") return false;
    try {
      process.kill(-spawnedDaemonPid, signal);
      return true;
    } catch {
      try {
        return spawnedDaemonChild?.kill?.(signal) === true;
      } catch {
        return false;
      }
    }
  }

  async function stopManagedDaemon() {
    if (!bundledLucHelper || !shouldAutoStartDaemon) {
      return { stopped: false, reason: "not-managed" };
    }
    if (daemonStopPromise) return daemonStopPromise;
    daemonStopPromise = (async () => {
      if (daemonStartPromise) {
        try { await daemonStartPromise; } catch {}
      }
      if (!managedDaemonActive && !spawnedDaemonPid) {
        return { stopped: false, reason: "not-running" };
      }

      let stopResult: any = null;
      try {
        stopResult = await runner.run(command, ["stop", "--socket", socketPath], {
          timeoutMs: 5000,
          env: runEnv(process.env),
        });
      } catch (err) {
        stopResult = { exitCode: 1, stderr: err?.message || String(err) };
      }

      if (stopResult?.exitCode === 0) {
        markDaemonInactive();
        return { stopped: true, method: "daemon-stop" };
      }

      const killed = killSpawnedDaemon("SIGTERM");
      if (killed) {
        markDaemonInactive();
      }
      return {
        stopped: killed,
        method: killed ? "sigterm" : "none",
        exitCode: stopResult?.exitCode ?? null,
        stderr: stopResult?.stderr || "",
      };
    })().finally(() => {
      daemonStopPromise = null;
    });
    return daemonStopPromise;
  }

  async function ensureNativeCursorConfigured() {
    if (!resolvedCursorStyle || !bundledLucHelper) return;
    await ensureDaemonRunning();
    if (!nativeCursorConfigPromise) {
      nativeCursorConfigPromise = (async () => {
        await runTool("set_agent_cursor_style", resolvedCursorStyle);
        if (cursorMotion && typeof cursorMotion === "object") {
          await runTool("set_agent_cursor_motion", cursorMotion);
        }
        await runTool("set_agent_cursor_enabled", { enabled: cursorEnabled !== false });
      })().catch((err) => {
        nativeCursorConfigPromise = null;
        throw err;
      });
    }
    await nativeCursorConfigPromise;
  }

  async function tryCreateLeaseFromRunningApp(target: any = {}) {
    const appsResult = await runTool("list_apps");
    const app = normalizeAppsPayload(getStructured(appsResult)).find((candidate) => appMatchesTarget(candidate, target));
    const pid = runningPid(app);
    if (!pid) return null;

    const windowsResult = await runTool("list_windows", { pid });
    const windows = normalizeWindowsPayload(getStructured(windowsResult));
    return normalizeRunningAppLease(app, windows, target);
  }

  function ensureDarwin() {
    if (platform !== "darwin") {
      throw computerUseError(COMPUTER_USE_ERRORS.PROVIDER_UNAVAILABLE, "Cua Driver is available only on macOS.", {
        providerId,
        platform,
      });
    }
  }

  return {
    providerId,
    capabilities: {
      platform: "macos",
      observationModes: ["vision-native"],
      screenshot: true,
      accessibilityTree: true,
      elementActions: true,
      elementDoubleClick: false,
      backgroundControl: "full",
      pointClick: "unsupported",
      drag: "unsupported",
      textInput: "semantic",
      keyboardInput: "pidScoped",
      requiresForegroundForInput: false,
      nativeCursor: nativeCursorEnabled,
      isolated: false,
    },

    async getStatus() {
      if (platform !== "darwin") {
        return { providerId, available: false, reason: "unsupported-platform", platform };
      }
      try {
        const status: any = await runner.run(command, ["status", "--socket", socketPath], {
          timeoutMs: 5000,
          env: runEnv(process.env),
        });
        if (status.exitCode !== 0) {
          return { providerId, available: false, reason: "daemon-unavailable", stderr: status.stderr || "" };
        }
        let permissions: any = [];
        try {
          const perms = await runTool("check_permissions", { prompt: false });
          permissions = normalizePermissions(perms);
        } catch (err) {
          permissions = [{ name: "accessibility", granted: false }, { name: "screen-recording", granted: false }];
        }
        return { providerId, available: true, command, daemon: status.stdout.trim(), permissions };
      } catch (err) {
        return {
          providerId,
          available: false,
          reason: err?.code === "ENOENT"
            ? (bundledLucHelper ? "bundled-helper-missing" : "binary-not-found")
            : "status-failed",
          command,
          error: err?.message || String(err),
        };
      }
    },

    async requestPermissions() {
      ensureDarwin();
      const perms = await runTool("check_permissions", { prompt: true });
      return { providerId, available: true, permissions: normalizePermissions(perms) };
    },

    async listApps() {
      ensureDarwin();
      await ensureDaemonRunning();
      const result = await runTool("list_apps");
      return normalizeAppsPayload(getStructured(result));
    },

    async createLease(_ctx: any, target: any = {}) {
      ensureDarwin();
      await ensureNativeCursorConfigured();
      if (target.pid || target.processId) {
        const pid = Number(target.pid || target.processId);
        const windowId = Number(target.windowId);
        if (!Number.isFinite(pid) || !Number.isFinite(windowId)) {
          throw computerUseError(COMPUTER_USE_ERRORS.TARGET_NOT_FOUND, "Cua lease target requires pid and windowId.", { target });
        }
        return {
          appId: target.appId || `pid:${pid}`,
          windowId: String(windowId),
          allowedActions: MACOS_CUA_ALLOWED_ACTIONS,
          providerState: { pid, windowId, appName: target.name || null, bundleId: target.appId || null },
        };
      }

      if (!target.appId && !target.name) {
        throw computerUseError(COMPUTER_USE_ERRORS.TARGET_NOT_FOUND, "Cua lease target requires appId, app name, or pid/windowId.", { target });
      }

      const runningLease = await tryCreateLeaseFromRunningApp(target);
      if (runningLease) {
        return {
          ...runningLease,
          allowedActions: MACOS_CUA_ALLOWED_ACTIONS,
        };
      }

      const payload = target.appId ? { bundle_id: target.appId } : { name: target.name };
      const attempts = Math.max(1, Number(launchRetryAttempts) || 1);
      let normalized = null;
      let lastError = null;
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const result = await runTool("launch_app", payload);
        try {
          normalized = normalizeLaunchPayload(getStructured(result), target);
          break;
        } catch (err) {
          if (err?.code !== COMPUTER_USE_ERRORS.TARGET_NOT_FOUND || attempt === attempts - 1) {
            throw err;
          }
          lastError = err;
          await sleep(launchRetryDelayMs);
        }
      }
      if (!normalized && lastError) throw lastError;
      return {
        ...normalized,
        allowedActions: MACOS_CUA_ALLOWED_ACTIONS,
      };
    },

    async getAppState(_ctx: any, lease: any) {
      ensureDarwin();
      await ensureDaemonRunning();
      await ensureNativeCursorConfigured();
      const { pid, windowId } = lease.providerState || {};
      if (!pid || !windowId) {
        throw computerUseError(COMPUTER_USE_ERRORS.TARGET_NOT_FOUND, "Cua lease is missing native pid/windowId.", { leaseId: lease.leaseId });
      }
      const result = await runTool("get_window_state", { pid, window_id: windowId });
      return normalizeWindowState(result, lease);
    },

    async performAction(_ctx: any, lease: any, action: any) {
      ensureDarwin();
      await ensureDaemonRunning();
      await ensureNativeCursorConfigured();
      const { pid, windowId } = lease.providerState || {};
      if (!pid || !windowId) {
        throw computerUseError(COMPUTER_USE_ERRORS.TARGET_NOT_FOUND, "Cua lease is missing native pid/windowId.", { leaseId: lease.leaseId });
      }
      if (MACOS_CUA_DISABLED_PIXEL_ACTIONS.has(action.type)) {
        rejectDisabledPixelAction(action);
      }

      if (action.type === "click_element") {
        const semanticAction = semanticClickActionForElement(action.snapshotElement);
        if (semanticAction) {
          return getStructured(await runTool("click", {
            pid,
            window_id: windowId,
            element_index: requireElementIndex(action),
            action: semanticAction,
          })) || { ok: true };
        }
        return getStructured(await runTool("click", { pid, window_id: windowId, element_index: requireElementIndex(action) })) || { ok: true };
      }
      if (action.type === "perform_secondary_action") {
        return getStructured(await runTool("right_click", { pid, window_id: windowId, element_index: requireElementIndex(action) })) || { ok: true };
      }
      if (action.type === "type_text") {
        const payload: Record<string, any> = { pid, text: action.text || "" };
        if (action.elementId) {
          payload.window_id = windowId;
          payload.element_index = requireElementIndex(action);
        }
        return getStructured(await runTool("type_text", payload)) || { ok: true };
      }
      if (action.type === "press_key") {
        return getStructured(await runTool("press_key", { pid, key: action.key })) || { ok: true };
      }
      if (action.type === "scroll") {
        const payload: Record<string, any> = { pid, direction: action.direction, amount: action.amount || 3 };
        if (action.elementId) {
          payload.window_id = windowId;
          payload.element_index = requireElementIndex(action);
        }
        return getStructured(await runTool("scroll", payload)) || { ok: true };
      }
      throw computerUseError(COMPUTER_USE_ERRORS.CAPABILITY_UNSUPPORTED, `Unsupported Cua action: ${action.type}`, { action: action.type });
    },

    async releaseLease() {
      const daemon = await stopManagedDaemon();
      return { released: true, daemon };
    },

    async stop() {
      const daemon = await stopManagedDaemon();
      return { stopped: true, daemon };
    },

    async dispose() {
      const daemon = await stopManagedDaemon();
      return { disposed: true, daemon };
    },
  };
}
