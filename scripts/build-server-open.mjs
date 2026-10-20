#!/usr/bin/env node
/**
 * build-server-open.mjs — 构建开源 composition server 分发包
 *
 * 与 scripts/build-server.mjs（full/closed 产品打包器）共用
 * scripts/build-server-phases.mjs 的全部打包原语，但只喂开源专属参数：
 *   - Vite bundle entry = server/main-open.ts（open composition 薄入口，
 *     只调用 startServer({})，不挂载任何闭集产品路由）
 *   - 数据文件清单 = export-manifest.json 白名单 / build/cli-runtime-closure.json
 *     runtime-asset 证据都覆盖到的 lib/ 子集（不含 pinned.example.md ——
 *     没有任何运行时读取证据，见 build/cli-runtime-closure.json 的
 *     runtime-asset census）
 *   - 不复制 locales（同样没有 runtime-asset 证据；lib/i18n.ts 在目录缺失时
 *     捕获异常、回退空翻译表，不是启动必需项）
 *   - 不复制 plugins/、skills2set/、品牌资产、renderer 静态树（这些是 full
 *     专属：本文件从不 import build-server-artifact.mjs，全程不读
 *     LUC_SIGN_KEY）
 *
 * 动手前先做白名单断言（assertOpenBuildInputsWhitelisted）：本构建即将读取
 * 的每一个仓库源路径，必须命中 export-manifest.json 的显式白名单，或命中
 * build/cli-runtime-closure.json 的 runtime-asset 证据。命中不了直接报错、
 * 列出违规路径——这是"从一棵干净的开源导出树也能构建"的机械等价物，不需要
 * 真的先删仓库文件再验证。
 *
 * 产出结构：
 *   dist-server-open/{platform}-{arch}/
 *     luc-server / luc      ← shell wrapper（LUC_SERVER_ENTRY 指向 open bundle）
 *     node                    ← Node.js runtime（与 full 相同的目标版本）
 *     bundle/
 *       index.js              ← server/main-open.ts 的 Vite bundle
 *       cli.js                ← cli/entry.ts 的 esbuild bundle（CLI 全量开源，无需拆分）
 *     lib/                    ← 白名单覆盖的数据文件子集
 *     package.json / package-lock.json / node_modules/  ← external deps
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  applyPlatformPackageTrim,
  buildCliBundle,
  buildViteServerBundle,
  copyServerBootstrap,
  copyServerDataFiles,
  finalizeServerPackageJsonVersion,
  prepareNodeRuntime,
  pruneServerNodeModulesViaNft,
  resolveAndInstallExternalServerDeps,
  writeServerWrapperScripts,
} from "./build-server-phases.mjs";
import { RUNTIME_ASSETS } from "./compute-cli-closure.mjs";
import { readExportManifest } from "./lint-open-boundary.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// 开源产物的 Vite bundle 入口：open composition 薄入口，见 server/main-open.ts。
export const OPEN_BUNDLE_ENTRY = "server/main-open.ts";

// lib/ 数据文件清单：LIB_DATA_GLOBS ∩ build/cli-runtime-closure.json 的
// runtime-asset 证据。与 scripts/build-server.mjs 的 LIB_DATA_GLOBS 相比，
// 少了 pinned.example.md —— 该文件只被 lib/tools/pinned-memory.ts 这类运行时
// 工具惰性读取，census 的启动期声明式资产扫描没有证据；见文件头注释。
export const OPEN_LIB_DATA_FILES = [
  "known-models.json",
  "known-model-fallbacks.json",
  "default-models.json",
  "config.example.yaml",
  "identity.example.md",
  "agents.example.md",
];
export const OPEN_LIB_TEMPLATE_DIRS = [
  "identity-templates",
  "agents-templates",
  "agents-public-templates",
  "yuan",
];

/**
 * 本构建即将从仓库直接读取的源路径（package.json 之外，其余都要么是 lib/
 * 数据文件/目录，要么是 bundle/CLI 入口）。每一项必须命中 export-manifest.json
 * 白名单，或命中 build/cli-runtime-closure.json 的 runtime-asset 证据
 * （RUNTIME_ASSETS 数组，来自 scripts/compute-cli-closure.mjs，与生成
 * build/cli-runtime-closure.json 时用的是同一份声明）。
 */
export function declaredOpenBuildInputPaths() {
  return [
    OPEN_BUNDLE_ENTRY,
    "cli/entry.ts",
    "server/bootstrap.ts",
    "package.json",
    ...OPEN_LIB_DATA_FILES.map((f) => `lib/${f}`),
    ...OPEN_LIB_TEMPLATE_DIRS.map((d) => `lib/${d}`),
  ];
}

