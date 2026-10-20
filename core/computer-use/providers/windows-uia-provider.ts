import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { COMPUTER_USE_ERRORS, computerUseError } from "../errors.ts";
import { createCommandRunner } from "./command-runner.ts";
import { WINDOWS_UIA_HELPER_SCRIPT } from "./windows-uia-script.ts";

function defaultPowerShellCommand(env = process.env) {
  if (process.platform !== "win32") return "powershell.exe";
  const root = env.SystemRoot || "C:\\Windows";
  return `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
}

function defaultHelperDir() {
  return path.join(os.tmpdir(), "luc-computer-use", "windows-uia");
}

function helperScriptHash(script) {
  return crypto.createHash("sha256").update(script, "utf8").digest("hex");
}

function helperRunPaths(helperDir) {
  const id = `${process.pid}-${Date.now()}-${crypto.randomBytes(8).toString("hex")}`;
  return {
    requestPath: path.join(helperDir, `windows-uia-request-${id}.json`),
    resultPath: path.join(helperDir, `windows-uia-result-${id}.json`),
  };
}

const DEFAULT_MAX_RESULT_BYTES = 32 * 1024 * 1024;
const RESULT_PREVIEW_BYTES = 2048;

function removeIfPresent(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch {}
}

function textPreview(value, limit = 4000) {
  const text = String(value || "");
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}...[truncated ${text.length - limit} chars]`;
}

function decodePreviewBuffer(buffer) {
  return buffer.toString("utf8").replace(/\0+$/g, "");
}

function readFileSegment(filePath, start, length) {
  if (length <= 0) return "";
  const fd = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const bytesRead = fs.readSync(fd, buffer, 0, length, start);
    return decodePreviewBuffer(buffer.subarray(0, bytesRead));
  } finally {
    fs.closeSync(fd);
  }
}

function resultTextPreview(resultText, resultSize) {
  const text = String(resultText || "");
  if (Buffer.byteLength(text, "utf8") <= RESULT_PREVIEW_BYTES * 2) {
    return {
      resultHeadPreview: text,
      resultTailPreview: text,
    };
  }
  return {
    resultHeadPreview: textPreview(text.slice(0, RESULT_PREVIEW_BYTES), RESULT_PREVIEW_BYTES),
    resultTailPreview: textPreview(text.slice(Math.max(0, text.length - RESULT_PREVIEW_BYTES)), RESULT_PREVIEW_BYTES),
    resultTruncated: true,
    resultSize,
  };
}

function resultFileDiagnostics(resultPath, resultText = null, stat = null) {
  const size = stat?.size ?? (resultText == null ? null : Buffer.byteLength(String(resultText), "utf8"));
  const base = { resultPath, resultSize: size };
  if (!resultPath || size == null) return base;
  if (resultText != null) {
    return { ...base, ...resultTextPreview(resultText, size) };
  }
  try {
    const headLength = Math.min(RESULT_PREVIEW_BYTES, size);
    const tailLength = Math.min(RESULT_PREVIEW_BYTES, size);
    const tailStart = Math.max(0, size - tailLength);
    return {
      ...base,
      resultHeadPreview: readFileSegment(resultPath, 0, headLength),
      resultTailPreview: readFileSegment(resultPath, tailStart, tailLength),
      resultTruncated: size > RESULT_PREVIEW_BYTES * 2,
    };
  } catch (err) {
    return {
      ...base,
      resultPreviewReadCode: err?.code || null,
      resultPreviewReadError: err?.message || String(err),
    };
  }
}

function helperDiagnostics(providerId, result, resultInfo = {}) {
  const resultDiagnostics = typeof resultInfo === "string"
    ? resultFileDiagnostics(null, resultInfo)
    : resultInfo;
  return {
    providerId,
    stdoutPreview: textPreview(result?.stdout),
    stderrPreview: textPreview(result?.stderr),
    ...resultDiagnostics,
  };
}

function readHelperResultFile(resultPath, providerId, result, maxResultBytes) {
  let stat;
  try {
    stat = fs.statSync(resultPath);
  } catch (err) {
    throw computerUseError(COMPUTER_USE_ERRORS.PROVIDER_CRASHED, "Windows UIA helper did not write result JSON.", {
      ...helperDiagnostics(providerId, result, resultFileDiagnostics(resultPath)),
      readCode: err?.code || null,
    });
  }

  if (stat.size > maxResultBytes) {
    throw computerUseError(COMPUTER_USE_ERRORS.PROVIDER_CRASHED, "Windows UIA helper result JSON exceeded the payload limit.", {
      ...helperDiagnostics(providerId, result, resultFileDiagnostics(resultPath, null, stat)),
      maxResultBytes,
    });
  }

  try {
    return fs.readFileSync(resultPath, "utf8");
  } catch (err) {
    throw computerUseError(COMPUTER_USE_ERRORS.PROVIDER_CRASHED, "Windows UIA helper result JSON could not be read.", {
      ...helperDiagnostics(providerId, result, resultFileDiagnostics(resultPath, null, stat)),
      readCode: err?.code || null,
    });
  }
}

