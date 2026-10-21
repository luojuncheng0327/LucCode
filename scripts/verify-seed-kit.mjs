#!/usr/bin/env node
/**
 * scripts/verify-seed-kit.mjs — 嵌入前验证：fail-closed 校验一份 seed 四件套
 *
 * 插在 build:server 与 electron-builder 之间（package.json 的 pack/dist/
 * dist:win/dist:linux 脚本链）。build-server-artifact.mjs 的 packDualKindSeed
 * 在签名后已经对"它自己刚写的这份 manifest"做过一次 verify（构建期就证明
 * 这颗 seed 能被最终产物验证通过），但那次自验只证明"这次调用内部自洽"，
 * 不能挡住这类事故：
 * - dist-server-artifact/{os}-{arch}/ 目录残留了上一次构建（甚至别的平台）
 *   的陈旧文件，某个步骤被跳过导致没有重新生成
 * - manifest 文件名带的平台限定（seed-train-<platform>-<arch>.json）跟它
 *   实际落地的目录不是同一个平台——四个 CI 平台 job 各产一份同名旧文件、
 *   内容互不相同（各自的 server 条目、各自的 releasedAt）的问题正是本次
 *   改动要消除的歧义，这里补一道独立于打包流程的复核
 * - artifacts.*.sha256/size 记录的是构建当时的归档字节，跟 electron-builder
 *   即将打进安装包的、此刻磁盘上的归档字节不是同一份
 *
 * 只做只读校验，不写入任何文件；任一不符收集进 errors 数组、一次性列出，
 * 不在第一个问题上就 fail-fast（构建机上一次运行看到全部问题，不用重复
 * 触发再等一轮构建）。
 *
 * Usage:
 *   node scripts/verify-seed-kit.mjs [platform] [arch]
 * 不传参数时默认 process.platform / process.arch（本地 pack/dist 系列脚本
 * 都是给当前宿主机平台打包，不做交叉编译）。
 */
import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { fileURLToPath, pathToFileURL } from "url";

import { resolveBuildKeyset, seedManifestFileName } from "./build-server-artifact.mjs";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const manifestModule = require("../shared/artifact-core/manifest.cjs");
const activation = require("../shared/artifact-core/activation.cjs");

/**
 * electron-builder 的 ${os} 变量：darwin→"mac"、win32→"win"、linux→"linux"。
 * 与 scripts/build-server.mjs 的 osDirName 是同一份约定（未共享导出，两处
 * 各自维护，历史上 build-server.mjs 也是这样内联的）。
 * @param {string} platform
 * @returns {string}
 */
function osDirNameFor(platform) {
  return platform === "darwin" ? "mac" : platform === "win32" ? "win" : platform;
}

/**
 * 校验一个已归档条目（server 或 renderer）：文件存在 + sha256/size 与
 * manifest 记录一致。
 * @param {{artifactOutDir: string, label: string, entry: {path: string, sha256: string, size: number}}} opts
 * @returns {Promise<string[]>} errors（空数组表示通过）
 */
async function checkArchiveEntry({ artifactOutDir, label, entry }) {
  const errors = [];
  const archivePath = path.join(artifactOutDir, entry.path);
  if (!fs.existsSync(archivePath)) {
    errors.push(`${label}: archive referenced by manifest is missing: ${entry.path} (expected at ${archivePath})`);
    return errors;
  }
  const actualSha256 = await activation.sha256File(archivePath);
  const actualSize = fs.statSync(archivePath).size;
  if (actualSha256 !== entry.sha256) {
    errors.push(`${label}: sha256 mismatch for ${entry.path} — manifest=${entry.sha256} actual=${actualSha256}`);
  }
  if (actualSize !== entry.size) {
    errors.push(`${label}: size mismatch for ${entry.path} — manifest=${entry.size} actual=${actualSize}`);
  }
  return errors;
}

/**
 * 校验 dist-server-artifact/{os}-{arch}/ 下的 seed 四件套，fail-closed。
 * 收集全部问题而非在第一个问题上就短路，返回值供调用方统一决定退出码。
 * @param {{artifactOutDir: string, platformArch: string, keyset: Array<{keyId: string, publicKey: string}>}} opts
 * @returns {Promise<{ok: boolean, errors: string[]}>}
 */
