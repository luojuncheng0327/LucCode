import fs from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import {
  buildWindowsSandboxHelper,
  windowsSandboxHelperOutputDir,
} from "./build-windows-sandbox-helper.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function ensureWindowsSandboxHelper({
  rootDir = path.resolve(__dirname, ".."),
  platform = process.platform,
  arch = process.arch,
  existsSync = fs.existsSync,
  statSync = fs.statSync,
  build = buildWindowsSandboxHelper,
} = {}) {
  if (platform !== "win32") {
    return { skipped: true, built: false };
  }

  const target = path.join(
    windowsSandboxHelperOutputDir({ rootDir, arch }),
    "luc-win-sandbox.exe",
  );
  const inputs = [
    path.join(rootDir, "desktop", "native", "LucWindowsSandboxHelper", "main.cpp"),
    path.join(rootDir, "scripts", "build-windows-sandbox-helper.mjs"),
  ];
  const targetMtime = existsSync(target) ? statSync(target).mtimeMs : -1;
  const newestInputMtime = Math.max(...inputs.map((input) => (
    existsSync(input) ? statSync(input).mtimeMs : Number.POSITIVE_INFINITY
  )));

  if (targetMtime >= newestInputMtime) {
    console.log(`[windows-sandbox-helper] using existing ${target}`);
    return { skipped: false, built: false, target };
  }

  const result = build({ rootDir, platform, arch });
  return { ...result, built: !result.skipped, target: result.target || target };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    ensureWindowsSandboxHelper();
  } catch (err) {
    console.error(err?.stack || err?.message || String(err));
    process.exitCode = 1;
  }
}