function ensureHelperFile(helperDir, helperScript) {
  const hash = helperScriptHash(helperScript);
  const helperPath = path.join(helperDir, `windows-uia-helper-${hash.slice(0, 16)}.ps1`);
  try {
    fs.mkdirSync(helperDir, { recursive: true });
    let current = null;
    try {
      current = fs.readFileSync(helperPath, "utf8");
    } catch (err) {
      if (err?.code !== "ENOENT") throw err;
    }
    if (current !== helperScript) {
      fs.writeFileSync(helperPath, helperScript, "utf8");
    }
    return helperPath;
  } catch (err) {
    throw computerUseError(
      COMPUTER_USE_ERRORS.PROVIDER_CRASHED,
      `Windows UIA helper file could not be prepared: ${err?.message || String(err)}`,
      { helperPath, launchCode: err?.code || null },
    );
  }
}

function mapHelperLaunchError(err, providerId) {
  throw computerUseError(
    COMPUTER_USE_ERRORS.PROVIDER_CRASHED,
    `Windows UIA helper failed to launch: ${err?.message || String(err)}`,
    { providerId, launchCode: err?.code || null },
  );
}

function parsePidAppId(appId) {
  const match = /^pid:(\d+)$/.exec(String(appId || ""));
  return match ? Number(match[1]) : null;
}

function normalizeTarget(target: Record<string, any> = {}) {
  const processId = target.processId ?? target.pid ?? parsePidAppId(target.appId);
  return {
    appId: target.appId || (processId ? `pid:${processId}` : null),
    appName: target.name || target.appName || null,
    processId: processId != null ? Number(processId) : null,
    windowId: target.windowId != null ? Number(target.windowId) : null,
  };
}

function normalizeApps(data) {
  const apps = Array.isArray(data) ? data : (data?.apps || []);
  return apps.map((app) => ({
    appId: app.appId || (app.processId != null ? `pid:${app.processId}` : app.name || "unknown"),
    name: app.name || app.appId || "Windows App",
    pid: app.processId ?? app.pid ?? null,
    windows: Array.isArray(app.windows) ? app.windows.map((win) => ({
      windowId: String(win.windowId ?? win.nativeWindowHandle ?? ""),
      title: win.title || win.name || "",
      bounds: win.bounds || null,
    })).filter((win) => win.windowId) : [],
    providerData: {
      processId: app.processId ?? app.pid ?? null,
    },
  }));
}

function normalizeDisplay(display, screenshot) {
  const source = display || {};
  const shot = screenshot && typeof screenshot === "object" ? screenshot : {};
  const width = Number(source.width ?? shot.width ?? 0);
  const height = Number(source.height ?? shot.height ?? 0);
  const scaleFactor = Number(source.scaleFactor ?? shot.scaleFactor ?? 1) || 1;
  return {
    width,
    height,
    scaleFactor,
    x: Number(source.x ?? 0),
    y: Number(source.y ?? 0),
    ...(source.screenBounds ? { screenBounds: source.screenBounds } : {}),
  };
}

function normalizeSnapshot(data, lease) {
  const screenshotPayload = data?.screenshot;
  const screenshotData = typeof screenshotPayload === "string" ? screenshotPayload : screenshotPayload?.data;
  if (!screenshotData) {
    throw computerUseError(
      COMPUTER_USE_ERRORS.PROVIDER_CRASHED,
      "Windows UIA helper did not return screenshot image data.",
      { leaseId: lease.leaseId },
    );
  }
  return {
    mode: "vision-native",
    appId: data.appId || lease.appId,
    windowId: String(data.windowId || lease.windowId || ""),
    screenshot: { type: "image", mimeType: screenshotPayload?.mimeType || "image/png", data: screenshotData },
    display: normalizeDisplay(data.display, screenshotPayload),
    focusedElementId: data.focusedElementId || null,
    elements: Array.isArray(data.elements) ? data.elements.map((el) => ({
      elementId: String(el.elementId),
      role: el.role || "element",
      label: el.label || "",
      value: el.value,
      enabled: el.enabled !== false,
      bounds: el.bounds || null,
      patterns: Array.isArray(el.patterns) ? el.patterns : [],
      automationId: el.automationId || "",
      nativeWindowHandle: el.nativeWindowHandle ?? null,
    })) : [],
    providerState: data.providerState || lease.providerState || {},
  };
}

