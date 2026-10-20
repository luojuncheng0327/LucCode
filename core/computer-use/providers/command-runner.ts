import { spawn } from "child_process";

interface SpawnOptions {
  env?: Record<string, string>;
  windowsHide?: boolean;
  detached?: boolean;
  stdio?: any;
  unref?: boolean;
}

interface RunOptions {
  env?: Record<string, string>;
  windowsHide?: boolean;
  timeoutMs?: number;
  stdin?: any;
}

export function createCommandRunner({ spawnImpl = spawn } = {}) {
  return {
    spawn(command: string, args: string[] = [], options: SpawnOptions = {}) {
      const child = spawnImpl(command, args, {
        env: options.env || process.env,
        windowsHide: options.windowsHide !== false,
        detached: options.detached !== false,
        stdio: options.stdio || "ignore",
      });
      if (options.unref !== false && typeof child.unref === "function") {
        child.unref();
      }
      return child;
    },

    run(command: string, args: string[] = [], options: RunOptions = {}) {
      return new Promise((resolve, reject) => {
        const child = spawnImpl(command, args, {
          env: options.env || process.env,
          windowsHide: options.windowsHide !== false,
          stdio: ["pipe", "pipe", "pipe"],
        });

        let stdout = "";
        let stderr = "";
        let settled = false;
        let timer = null;

        const finish = (fn, value) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          fn(value);
        };

        if (options.timeoutMs) {
          timer = setTimeout(() => {
            try { child.kill("SIGKILL"); } catch {}
            const err: Error & { code?: string } = new Error(`Command timed out after ${options.timeoutMs}ms`);
            err.code = "ETIMEDOUT";
            finish(reject, err);
          }, options.timeoutMs);
        }

        child.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
        child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
        child.on("error", (err) => finish(reject, err));
        child.on("close", (exitCode, signal) => {
          finish(resolve, { stdout, stderr, exitCode, signal });
        });

        if (options.stdin != null) {
          child.stdin?.write(String(options.stdin));
        }
        child.stdin?.end();
      });
    },
  };
}