export async function verifySeedKit({ artifactOutDir, platformArch, keyset }) {
  const errors = [];
  const manifestFileName = seedManifestFileName(platformArch);
  const manifestPath = path.join(artifactOutDir, manifestFileName);
  const sigPath = `${manifestPath}.sig`;

  if (!fs.existsSync(manifestPath)) {
    errors.push(`manifest missing: ${manifestPath}`);
    return { ok: false, errors };
  }
  if (!fs.existsSync(sigPath)) {
    errors.push(`signature missing: ${sigPath}`);
    return { ok: false, errors };
  }

  const manifestBytes = fs.readFileSync(manifestPath);
  const sigBytes = fs.readFileSync(sigPath);

  let manifest;
  try {
    manifest = manifestModule.parseManifest(manifestBytes);
  } catch (err) {
    errors.push(`manifest failed structural validation: ${err.message}`);
    return { ok: false, errors }; // 结构都不合法，往下比对没有意义
  }

  // ── 1. Ed25519 验签（pinned keyset）── 跟内容/文件名检查相互独立，
  // 一项失败不影响另外两项继续跑，全部列出。
  try {
    manifestModule.verifyManifest(manifestBytes, sigBytes, keyset);
  } catch (err) {
    errors.push(`signature verification failed: ${err.message}`);
  }

  // ── 2. manifest 平台键与目录平台一致 ──
  const serverEntry = manifest.artifacts && manifest.artifacts.server && manifest.artifacts.server[platformArch];
  if (!serverEntry) {
    const knownKeys = manifest.artifacts && manifest.artifacts.server ? Object.keys(manifest.artifacts.server) : [];
    errors.push(
      `manifest carries no artifacts.server["${platformArch}"] entry (found: ${knownKeys.join(", ") || "none"}) — `
        + `${manifestFileName} lives in a directory for ${platformArch}`,
    );
  } else {
    errors.push(...(await checkArchiveEntry({ artifactOutDir, label: `artifacts.server["${platformArch}"]`, entry: serverEntry })));
  }

  // ── 3. renderer 条目同理（平台无关，只做 sha256/size 比对）──
  const rendererEntry = manifest.artifacts && manifest.artifacts.renderer;
  if (!rendererEntry) {
    errors.push("manifest carries no artifacts.renderer entry");
  } else {
    errors.push(...(await checkArchiveEntry({ artifactOutDir, label: "artifacts.renderer", entry: rendererEntry })));
  }

  return { ok: errors.length === 0, errors };
}

async function main() {
  const platform = process.argv[2] || process.platform;
  const arch = process.argv[3] || process.arch;
  const platformArch = `${platform}-${arch}`;
  const osDirName = osDirNameFor(platform);
  const artifactOutDir = path.join(ROOT, "dist-server-artifact", `${osDirName}-${arch}`);

  const { keysetPath, keyset } = resolveBuildKeyset(process.env);
  if (keysetPath) {
    console.log(`[verify-seed-kit] using LUC_SIGN_KEYSET override: ${keysetPath}`);
  }

  console.log(`[verify-seed-kit] verifying ${artifactOutDir} (platformArch=${platformArch})...`);
  const { ok, errors } = await verifySeedKit({ artifactOutDir, platformArch, keyset });

  if (!ok) {
    console.error(`[verify-seed-kit] FAILED — ${errors.length} problem(s):`);
    for (const err of errors) {
      console.error(`  - ${err}`);
    }
    process.exit(1);
  }

  console.log(`[verify-seed-kit] OK — seed kit at ${artifactOutDir} matches its manifest and verifies against the pinned keyset.`);
}

// CLI entry — only runs main() when invoked directly (`node scripts/verify-seed-kit.mjs`),
// not when imported by tests as a library (matches the module's dual role: exported
// `verifySeedKit` is the tested unit, `main` is the package.json script-chain wrapper).
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error(`[verify-seed-kit] unexpected error: ${err.stack || err.message}`);
    process.exit(1);
  });
}