const WINDOWS_UIA_ALLOWED_ACTIONS = ["click_element", "type_text", "scroll", "stop"];
const ELEMENT_BOUND_ACTIONS = new Set(["click_element", "double_click", "type_text", "scroll"]);
const FOREGROUND_ONLY_ACTIONS = new Set(["click_point", "double_click", "drag", "press_key"]);

function isForegroundOnlyAction(action: Record<string, any> = {}) {
  if (FOREGROUND_ONLY_ACTIONS.has(action.type)) return true;
  if (action.type === "type_text" && !action.elementId) return true;
  if (action.type === "scroll" && !action.elementId) return true;
  return false;
}

function rejectForegroundOnlyAction(providerId, action: Record<string, any> = {}) {
  throw computerUseError(
    COMPUTER_USE_ERRORS.ACTION_REQUIRES_FOREGROUND,
    "Windows UIA provider is configured for background-only control; this action would require foreground input.",
    { providerId, action: action.type || null },
  );
}

function assertNumber(value, field, actionType) {
  if (typeof value === "number" && Number.isFinite(value)) return;
  throw computerUseError(
    COMPUTER_USE_ERRORS.ACTION_BLOCKED_BY_POLICY,
    `Windows foreground action ${actionType} requires numeric ${field}.`,
    { action: actionType, field },
  );
}

function validateForegroundAction(action) {
  if (action.type === "click_point" || (action.type === "double_click" && !action.elementId)) {
    assertNumber(action.x, "x", action.type);
    assertNumber(action.y, "y", action.type);
  }
  if (action.type === "drag") {
    assertNumber(action.fromX, "fromX", action.type);
    assertNumber(action.fromY, "fromY", action.type);
    assertNumber(action.toX, "toX", action.type);
    assertNumber(action.toY, "toY", action.type);
  }
  if (action.type === "press_key" && !String(action.key || "").trim()) {
    throw computerUseError(
      COMPUTER_USE_ERRORS.ACTION_BLOCKED_BY_POLICY,
      "Windows foreground action press_key requires key.",
      { action: action.type, field: "key" },
    );
  }
  if (action.type === "type_text" && !String(action.text || "")) {
    throw computerUseError(
      COMPUTER_USE_ERRORS.ACTION_BLOCKED_BY_POLICY,
      "Windows action type_text requires text.",
      { action: action.type, field: "text" },
    );
  }
  if (action.type === "scroll" && !String(action.direction || "").trim()) {
    throw computerUseError(
      COMPUTER_USE_ERRORS.ACTION_BLOCKED_BY_POLICY,
      "Windows action scroll requires direction.",
      { action: action.type, field: "direction" },
    );
  }
}

function assertSnapshotBoundElement(action) {
  if (!action?.elementId || !ELEMENT_BOUND_ACTIONS.has(action.type)) return;
  if (action.snapshotElement && String(action.snapshotElement.elementId) === String(action.elementId)) return;
  throw computerUseError(
    COMPUTER_USE_ERRORS.STALE_SNAPSHOT,
    "Windows UIA element actions require metadata from the current snapshot.",
    { action: action.type, elementId: action.elementId, snapshotId: action.snapshotId || null },
  );
}

function helperAction(action) {
  const payload = { ...action };
  if (action.snapshotElement) payload.snapshotElement = action.snapshotElement;
  if (action.snapshotDisplay) payload.snapshotDisplay = action.snapshotDisplay;
  return payload;
}

