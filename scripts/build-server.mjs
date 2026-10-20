#!/usr/bin/env node
/**
 * build-server.mjs — 构建 server 独立分发包（full/closed 产品）
 *
 * 策略：Vite bundle + 外部依赖 npm install + Node.js runtime
 * Vite 把 server/core/lib/shared/hub 源码打成几个 chunk，
 * 只有 native addon 和无法 bundle 的 SDK 作为 external 走目标 Node 的 npm。
 *
 * 关键设计：用目标 Node.js runtime 来装依赖和编译 native addon，
 * 确保 better-sqlite3 的 ABI 跟运行时一致（系统 Node 版本可能不同）。
 * Vite build 用系统 Node 跑（构建时工具，不涉及 ABI）。
 *
 * 打包机制（Node runtime 获取、Vite/esbuild bundle、数据文件复制、external
 * deps 派生与安装、nft prune、平台裁剪、wrapper 生成）全部来自
 * scripts/build-server-phases.mjs 的参数化原语，与
 * scripts/build-server-open.mjs（开源 composition 打包器）共用同一套函数。
 * 本文件在原语之上追加 full 专属阶段：skills2set、内置 plugins、品牌/renderer
 * 资产、签名 seed 装箱——这些阶段不属于开源产物。
 *
 * 产出结构：
 *   dist-server/{platform}-{arch}/
 *     luc-server             ← shell wrapper（设置 LUC_ROOT 并启动）
 *     luc                    ← shell wrapper（server-first CLI）
 *     node                    ← Node.js runtime
 *     bundle/                 ← Vite bundle 产出
 *       index.js              ← 入口（~750KB）
 *       cli.js                ← server-first CLI 入口
 *     lib/                    ← 数据文件（非源码，运行时 fromRoot() 读取）
 *       known-models.json
 *       known-model-fallbacks.json
 *       default-models.json
 *       config.example.yaml
 *       identity.example.md
 *       agents.example.md
 *       pinned.example.md
 *       identity-templates/
 *       agents-templates/
 *       agents-public-templates/
 *       yuan/
 *     desktop/src/assets/     ← server 运行时读取的默认头像、角色卡背、Yuan 图标
 *     desktop/src/locales/    ← i18n 资源
 *     desktop/dist-renderer/  ← PWA 静态入口、hashed assets、themes（/mobile/* 由 server 读取）
 *     skills2set/             ← 技能包
 *     package.json            ← external deps + version（node_modules 解析 + 运行时版本读取）
 *     package-lock.json       ← npm install 生成，记录 external 安装结果
 *     node_modules/           ← 仅 external deps（~50 packages）
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
import {
  collectBundledPluginNftRoots,
  collectBundledPluginPackageDependencies,
  copyBundledPluginRuntimeDependencies,
} from "./build-server-plugin-runtime-deps.mjs";
import { copyServerRuntimeAssets } from "./build-server-runtime-assets.mjs";
import { packDualKindSeed } from "./build-server-artifact.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const platform = process.argv[2] || process.platform;
const arch = process.argv[3] || process.arch;
// electron-builder 的 ${os} 变量：darwin→"mac"、win32→"win"、linux→"linux"
const osDirName = platform === "darwin" ? "mac" : platform === "win32" ? "win" : platform;
const outDir = path.join(ROOT, "dist-server", `${osDirName}-${arch}`);

console.log(`[build-server] Building for ${platform}-${arch}...`);

// ── 0. 清理 ──
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

// ── 1. Node.js runtime ──
const { isWin, cachedNpmCli, runWithTargetNode } = prepareNodeRuntime({
  rootDir: ROOT,
  platform,
  arch,
  outDir,
});

// ── 2. Vite + CLI bundle（entry = server/main-full.ts，vite.config.server.js 的默认值）──
const viteBundleDir = path.join(ROOT, "dist-server-bundle");
const bundleOutDir = path.join(outDir, "bundle");
buildViteServerBundle({ rootDir: ROOT, viteBundleDir, bundleOutDir });
buildCliBundle({ rootDir: ROOT, bundleOutDir });
copyServerBootstrap({ rootDir: ROOT, outDir });

// ── 3. 复制运行时数据文件 ──
// 这些文件由 fromRoot() / fs.readFileSync() 在运行时读取，无法打进 bundle
const LIB_DATA_GLOBS = [
  "known-models.json",
  "known-model-fallbacks.json",
  "default-models.json",
  "config.example.yaml",
  "identity.example.md",
  "agents.example.md",
  "pinned.example.md",
];
const LIB_TEMPLATE_DIRS = [
  "identity-templates",
  "agents-templates",
  "agents-public-templates",
  "yuan",
];
copyServerDataFiles({
  rootDir: ROOT,
  outDir,
  libFiles: LIB_DATA_GLOBS,
  libDirs: LIB_TEMPLATE_DIRS,
  // i18n locales（lib/i18n.ts 通过 fromRoot("desktop","src","locales") 引用）
  extraDirs: [{ relSource: path.join("desktop", "src", "locales") }],
});

// skills2set（运行时复制到用户数据目录）——full 专属，开源产物不携带内容包
const skillsSrc = path.join(ROOT, "skills2set");
if (fs.existsSync(skillsSrc)) {
  fs.cpSync(skillsSrc, path.join(outDir, "skills2set"), { recursive: true });
  console.log("[build-server]   skills2set/");
}

// Theme CSS：不再单独复制 desktop/src/themes/。
// dist-renderer/themes/ 由 copyServerRuntimeAssets 复制（内容完全一致），
// server theme.css 端点有 fallback：先试 src/themes，未命中时自动走 dist-renderer/themes。
// 省去一份 ~7MB 的重复 CSS。

// 角色卡导入/导出预览由 server 读取默认头像、卡背和 Yuan 图标。
// PWA /mobile/* 静态文件也由独立 server 进程读取。
// 打包模式下 LUC_ROOT 指向 resources/server，不能依赖 renderer asar 里的 assets。
// full 专属：品牌资产 + renderer 静态树，开源产物不携带。
for (const copiedAsset of copyServerRuntimeAssets({ rootDir: ROOT, outDir })) {
  console.log(`[build-server]   ${copiedAsset}`);
}

// 系统插件（内嵌到 app，运行时 fromRoot("plugins") 读取）——full 专属
const pluginsSrc = path.join(ROOT, "plugins");
if (fs.existsSync(pluginsSrc)) {
  fs.cpSync(pluginsSrc, path.join(outDir, "plugins"), { recursive: true });
  console.log("[build-server]   plugins/");
}

// 内置插件以源码形式动态 import。插件跨出 plugins/ 引用宿主侧共享运行期模块时，
// 这些模块必须按原相对路径落到 packaged server root，否则开发环境和安装包会分裂。
for (const copiedDependency of await copyBundledPluginRuntimeDependencies({ rootDir: ROOT, outDir })) {
  console.log(`[build-server]   ${copiedDependency}`);
}

console.log("[build-server] resource files copied");

// ── 4-6. External dependencies 派生 + 安装 + 校验 ──
// pluginPackageDeps：内置插件源码 import 的 npm 包，必须补进 external 依赖集，
// 否则打包产物的根 node_modules 解析不到插件运行时需要的包。开源产物不携带
// plugins/，因此 build-server-open.mjs 不传这份清单。
const pluginPackageDeps = await collectBundledPluginPackageDependencies({ rootDir: ROOT });
const pluginNftRoots = await collectBundledPluginNftRoots({ rootDir: ROOT });
const { externalPkg, rootPkg } = await resolveAndInstallExternalServerDeps({
  rootDir: ROOT,
  outDir,
  bundleOutDir,
  platform,
  arch,
  isWin,
  runWithTargetNode,
  cachedNpmCli,
  extraPackageNames: pluginPackageDeps,
});

// ── 7. @vercel/nft 追踪：只保留运行时实际需要的文件 ──
await pruneServerNodeModulesViaNft({
  outDir,
  // Bundled plugins remain as source and are discovered dynamically. Making
  // every plugin/host runtime source an nft root preserves the dependency
  // closure of packages such as markdown-it without protecting all of
  // node_modules from pruning.
  nftRoots: ["bundle/index.js", ...pluginNftRoots],
  externalPackageNames: Object.keys(externalPkg.dependencies),
  runWithTargetNode,
});

// ── 8. 平台裁剪 + node_modules 死重清理 ──
applyPlatformPackageTrim({ outDir, platform, arch });

// ── 9. 更新 package.json ──
// fromRoot("package.json") 在运行时读取版本号
finalizeServerPackageJsonVersion({ outDir, version: rootPkg.version });

// ── 10. Wrapper 脚本 ──
writeServerWrapperScripts({ outDir, isWin });

// ── 11. server + renderer 树 → 一份签名 seed 归档（双 artifact 管线）──
// ⚠️ 顺序铁律：先签名，后装箱。Apple notary
// 会递归解包 tar.gz 校验箱内每个 Mach-O，而 electron-builder 阶段的签名看
// 不进归档内部；packDualKindSeed 在 packTree 之前对 server 树内 Mach-O 做
// 签名（本地 ad-hoc codesign；æ­£å¼ CI 换 Developer ID 时必须保持同一顺序——
// 把 Developer ID 签名步骤插到 packDualKindSeed 之前或替换其签名器实现，
// 绝不允许"先装箱再签外壳"）。这一步必须是 build-server 的最后一步：server
// 树在装箱后不允许再被任何步骤触碰。renderer 树（desktop/dist-renderer/）
// 由 build:renderer 在本脚本之前产出（package.json 的 build:client 组合脚本
// 保证顺序）；纯 web 静态资源，不需要签名，只做"不含 Mach-O"的断言。
// LUC_SIGN_KEY 未设置时这里硬报错（安装包必须携带签名 seed）；本地验证用
// artifact-keygen.mjs 生成一次性密钥对，配 LUC_SIGN_KEYSET 指向其 keyset。
// full 专属：开源产物不装箱、不签名、全程不读 LUC_SIGN_KEY。
await packDualKindSeed({
  outDir,
  rendererDistDir: path.join(ROOT, "desktop", "dist-renderer"),
  rendererArtifactOutDir: path.join(ROOT, "dist-renderer-artifact"),
  artifactOutDir: path.join(ROOT, "dist-server-artifact", `${osDirName}-${arch}`),
  version: rootPkg.version,
  platform,
  arch,
});

console.log("[build-server] Done!");
