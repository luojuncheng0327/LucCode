#!/usr/bin/env node
// 诊断 write-restricted token 下 PowerShell 启动行为的独立矩阵脚本。
// 用法: node scripts/diagnose-win32-powershell.mjs --helper <path> [--json out.json] [--cwd <dir>]
//
// 在 write-restricted token 沙盒下，逐一隔离 shell / TEMP 重定向 / 桌面模式 /
// stdin 处理这四个维度，跑一个小矩阵，观察哪一格挂起、哪一格正常退出。
// 只在 Windows 上有意义：非 Windows 平台可以做语法检查，但 spawn 会立即失败。
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { buildWin32SandboxHelperArgs } from "../lib/sandbox/win32-sandbox-helper.ts";

const CELL_TIMEOUT_MS = 25_000;
const HELPER_TIMEOUT_MS = CELL_TIMEOUT_MS - 5_000;

const SHELLS = ["powershell.exe", "pwsh.exe"];
const TEMP_MODES = ["default", "redirect"];
const DESKTOP_MODES = ["private", "current"];
const STDIN_MODES = ["closed", "ignore"];
const PS_ARGS = ["-NoProfile", "-NonInteractive", "-Command", "[Console]::Out.Write('ok')"];

export function argValue(flag, argv = process.argv.slice(2)) {
  const index = argv.indexOf(flag);
  if (index === -1 || index + 1 >= argv.length) return null;
  return argv[index + 1];
}

// helper 的 CreateProcessAsUserW 把 executable 直接当 lpApplicationName，不做
// PATH 搜索（desktop/native/LucWindowsSandboxHelper/main.cpp:1841）。生产链路
// (lib/sandbox/win32-exec.ts:631 firstPathResult / :847 resolvePowerShellExecutable)
// 在 Node 侧先用 `where` 解析出绝对路径再传给 helper；此脚本此前直接传裸的
// "powershell.exe"/"pwsh.exe"，导致每一格都在 CreateProcessAsUserW 阶段就以
// ERROR_FILE_NOT_FOUND 失败，矩阵从未进入真实实验。这里与生产语义对齐。
export function resolveShellAbsolutePath(commandName) {
  try {
    const result = spawnSync("where.exe", [commandName], {
      encoding: "utf-8",
      timeout: 5000,
      windowsHide: true,
    });
    if (result.status === 0 && result.stdout) {
      return result.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean) || null;
    }
  } catch {}
  return null;
}

// spawn 一格：按 stdinMode 决定 stdin 处理方式，计时，收集 stdout/stderr，
// 超时后用 taskkill /T /F 连同子进程树一并终止，避免残留挂起进程。
export function spawnCell(helperPath, helperArgs, env, cell) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const child = spawn(helperPath, helperArgs, {
      env,
      stdio: [cell.stdinMode === "ignore" ? "ignore" : "pipe", "pipe", "pipe"],
    });

    if (cell.stdinMode === "closed" && child.stdin) {
      // 生产路径一致：不保持 stdin 管道打开，立即关闭
      child.stdin.end();
    }

    const killTimer = setTimeout(() => {
      timedOut = true;
      if (typeof child.pid === "number") {
        spawn("taskkill", ["/T", "/F", "/PID", String(child.pid)], { stdio: "ignore" });
      }
    }, CELL_TIMEOUT_MS);

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      resolve(result);
    };

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.on("close", (exitCode) => {
      finish({
        cell,
        exitCode,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
        timedOut,
      });
    });

    child.on("error", (error) => {
      finish({
        cell,
        exitCode: null,
        stdout,
        stderr: `${stderr}\n[spawn error] ${error?.message || String(error)}`,
        durationMs: Date.now() - startedAt,
        timedOut,
      });
    });
  });
}

async function runCell({ helperPath, writableRoot, cwd, cell }) {
  const cellTemp = path.join(writableRoot, `t-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const env = { ...process.env };
  if (cell.tempMode === "redirect") {
    // Write-restricted tokens can include Everyone as a restricting SID while
    // the user's TEMP DACL does not grant Everyone write access. That can make
    // the secondary WRITE_RESTRICTED check fail during CLR/PowerShell startup.
    // Redirecting TEMP to the helper's writable root tests that condition.
    mkdirSync(cellTemp, { recursive: true });
    env.TEMP = cellTemp;
    env.TMP = cellTemp;
  }

  const helperArgs = buildWin32SandboxHelperArgs({
    cwd,
    timeoutMs: HELPER_TIMEOUT_MS,
    desktopMode: cell.desktopMode,
    grants: { writePaths: [writableRoot] },
    executable: cell.resolvedPath,
    args: PS_ARGS,
  });

  return spawnCell(helperPath, helperArgs, env, cell);
}

export async function runMatrix({ helperPath, cwd = process.cwd() } = {}) {
  if (!helperPath) throw new Error("diagnose-win32-powershell requires --helper <path>");
  const writableRoot = mkdtempSync(path.join(tmpdir(), "luc-ps-diag-"));

  const resolvedShells = new Map(SHELLS.map((shell) => [shell, resolveShellAbsolutePath(shell)]));

  const results = [];
  for (const shell of SHELLS) {
    const resolvedPath = resolvedShells.get(shell) || null;
    for (const tempMode of TEMP_MODES) {
      for (const desktopMode of DESKTOP_MODES) {
        for (const stdinMode of STDIN_MODES) {
          const cell = { shell, tempMode, desktopMode, stdinMode, resolvedPath };
          if (!resolvedPath) {
            results.push({ cell, status: "shell-not-found" });
            continue;
          }
          // eslint-disable-next-line no-await-in-loop -- 矩阵格必须串行跑，避免互相争抢私有桌面/受限令牌资源
          const result = await runCell({ helperPath, writableRoot, cwd, cell });
          results.push(result);
        }
      }
    }
  }
  return results;
}

export function run(argv = process.argv.slice(2)) {
  const helperPath = argValue("--helper", argv);
  const jsonOut = argValue("--json", argv);
  const cwd = argValue("--cwd", argv) || process.cwd();

  return runMatrix({ helperPath, cwd }).then((results) => {
    const payload = { version: 1, generatedAt: new Date().toISOString(), results };
    const serialized = JSON.stringify(payload, null, 2);
    if (jsonOut) {
      writeFileSync(jsonOut, serialized, "utf8");
    }
    console.log(serialized);
    return payload;
  });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  run().catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exit(1);
  });
}