function normalizeManifestEntry(entry) {
  return entry.endsWith("/") ? entry.slice(0, -1) : entry;
}

/**
 * Fail-closed 白名单断言：declaredPaths 里的每个仓库相对路径，必须命中
 * export-manifest.json 的显式白名单，或命中 RUNTIME_ASSETS 的
 * runtime-asset 证据。两者都命不中就抛错，列出全部违规路径——不静默跳过、
 * 不自动降级、不"顺手"放行。
 *
 * @param {{ rootDir: string, declaredPaths: string[] }} params
 * @returns {{ whitelistedCount: number }}
 */
export function assertOpenBuildInputsWhitelisted({ rootDir, declaredPaths }) {
  const manifest = readExportManifest({ rootDir });
  const manifestSet = new Set(manifest.paths.map(normalizeManifestEntry));
  const runtimeAssetSet = new Set(RUNTIME_ASSETS.map((asset) => asset.path));

  const violations = declaredPaths.filter((declaredPath) => {
    const normalized = normalizeManifestEntry(declaredPath);
    return !manifestSet.has(normalized) && !runtimeAssetSet.has(normalized);
  });

  if (violations.length > 0) {
    throw new Error(
      "[build-server-open] refusing to build: the following repo source path(s) are neither in "
        + "export-manifest.json's whitelist nor covered by build/cli-runtime-closure.json's "
        + "runtime-asset evidence (scripts/compute-cli-closure.mjs's RUNTIME_ASSETS):\n"
        + violations.map((v) => `  - ${v}`).join("\n"),
    );
  }

  return { whitelistedCount: declaredPaths.length };
}

async function main() {
  const platform = process.argv[2] || process.platform;
  const arch = process.argv[3] || process.arch;
  const osDirName = platform === "darwin" ? "mac" : platform === "win32" ? "win" : platform;
  const outDir = path.join(ROOT, "dist-server-open", `${osDirName}-${arch}`);

  console.log(`[build-server-open] Building open composition for ${platform}-${arch}...`);

  assertOpenBuildInputsWhitelisted({ rootDir: ROOT, declaredPaths: declaredOpenBuildInputPaths() });
  console.log("[build-server-open] whitelist assertion passed");

  // ── 0. 清理 ──
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  // ── 1. Node.js runtime（与 full 相同的目标版本/校验和）──
  const { isWin, cachedNpmCli, runWithTargetNode } = prepareNodeRuntime({
    rootDir: ROOT,
    platform,
    arch,
    outDir,
  });

  // ── 2. Vite + CLI bundle（entry = server/main-open.ts）──
  // vite.config.server.js's own `outDir: "dist-server-bundle"` is a fixed
  // config value (not parameterized — full and open builds never run
  // concurrently, so reusing the same transient intermediate directory is
  // safe); this must match that literal, not invent a second one.
  const viteBundleDir = path.join(ROOT, "dist-server-bundle");
  const bundleOutDir = path.join(outDir, "bundle");
  buildViteServerBundle({ rootDir: ROOT, viteBundleDir, bundleOutDir, entry: OPEN_BUNDLE_ENTRY });
  buildCliBundle({ rootDir: ROOT, bundleOutDir });
  copyServerBootstrap({ rootDir: ROOT, outDir });

  // ── 3. 复制运行时数据文件（白名单/证据覆盖的子集，不含 locales）──
  copyServerDataFiles({
    rootDir: ROOT,
    outDir,
    libFiles: OPEN_LIB_DATA_FILES,
    libDirs: OPEN_LIB_TEMPLATE_DIRS,
    extraDirs: [],
  });
  console.log("[build-server-open] resource files copied");

  // ── 4-6. External dependencies 派生 + 安装 + 校验（不含内置插件包依赖：开源产物不带 plugins/）──
  const { externalPkg, rootPkg } = await resolveAndInstallExternalServerDeps({
    rootDir: ROOT,
    outDir,
    bundleOutDir,
    platform,
    arch,
    isWin,
    runWithTargetNode,
    cachedNpmCli,
    extraPackageNames: [],
  });

  // ── 7. @vercel/nft 追踪 ──
  await pruneServerNodeModulesViaNft({
    outDir,
    nftRoots: ["bundle/index.js"],
    externalPackageNames: Object.keys(externalPkg.dependencies),
    runWithTargetNode,
  });

  // ── 8. 平台裁剪 + node_modules 死重清理 ──
  applyPlatformPackageTrim({ outDir, platform, arch });

  // ── 9. 更新 package.json ──
  finalizeServerPackageJsonVersion({ outDir, version: rootPkg.version });

  // ── 10. Wrapper 脚本 ──
  writeServerWrapperScripts({ outDir, isWin });

  console.log("[build-server-open] Done!");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