export function createWindowsUiaProvider({
  providerId = "windows:uia",
  platform = process.platform,
  command = defaultPowerShellCommand(),
  runner = createCommandRunner(),
  helperScript = WINDOWS_UIA_HELPER_SCRIPT,
  helperDir = defaultHelperDir(),
  timeoutMs = 30000,
  maxResultBytes = DEFAULT_MAX_RESULT_BYTES,
} = {}) {
  let helperPath = null;

  async function runHelper(payload) {
    helperPath ||= ensureHelperFile(helperDir, helperScript);
    const { requestPath, resultPath } = helperRunPaths(helperDir);
    let result;
    try {
      try {
        fs.writeFileSync(requestPath, JSON.stringify(payload), "utf8");
      } catch (err) {
        throw computerUseError(
          COMPUTER_USE_ERRORS.PROVIDER_CRASHED,
          `Windows UIA helper request file could not be prepared: ${err?.message || String(err)}`,
          { providerId, writeCode: err?.code || null },
        );
      }

      try {
        result = await runner.run(command, [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          helperPath,
          "-RequestPath",
          requestPath,
          "-ResultPath",
          resultPath,
        ], {
          timeoutMs,
        });
      } catch (err) {
        mapHelperLaunchError(err, providerId);
      }

      if (result.exitCode !== 0) {
        throw computerUseError(
          COMPUTER_USE_ERRORS.PROVIDER_CRASHED,
          result.stderr?.trim() || `Windows UIA helper exited with code ${result.exitCode}`,
          {
            ...helperDiagnostics(providerId, result),
            exitCode: result.exitCode,
          },
        );
      }

      const resultText = readHelperResultFile(resultPath, providerId, result, maxResultBytes);

      let parsed;
      try {
        parsed = JSON.parse(String(resultText || "").trim());
      } catch {
        throw computerUseError(
          COMPUTER_USE_ERRORS.PROVIDER_CRASHED,
          "Windows UIA helper returned invalid JSON.",
          helperDiagnostics(providerId, result, resultFileDiagnostics(resultPath, resultText)),
        );
      }

      if (!parsed?.ok) {
        throw computerUseError(
          parsed?.errorCode || COMPUTER_USE_ERRORS.PROVIDER_CRASHED,
          parsed?.message || "Windows UIA helper failed.",
          parsed?.details || {},
        );
      }
      return parsed.data || {};
    } finally {
      removeIfPresent(requestPath);
      removeIfPresent(resultPath);
    }
  }

  function ensureWin32() {
    if (platform !== "win32") {
      throw computerUseError(COMPUTER_USE_ERRORS.PROVIDER_UNAVAILABLE, "Windows UIA is available only on Windows.", {
        providerId,
        platform,
      });
    }
  }

  return {
    providerId,
    capabilities: {
      platform: "windows",
      observationModes: ["vision-native", "semantic-only"],
      screenshot: true,
      accessibilityTree: true,
      elementActions: true,
      backgroundControl: "partial",
      pointClick: "unsupported",
      drag: "unsupported",
      textInput: "semantic",
      keyboardInput: "unsupported",
      requiresForegroundForInput: false,
      isolated: false,
    },

    async getStatus() {
      if (platform !== "win32") {
        return { providerId, available: false, reason: "unsupported-platform", platform };
      }
      try {
        const data = await runHelper({ command: "status" });
        return { providerId, available: data.available !== false, permissions: data.permissions || [] };
      } catch (err) {
        const launchCode = err?.details?.launchCode || err?.code;
        return {
          providerId,
          available: false,
          reason: launchCode === "ENOENT" ? "powershell-not-found" : "status-failed",
          error: err?.message || String(err),
        };
      }
    },

    async requestPermissions() {
      return this.getStatus();
    },

    async listApps() {
      ensureWin32();
      return normalizeApps(await runHelper({ command: "list_apps" }));
    },

    async createLease(_ctx, target = {}) {
      ensureWin32();
      const nativeTarget = normalizeTarget(target);
      if (!nativeTarget.processId && !nativeTarget.windowId && !nativeTarget.appName) {
        throw computerUseError(COMPUTER_USE_ERRORS.TARGET_NOT_FOUND, "Windows UIA lease target requires appId, app name, processId, or windowId.", {
          target,
        });
      }
      return {
        appId: nativeTarget.appId || nativeTarget.appName || `window:${nativeTarget.windowId}`,
        windowId: nativeTarget.windowId != null ? String(nativeTarget.windowId) : null,
        allowedActions: WINDOWS_UIA_ALLOWED_ACTIONS,
        providerState: nativeTarget,
      };
    },

    async getAppState(_ctx, lease) {
      ensureWin32();
      const data = await runHelper({
        command: "get_app_state",
        target: lease.providerState || {},
      });
      return normalizeSnapshot(data, lease);
    },

    async performAction(_ctx, lease, action) {
      ensureWin32();
      validateForegroundAction(action);
      if (isForegroundOnlyAction(action)) {
        rejectForegroundOnlyAction(providerId, action);
      }
      if (!WINDOWS_UIA_ALLOWED_ACTIONS.includes(action.type)) {
        throw computerUseError(COMPUTER_USE_ERRORS.CAPABILITY_UNSUPPORTED, `Unsupported Windows UIA action: ${action.type}`, {
          action: action.type,
        });
      }
      assertSnapshotBoundElement(action);
      return await runHelper({
        command: "perform_action",
        target: lease.providerState || {},
        action: helperAction(action),
      });
    },

    async releaseLease() {
      return { released: true };
    },

    async stop() {
      return { stopped: true };
    },
  };
}
