#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { applyDevEnvironment, defaultDevLucHome } from "./dev-env.js";
import {
  buildDevWebClientConfig,
  buildDevWebPreviewUrl,
  normalizeServerInfoForDevWeb,
  resolveViteCommand,
} from "./dev-web-runtime.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const lucHome = defaultDevLucHome();
const serverInfoPath = path.join(lucHome, "server-info.json");

let serverProcess = null;
let viteProcess = null;
let shuttingDown = false;

function log(message) {
  process.stdout.write(`[dev-web] ${message}\n`);
}

function removeStaleServerInfo() {
  try {
    fs.unlinkSync(serverInfoPath);
  } catch (err) {
    if (err?.code !== "ENOENT") throw err;
  }
}

function isChildAlive(child) {
  return !!child && child.exitCode === null && child.signalCode === null;
}

async function waitForServerInfo({ timeoutMs = 90_000, intervalMs = 200 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isChildAlive(serverProcess)) {
      throw new Error("Luc server exited before writing server-info.json");
    }
    try {
      const raw = fs.readFileSync(serverInfoPath, "utf-8");
      return normalizeServerInfoForDevWeb(JSON.parse(raw));
    } catch {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  throw new Error("Timed out waiting for server-info.json");
}

function spawnServer() {
  fs.mkdirSync(lucHome, { recursive: true });
  removeStaleServerInfo();

  const serverEnv = applyDevEnvironment({ ...process.env });
  serverEnv.LUC_ROOT = rootDir;
  serverEnv.LUC_SERVER_ENTRY = path.join(rootDir, "server", "main-full.ts");
  serverEnv.LUC_CREATE_STARTUP_SESSION = "0";
  serverEnv.LUC_PORT = process.env.LUC_PORT || "0";
  delete serverEnv.ELECTRON_RUN_AS_NODE;

  serverProcess = spawn(process.execPath, [path.join(rootDir, "server", "bootstrap.ts")], {
    cwd: rootDir,
    env: serverEnv,
    stdio: "inherit",
  });

  serverProcess.on("exit", (code, signal) => {
    if (!shuttingDown && isChildAlive(viteProcess)) {
      log(`server exited (${signal || code}); stopping Vite`);
      viteProcess.kill(signal || "SIGTERM");
    }
  });
}

function spawnVite(clientConfig, serverInfo) {
  const viteBin = resolveViteCommand(rootDir);
  const viteEnv = applyDevEnvironment({ ...process.env });
  viteEnv.LUC_DEV_WEB = "1";
  viteEnv.LUC_DEV_WEB_CLIENT_PORT = clientConfig.serverPort;
  viteEnv.LUC_DEV_WEB_API_BASE_URL = clientConfig.apiBaseUrl;
  viteEnv.LUC_DEV_WEB_SERVER_URL = `http://127.0.0.1:${serverInfo.port}`;
  viteEnv.LUC_DEV_WEB_SERVER_TOKEN = serverInfo.token;
  delete viteEnv.ELECTRON_RUN_AS_NODE;

  viteProcess = spawn(viteBin, [
    "--config",
    path.join(rootDir, "vite.config.ts"),
    "--host",
    "127.0.0.1",
  ], {
    cwd: rootDir,
    env: viteEnv,
    shell: process.platform === "win32",
    stdio: "inherit",
  });

  viteProcess.on("exit", (code, signal) => {
    if (!shuttingDown && isChildAlive(serverProcess)) {
      log(`Vite exited (${signal || code}); stopping server`);
      serverProcess.kill(signal || "SIGTERM");
    }
  });
}

function shutdown(signal = "SIGTERM") {
  if (shuttingDown) return;
  shuttingDown = true;
  if (isChildAlive(viteProcess)) viteProcess.kill(signal);
  if (isChildAlive(serverProcess)) serverProcess.kill(signal);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
if (process.platform === "win32") {
  process.on("SIGBREAK", () => shutdown("SIGBREAK"));
}

try {
  spawnServer();
  const serverInfo = await waitForServerInfo();
  const clientConfig = buildDevWebClientConfig(serverInfo);
  spawnVite(clientConfig, serverInfo);
  log(`open ${buildDevWebPreviewUrl()}`);
} catch (err) {
  shutdown();
  console.error(`[dev-web] ${err?.stack || err?.message || String(err)}`);
  process.exitCode = 1;
}
