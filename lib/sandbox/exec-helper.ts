/**
 * exec-helper.js — 共用的 spawn + stream + timeout 逻辑
 *
 * seatbelt.js 和 bwrap.js 都通过这个函数执行沙盒化的命令。
 * 返回值契约严格匹配 Pi SDK defaultBashOperations.exec：
 *   - 正常退出 → resolve({ exitCode })
 *   - abort    → reject(new Error("aborted"))
 *   - timeout  → reject(new Error("timeout:X"))
 */

import { spawn } from "child_process";
import { existsSync } from "fs";

const EXIT_STDIO_GRACE_MS = 100;

/**
 * @param {string} cmd  可执行文件路径（sandbox-exec / bwrap）
 * @param {string[]} args  argv 数组
 * @param {object} opts
 * @param {string} opts.cwd
 * @param {object} [opts.env]
 * @param {(data: Buffer) => void} opts.onData
 * @param {(data: Buffer) => void} [opts.onStdout] stdout 专用回调；提供后不再复制到 onData
 * @param {(data: Buffer) => void} [opts.onStderr] stderr 专用回调；提供后不再复制到 onData
 * @param {AbortSignal} [opts.signal]
 * @param {number} [opts.timeout]  watchdog 秒
 * @param {number} [opts.timeoutErrorValue] timeout 错误里报告的业务秒数
 * @param {'tree'|'process'} [opts.killMode] process 只终止直接子进程；用于持有私有 Job 的 helper
 * @param {number} [opts.exitStdioGraceMs] 直接子进程退出后等待 stdio 收尾的上限
 * @param {boolean} [opts.windowsVerbatimArguments] Windows: 不再对 args 做 MSVCRT 转义重建，
 *   原样拼接。调用方（如 win32-exec 的 cmd 路径）已经手工构造好完整的 /c 载荷字符串，
 *   Node 默认的转义规则会破坏内嵌引号；仅在调用方已知 args 是最终字面量时传 true。
 * @returns {Promise<{exitCode: number|null}>}
 */
export function spawnAndStream(cmd, args, {
  cwd,
  env,
  onData,
  onStdout = onData,
  onStderr = onData,
  signal,
  timeout,
  timeoutErrorValue = timeout,
  killMode = "tree",
  exitStdioGraceMs = EXIT_STDIO_GRACE_MS,
  windowsVerbatimArguments = false,
}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      env: env ?? process.env,
      // Windows: detached 设 DETACHED_PROCESS，会移除控制台，
      // MSYS2/Git Bash 在无控制台环境下可能无法正确初始化导致空输出。
      // Windows 的 killTree 用 taskkill，不依赖进程组，所以不需要 detached。
      detached: process.platform !== "win32",
      windowsHide: true,
      windowsVerbatimArguments,
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);

    let timedOut = false;
    let settled = false;
    let exited = false;
    let exitCode = null;
    let postExitTimer;
    let stdoutEnded = child.stdout === null;
    let stderrEnded = child.stderr === null;

    // timeout：标记 + 杀进程，close 里再 reject
    let timer;
    if (timeout != null && timeout > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        killSpawnedProcess(child, killMode);
      }, timeout * 1000);
    }

    // abort signal：杀进程，close 里再 reject
    const onAbort = () => killSpawnedProcess(child, killMode);
    if (signal) {
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    const cleanup = () => {
      clearTimeout(timer);
      clearTimeout(postExitTimer);
      signal?.removeEventListener("abort", onAbort);
      child.removeListener("close", onClose);
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      child.stdout?.removeListener("data", onStdout);
      child.stderr?.removeListener("data", onStderr);
      child.stdout?.removeListener("end", onStdoutEnd);
      child.stderr?.removeListener("end", onStderrEnd);
    };

    const finalize = (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      child.stdout?.destroy();
      child.stderr?.destroy();

      // 匹配 Pi SDK 契约：abort 和 timeout 必须 reject
      if (signal?.aborted) {
        reject(new Error("aborted"));
        return;
      }
      if (timedOut) {
        reject(new Error(`timeout:${timeoutErrorValue}`));
        return;
      }
      resolve({ exitCode: code });
    };

    const maybeFinalizeAfterExit = () => {
      if (!exited || settled) return;
      if (stdoutEnded && stderrEnded) {
        finalize(exitCode);
      }
    };

    const onStdoutEnd = () => {
      stdoutEnded = true;
      maybeFinalizeAfterExit();
    };

    const onStderrEnd = () => {
      stderrEnded = true;
      maybeFinalizeAfterExit();
    };

    const onExit = (code) => {
      exited = true;
      exitCode = code;
      maybeFinalizeAfterExit();
      if (!settled) {
        // 后台孙进程可能继承 stdout/stderr pipe。直接子进程退出后只给
        // stdio 一个短暂收尾窗口，避免常驻后台进程把工具调用永久拖住。
        postExitTimer = setTimeout(() => finalize(code), exitStdioGraceMs);
      }
    };

    const onClose = (code) => {
      finalize(code);
    };

    const onError = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(enrichSpawnError(err, cwd));
    };

    child.stdout?.once("end", onStdoutEnd);
    child.stderr?.once("end", onStderrEnd);
    child.once("exit", onExit);
    child.once("close", onClose);
    child.once("error", onError);
  });
}

function killSpawnedProcess(child, killMode) {
  if (!child?.pid) return;
  if (killMode === "process") {
    try { child.kill("SIGKILL"); } catch {}
    return;
  }
  killTree(child.pid);
}

function killTree(pid) {
  if (!pid) return;
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {}
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try { process.kill(pid, "SIGKILL"); } catch {}
  }
}

function enrichSpawnError(err, cwd) {
  if (!err || err.code !== "ENOENT" || !cwd) return err;
  try {
    if (existsSync(cwd)) return err;
  } catch {
    return err;
  }
  err.cwdMissing = true;
  err.message = `${err.message}. Likely cause: working directory does not exist: ${cwd}. ` +
    "The executable path may be fine.";
  return err;
}
