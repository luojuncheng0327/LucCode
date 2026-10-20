const {
  enableWindowsSystemCaForCurrentProcess,
} = require("./src/shared/windows-system-ca.cjs");

// Must run before loading the desktop main (or any module that can create an
// HTTPS client). In normal Electron app mode arbitrary Node CLI flags are not
// supported, so extend this process's Node TLS defaults directly.
enableWindowsSystemCaForCurrentProcess();

const fs = require("fs");
const os = require("os");
const path = require("path");
const { app, dialog } = require("electron");

let diagnosticsDir = path.join(os.tmpdir(), "luc-desktop-launch");
let launchIntegrity = null;

function serializeError(err) {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      stack: err.stack,
      code: err.code,
    };
  }
  return { message: String(err) };
}

function fallbackWriteDiagnostic(fileName, event, payload) {
  try {
    fs.mkdirSync(diagnosticsDir, { recursive: true });
    const filePath = path.join(diagnosticsDir, fileName);
    fs.writeFileSync(filePath, JSON.stringify({
      event,
      time: new Date().toISOString(),
      payload,
    }, null, 2) + "\n", "utf-8");
    return filePath;
  } catch {
    return null;
  }
}

function writeDiagnostic(fileName, event, payload) {
  try {
    if (launchIntegrity?.writeLaunchDiagnostic) {
      return launchIntegrity.writeLaunchDiagnostic({
        diagnosticsDir,
        fileName,
        event,
        payload,
      });
    }
  } catch {}
  return fallbackWriteDiagnostic(fileName, event, payload);
}

function appendLaunchLog(event, payload) {
  try {
    if (launchIntegrity?.appendLaunchLog) {
      return launchIntegrity.appendLaunchLog({ diagnosticsDir, event, payload });
    }
  } catch {}

  try {
    fs.mkdirSync(diagnosticsDir, { recursive: true });
    const filePath = path.join(diagnosticsDir, "launch.log");
    fs.appendFileSync(filePath, JSON.stringify({
      event,
      time: new Date().toISOString(),
      payload,
    }) + "\n", "utf-8");
    return filePath;
  } catch {
    return null;
  }
}

function writeLaunchMarker(status, payload = {}) {
  return writeDiagnostic("launch-marker.json", "launch-marker", {
    status,
    pid: process.pid,
    platform: process.platform,
    arch: process.arch,
    execPath: process.execPath,
    resourcesPath: process.resourcesPath || null,
    lucHome,
    ...payload,
  });
}

function showBootstrapError(title, detail) {
  try {
    dialog.showErrorBox(title, detail);
  } catch {}
}

function exitAfterBootstrapFailure() {
  try {
    app.exit(1);
  } catch {}
  process.exit(1);
}

function recordProcessError(kind, err) {
  const payload = {
    kind,
    error: serializeError(err),
    phase: "desktop-bootstrap",
  };
  const fileName = `${kind}.json`;
  writeDiagnostic(fileName, kind, payload);
  appendLaunchLog(kind, payload);
}

process.on("uncaughtException", (err) => {
  if (err?.code === "EPIPE" || err?.code === "ERR_IPC_CHANNEL_CLOSED") return;
  recordProcessError("uncaughtException", err);
});

process.on("unhandledRejection", (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  recordProcessError("unhandledRejection", err);
});

let lucHome = null;
try {
  const { resolveLucHome } = require("../shared/luc-runtime-paths.cjs");
  lucHome = resolveLucHome(process.env.LUC_HOME);
  process.env.LUC_HOME = lucHome;
  diagnosticsDir = path.join(lucHome, "diagnostics", "desktop-launch");
} catch (err) {
  const diagnosticPath = writeDiagnostic("luc-home-resolve-failed.json", "luc-home-resolve-failed", {
    phase: "desktop-bootstrap",
    error: serializeError(err),
  });
  showBootstrapError(
    "LucCode Launch Failed",
    `LucCode failed before LUC_HOME could be resolved.\n\n${err?.message || err}\n\nDiagnostic file:\n${diagnosticPath || diagnosticsDir}`,
  );
  exitAfterBootstrapFailure();
}

writeLaunchMarker("bootstrap-started", {
  argv: process.argv,
  versions: {
    electron: process.versions.electron || null,
    node: process.versions.node || null,
    chrome: process.versions.chrome || null,
  },
});

function verifyWindowsInstallSurfaceBeforeMain() {
  if (process.platform !== "win32" || !app.isPackaged) {
    return true;
  }
  const result = launchIntegrity.checkWindowsInstallSurface({
    execPath: process.execPath,
    resourcesPath: process.resourcesPath,
  });
  if (result.ok) {
    appendLaunchLog("install-surface-check-ok", result);
    return true;
  }

  const diagnosticPath = writeDiagnostic(
    "install-surface-check.json",
    "install-surface-check-failed",
    result,
  );
  writeLaunchMarker("install-surface-check-failed", {
    missing: result.missing,
    diagnosticPath,
  });
  const detail = launchIntegrity.formatInstallSurfaceError(result, diagnosticPath);
  showBootstrapError("LucCode Launch Failed", detail);
  exitAfterBootstrapFailure();
  return false;
}

function loadDesktopMain() {
  try {
    launchIntegrity = require("./src/shared/launch-integrity.cjs");
    appendLaunchLog("bootstrap-loaded", {
      packaged: app.isPackaged,
      main: app.isPackaged ? "main.bundle.cjs" : "main.cjs",
    });

    if (!verifyWindowsInstallSurfaceBeforeMain()) return;

    writeLaunchMarker("main-load-started", {
      main: app.isPackaged ? "main.bundle.cjs" : "main.cjs",
    });
    require(app.isPackaged ? "./main.bundle.cjs" : "./main.cjs");
    writeLaunchMarker("main-loaded");
  } catch (err) {
    const payload = {
      phase: "desktop-main-load",
      error: serializeError(err),
    };
    const diagnosticPath = writeDiagnostic("desktop-main-load-failed.json", "desktop-main-load-failed", payload);
    appendLaunchLog("desktop-main-load-failed", { ...payload, diagnosticPath });
    writeLaunchMarker("desktop-main-load-failed", { diagnosticPath });
    showBootstrapError(
      "LucCode Launch Failed",
      `LucCode failed before the desktop main process finished loading.\n\n${err?.message || err}\n\nDiagnostic file:\n${diagnosticPath || diagnosticsDir}`,
    );
    exitAfterBootstrapFailure();
  }
}

function tryStartOfficePdfHelper() {
  let helper;
  try {
    helper = require("./src/office-pdf-helper.cjs");
  } catch (err) {
    if (process.argv.some((arg) => arg === "--luc-office-html-to-pdf" || arg.startsWith("--luc-office-html-to-pdf="))) {
      console.error("[office-pdf-helper] failed to load helper:", err?.stack || err?.message || err);
      process.exitCode = 1;
      try { app.exit(1); } catch {}
      return true;
    }
    return false;
  }
  if (!helper.isOfficePdfHelperInvocation(process.argv)) return false;
  helper.runOfficePdfHelperFromArgv(process.argv).catch((err) => {
    console.error("[office-pdf-helper]", err?.stack || err?.message || err);
    process.exitCode = 1;
    try { app.exit(1); } catch {}
  });
  return true;
}

if (!tryStartOfficePdfHelper()) {
  loadDesktopMain();
}
