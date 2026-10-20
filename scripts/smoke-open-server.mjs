#!/usr/bin/env node
/**
 * smoke-open-server.mjs — spawn-and-verify smoke test for the open
 * composition build produced by scripts/build-server-open.mjs.
 *
 * Positive direction: spawns the built open-composition server (via its
 * packaged Node runtime + bootstrap.js, the same two files the shell/cmd
 * wrapper execs into) under a throwaway LUC_HOME, waits for it to bind and
 * publish server-info.json, then makes one authenticated loopback HTTP
 * request to `/api/server/identity` and asserts a 200 with the expected
 * shape. This is the actual proof the open build boots and serves traffic
 * — scripts/build-server-open.mjs's whitelist assertion only proves the
 * build didn't *read* anything closed, not that the result *runs*.
 *
 * Negative direction: temporarily removes one required runtime-asset file
 * from the built tree (lib/config.example.yaml — read synchronously during
 * first-run agent seeding, before any HTTP readiness), spawns the same way,
 * and asserts the process fails fast and attributably (non-zero exit,
 * stderr names the missing path) rather than silently limping up. The file
 * is restored in a `finally` regardless of outcome.
 *
 * Usage: node scripts/smoke-open-server.mjs [platform] [arch]
 * (defaults to the current process's platform/arch, matching
 * scripts/build-server-open.mjs's own argv convention)
 */
import fs from "fs";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

export function resolveOpenServerDir({ rootDir, platform, arch }) {
  const osDirName = platform === "darwin" ? "mac" : platform === "win32" ? "win" : platform;
  return path.join(rootDir, "dist-server-open", `${osDirName}-${arch}`);
}

function nodeBinPath(serverDir, isWin) {
  return path.join(serverDir, isWin ? "luc-server.exe" : "node");
}

function waitForFile(filePath, { timeoutMs, intervalMs = 200 }) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (fs.existsSync(filePath)) {
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error(`timed out after ${timeoutMs}ms waiting for ${filePath}`));
        return;
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

