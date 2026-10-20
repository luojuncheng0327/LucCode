#!/usr/bin/env node
/**
 * download-mingit.js — CI 用，下载官方 MinGit 到 vendor/mingit/
 *
 * Windows 打包前运行：node scripts/download-mingit.js
 * electron-builder 的 extraResources 会把 vendor/mingit/ 打进安装包的 resources/git/
 *
 * MinGit 是 Git for Windows 面向嵌入应用的非交互发行版：
 *   - 含 cmd/git.exe、mingw64/bin/git.exe、SSH/HTTPS remote、credential helpers
 *   - 含 usr/bin/sh.exe（bash 以 POSIX/sh 模式运行）与常用 coreutils
 *   - 不含 bash.exe / Git Bash 交互层 / Perl / Tcl-Tk
 * 体积与文件数远小于 PortableGit（约 367 个文件 / 94MB），无需再做裁剪。
 * 下载版本与 SHA-256 固定在本文件中；必需 runtime 文件缺失时构建立即失败。
 */

import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  ARCHIVE_PATH,
  MINGIT_SHA256,
  MINGIT_URL,
  MINGIT_VERSION,
  ROOT,
  VENDOR_DIR,
  assertRuntimeComplete,
  hasMinGitRuntime,
  verifySha256,
} from "./mingit-runtime.js";

function extractMinGitArchive() {
  fs.mkdirSync(VENDOR_DIR, { recursive: true });

  if (process.platform === "win32") {
    // Windows 10 1803+ 自带 bsdtar，可直接解 zip
    execFileSync("tar.exe", ["-xf", ARCHIVE_PATH, "-C", VENDOR_DIR], {
      stdio: "inherit",
      windowsHide: true,
    });
    return;
  }

  for (const [command, args] of [
    ["unzip", ["-q", "-o", ARCHIVE_PATH, "-d", VENDOR_DIR]],
    ["tar", ["-xf", ARCHIVE_PATH, "-C", VENDOR_DIR]],
  ]) {
    try {
      execFileSync(command, args, { stdio: "inherit" });
      return;
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
  }
  throw new Error("extracting MinGit on non-Windows hosts requires unzip or bsdtar");
}

async function main() {
  // 已存在且完整则跳过
  if (hasMinGitRuntime(VENDOR_DIR)) {
    console.log(`[download-mingit] MinGit ${MINGIT_VERSION} already present, skipping.`);
    return;
  }

  fs.mkdirSync(path.join(ROOT, "vendor"), { recursive: true });

  console.log(`[download-mingit] Downloading MinGit ${MINGIT_VERSION}...`);
  execFileSync("curl", ["--fail", "-L", "-o", ARCHIVE_PATH, MINGIT_URL], { stdio: "inherit" });
  verifySha256(ARCHIVE_PATH, MINGIT_SHA256);

  console.log("[download-mingit] Extracting...");
  extractMinGitArchive();

  fs.unlinkSync(ARCHIVE_PATH);

  assertRuntimeComplete(VENDOR_DIR);

  console.log(`[download-mingit] MinGit ${MINGIT_VERSION} ready at ${VENDOR_DIR}`);
}

const isDirectRun = process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  main().catch((err) => {
    console.error("[download-mingit] Failed:", err.message);
    process.exit(1);
  });
}