function waitForExit(child, { timeoutMs }) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timed out after ${timeoutMs}ms waiting for process exit`));
    }, timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

async function terminateChild(child, { timeoutMs = 10_000 } = {}) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  try {
    await waitForExit(child, { timeoutMs });
  } catch {
    child.kill("SIGKILL");
    await waitForExit(child, { timeoutMs: 5_000 }).catch(() => {});
  }
}

function spawnOpenServer({ serverDir, isWin, lucHome, extraEnv = {} }) {
  const bin = nodeBinPath(serverDir, isWin);
  if (!fs.existsSync(bin)) {
    throw new Error(`[smoke-open-server] packaged Node runtime not found at ${bin} — run npm run build:server:open first`);
  }
  const bootstrapPath = path.join(serverDir, "bootstrap.js");
  if (!fs.existsSync(bootstrapPath)) {
    throw new Error(`[smoke-open-server] bootstrap.js not found at ${bootstrapPath}`);
  }

  let stderrBuf = "";
  let stdoutBuf = "";
  const child = spawn(bin, [bootstrapPath], {
    cwd: serverDir,
    env: {
      ...process.env,
      LUC_ROOT: serverDir,
      LUC_SERVER_ENTRY: path.join(serverDir, "bundle", "index.js"),
      LUC_HOME: lucHome,
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => { stdoutBuf += chunk.toString(); });
  child.stderr.on("data", (chunk) => { stderrBuf += chunk.toString(); });

  return {
    child,
    getStdout: () => stdoutBuf,
    getStderr: () => stderrBuf,
  };
}

/**
 * Positive smoke: boot the open build, hit /api/server/identity with the
 * loopback token, assert 200 + expected shape, shut down cleanly.
 */
export async function runPositiveSmoke({ rootDir = ROOT, platform = process.platform, arch = process.arch } = {}) {
  const serverDir = resolveOpenServerDir({ rootDir, platform, arch });
  const isWin = platform === "win32";
  if (!fs.existsSync(serverDir)) {
    throw new Error(`[smoke-open-server] open server build not found at ${serverDir} — run npm run build:server:open first`);
  }

  const lucHome = fs.mkdtempSync(path.join(os.tmpdir(), "luc-open-smoke-"));
  const { child, getStderr } = spawnOpenServer({ serverDir, isWin, lucHome });

  try {
    const serverInfoPath = path.join(lucHome, "server-info.json");
    await Promise.race([
      waitForFile(serverInfoPath, { timeoutMs: 60_000 }),
      waitForExit(child, { timeoutMs: 60_000 }).then(({ code, signal }) => {
        throw new Error(
          `[smoke-open-server] server exited before publishing server-info.json (code=${code}, signal=${signal})\n--- stderr ---\n${getStderr()}`,
        );
      }),
    ]);

    let serverInfo;
    // A fresh write can be observed mid-flush; retry the parse briefly.
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        serverInfo = JSON.parse(fs.readFileSync(serverInfoPath, "utf-8"));
        break;
      } catch (err) {
        if (attempt === 9) throw new Error(`[smoke-open-server] could not parse server-info.json: ${err.message}`);
        await new Promise((r) => setTimeout(r, 200));
      }
    }

    const { port, host, token } = serverInfo;
    if (!port || !token) {
      throw new Error(`[smoke-open-server] server-info.json missing port/token: ${JSON.stringify(serverInfo)}`);
    }
    const url = `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}/api/server/identity`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status !== 200) {
      const body = await res.text().catch(() => "<unreadable>");
      throw new Error(`[smoke-open-server] GET ${url} returned ${res.status}, expected 200. body: ${body}`);
    }
    const body = await res.json();
    if (typeof body.serverProtocol !== "number" && typeof body.serverProtocol !== "string") {
      throw new Error(`[smoke-open-server] /api/server/identity response missing serverProtocol field: ${JSON.stringify(body)}`);
    }

    return { ok: true, url, status: res.status, body };
  } finally {
    await terminateChild(child);
    fs.rmSync(lucHome, { recursive: true, force: true });
  }
}

/**
 * Negative smoke: remove a required runtime-asset file (lib/config.example.yaml,
 * read synchronously during first-run seeding), spawn the same way, and
 * assert the process fails fast and attributably instead of starting
 * cleanly. Restores the file in `finally` regardless of outcome.
 */
export async function runNegativeSmoke({ rootDir = ROOT, platform = process.platform, arch = process.arch } = {}) {
  const serverDir = resolveOpenServerDir({ rootDir, platform, arch });
  const isWin = platform === "win32";
  if (!fs.existsSync(serverDir)) {
    throw new Error(`[smoke-open-server] open server build not found at ${serverDir} — run npm run build:server:open first`);
  }

  const targetFile = path.join(serverDir, "lib", "config.example.yaml");
  const backupFile = `${targetFile}.smoke-backup`;
  if (!fs.existsSync(targetFile)) {
    throw new Error(`[smoke-open-server] negative smoke fixture missing: ${targetFile} (expected the positive build to have produced it)`);
  }
  fs.renameSync(targetFile, backupFile);

  const lucHome = fs.mkdtempSync(path.join(os.tmpdir(), "luc-open-smoke-neg-"));
  const { child, getStderr } = spawnOpenServer({ serverDir, isWin, lucHome });

  try {
    const serverInfoPath = path.join(lucHome, "server-info.json");
    const outcome = await Promise.race([
      waitForExit(child, { timeoutMs: 60_000 }).then((result) => ({ kind: "exit", ...result })),
      waitForFile(serverInfoPath, { timeoutMs: 60_000 }).then(() => ({ kind: "listening" })),
    ]);

    if (outcome.kind === "listening") {
      throw new Error(
        "[smoke-open-server] negative smoke FAILED: server started and published server-info.json despite "
          + "a missing required runtime asset (lib/config.example.yaml) — this is a silent fallback, not attributable failure.",
      );
    }

    const stderr = getStderr();
    if (outcome.code === 0) {
      throw new Error(`[smoke-open-server] negative smoke FAILED: process exited 0 despite missing lib/config.example.yaml.\n--- stderr ---\n${stderr}`);
    }
    if (!stderr.includes("config.example.yaml")) {
      throw new Error(
        `[smoke-open-server] negative smoke FAILED: process exited non-zero (code=${outcome.code}) but stderr does not `
          + `attribute the failure to the missing file:\n--- stderr ---\n${stderr}`,
      );
    }

    return { ok: true, exitCode: outcome.code, stderrExcerpt: stderr.slice(0, 2000) };
  } finally {
    await terminateChild(child);
    fs.rmSync(lucHome, { recursive: true, force: true });
    if (fs.existsSync(backupFile)) fs.renameSync(backupFile, targetFile);
  }
}

async function main() {
  const platform = process.argv[2] || process.platform;
  const arch = process.argv[3] || process.arch;

  console.log(`[smoke-open-server] positive smoke: ${platform}-${arch}...`);
  const positive = await runPositiveSmoke({ platform, arch });
  console.log(`[smoke-open-server] positive smoke PASSED: GET ${positive.url} -> ${positive.status}, serverProtocol=${positive.body.serverProtocol}`);

  console.log(`[smoke-open-server] negative smoke: ${platform}-${arch}...`);
  const negative = await runNegativeSmoke({ platform, arch });
  console.log(`[smoke-open-server] negative smoke PASSED: exit code=${negative.exitCode}, attributable stderr confirmed`);

  console.log("[smoke-open-server] all smoke checks passed");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
