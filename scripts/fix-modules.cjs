/**
 * fix-modules.cjs — electron-builder afterPack 钩子
 *
 * 职责（启用双 artifact 管线后）：
 * 1. 校验 extraResources 落地的 seed/ 四件套齐全（renderer 归档 + server 归档 +
 *    manifest + .sig），归档文件名以 manifest 内容为准 —— extraResources 配置
 *    被误改时在构建机上炸，不留到用户首启。
 * 2. 补全 electron-builder 依赖分析漏掉的 app asar 生产依赖，并清理
 *    node_modules/.bin（绝对 symlink 会让 codesign 报错）。
 *
 * 历史：后台更新路径 之前这里还负责把 dist-server 的 node_modules 整树复制进
 * Resources/server/（extraResources 会过滤 node_modules）。server 树现在
 * 以单个签名归档进箱、首启在 LUC_HOME 解压，该机器整块删除。双 artifact 路径 起
 * renderer 树也拆出 asar，走同一份 seed manifest、同一条校验逻辑。
 */

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

/**
 * 目录内定位平台化命名的 seed manifest（seed-train-<platform>-<arch>.json，
 * 见 scripts/build-server-artifact.mjs 的 seedManifestFileName /
 * desktop/src/shared/artifact-boot.cjs 的同名函数）。afterPack 阶段的
 * platform/arch 是 electron-builder 自己的命名习惯（"mac"/"windows"/"linux"），
 * 跟 manifest 文件名里 process.platform 风格的 "darwin"/"win32"/"linux" 对不
 * 上，与其在这里重新维护一份映射表，不如像归档文件名（带版本号，
 * 同样不可硬编码）一样用前缀/后缀扫描定位——这里只做"文件在不在"的构建期
 * 存在性检查，真正的平台一致性校验由 scripts/verify-seed-kit.mjs 在
 * electron-builder 之前做。
 * @param {string} seedDir
 * @returns {string|null}
 */
function findSeedManifestPath(seedDir) {
  let entries;
  try {
    entries = fs.readdirSync(seedDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const names = entries
    .filter((entry) => entry.isFile() && entry.name.startsWith("seed-train-") && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();
  return names.length > 0 ? path.join(seedDir, names[0]) : null;
}

/**
 * 校验 Resources/seed/ 携带完整 seed 四件套（renderer 归档 + server 归档 +
 * manifest + .sig，启用双 artifact 管线后安装包不再只带 server）。只做存在性
 * 与结构检查——签名校验是运行时首启的职责（同一代码路径），这里挡的是
 * 构建配置错误。
 * @param {string} resourcesDir
 */
function assertSeedResourcesReady(resourcesDir) {
  const seedDir = path.join(resourcesDir, "seed");
  const manifestPath = findSeedManifestPath(seedDir);
  if (!manifestPath) {
    throw new Error(
      `[fix-modules] seed manifest missing from packaged resources: ${path.join(seedDir, "seed-train-<platform>-<arch>.json")}. `
        + "Run npm run build:server (with LUC_SIGN_KEY) before electron-builder.",
    );
  }
  const sigPath = `${manifestPath}.sig`;
  if (!fs.existsSync(sigPath)) {
    throw new Error(`[fix-modules] seed manifest signature missing: ${sigPath}`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

  const serverEntries = Object.values(manifest?.artifacts?.server || {});
  if (serverEntries.length === 0) {
    throw new Error(
      `[fix-modules] seed manifest carries no server artifact entries: ${manifestPath}`,
    );
  }
  for (const entry of serverEntries) {
    const archivePath = path.join(seedDir, entry.path);
    if (!fs.existsSync(archivePath)) {
      throw new Error(
        `[fix-modules] seed archive referenced by the manifest is missing: ${entry.path} (expected at ${archivePath})`,
      );
    }
  }

  const rendererEntry = manifest?.artifacts?.renderer;
  if (!rendererEntry) {
    throw new Error(
      `[fix-modules] seed manifest carries no renderer artifact entry: ${manifestPath}`,
    );
  }
  const rendererArchivePath = path.join(seedDir, rendererEntry.path);
  if (!fs.existsSync(rendererArchivePath)) {
    throw new Error(
      `[fix-modules] renderer seed archive referenced by the manifest is missing: ${rendererEntry.path} (expected at ${rendererArchivePath})`,
    );
  }
}

function removeNodeModulesBinDirs(nodeModulesDir) {
  let removedDirs = 0;

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const full = path.join(dir, entry.name);
      if (entry.name === ".bin" && path.basename(dir) === "node_modules") {
        fs.rmSync(full, { recursive: true, force: true });
        removedDirs++;
        continue;
      }

      walk(full);
    }
  }

  if (fs.existsSync(nodeModulesDir)) {
    walk(nodeModulesDir);
  }

  return removedDirs;
}

exports.default = async function (context) {
  const platformName = context.packager.platform.name;
  const arch = context.arch === 1 ? "x64" : context.arch === 3 ? "arm64" : "x64";
  const appDir = platformName === "mac"
    ? path.join(context.appOutDir, context.packager.appInfo.productFilename + ".app",
        "Contents", "Resources", "app")
    : path.join(context.appOutDir, "resources", "app");
  const distModules = path.join(appDir, "node_modules");
  const localModules = path.resolve(__dirname, "..", "node_modules");

  // ── server runtime deps 重建 ──
  // electron-builder 的 extraResources 会过滤 node_modules，
  // 这里手动把 build-server 产出的 node_modules 复制到 server 目录
  const resourcesDir = platformName === "mac"
    ? path.join(context.appOutDir, context.packager.appInfo.productFilename + ".app",
        "Contents", "Resources")
    : path.join(context.appOutDir, "resources");
  if (platformName === "mac") {
    const computerUseHelper = path.join(resourcesDir, "computer-use", "macos", "luc-computer-use-helper");
    if (!fs.existsSync(computerUseHelper)) {
      throw new Error(
        `[fix-modules] Computer Use helper missing from macOS app resources: ${computerUseHelper}. ` +
        "Run scripts/build-computer-use-helper.mjs before electron-builder.",
      );
    }
    const mode = fs.statSync(computerUseHelper).mode;
    if ((mode & 0o111) === 0) {
      throw new Error(`[fix-modules] Computer Use helper is not executable: ${computerUseHelper}`);
    }
  }
  // ── seed 四件套校验（renderer + server 树以签名归档进箱，双 artifact 管线）──
  assertSeedResourcesReady(resourcesDir);
  console.log("[fix-modules] seed resources verified (renderer archive + server archive + manifest + sig)");

  if (!fs.existsSync(distModules)) return;

  // 获取生产依赖树
  let prodDeps;
  try {
    const raw = execSync("npm ls --all --json --omit=dev", {
      cwd: path.resolve(__dirname, ".."),
      maxBuffer: 20 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    });
    prodDeps = JSON.parse(raw);
  } catch (e) {
    // npm ls 在有 peer dep 警告时也会 exit 1，但 stdout 仍有数据
    try {
      prodDeps = JSON.parse(e.stdout?.toString() || "{}");
    } catch {
      console.log("[fix-modules] 无法解析依赖树，跳过");
      return;
    }
  }

  function collectDeps(obj, set = new Set()) {
    if (!obj || !obj.dependencies) return set;
    for (const [name, info] of Object.entries(obj.dependencies)) {
      set.add(name);
      collectDeps(info, set);
    }
    return set;
  }

  const allProd = collectDeps(prodDeps);
  let copied = 0;

  // 含 native binding 的包（需要平台匹配编译），补全时额外警告
  const NATIVE_PACKAGES = new Set(["bufferutil", "utf-8-validate"]);

  for (const dep of allProd) {
    const distPath = path.join(distModules, dep);
    const localPath = path.join(localModules, dep);
    if (!fs.existsSync(distPath) && fs.existsSync(localPath)) {
      if (NATIVE_PACKAGES.has(dep)) {
        console.warn(`[fix-modules] ⚠ 补全 native 包 "${dep}"（确保已针对当前平台编译）`);
      }
      fs.cpSync(localPath, distPath, { recursive: true });
      copied++;
    }
  }

  if (copied > 0) {
    console.log(`[fix-modules] 补全了 ${copied} 个缺失的生产依赖`);
  }

  // 清理 node_modules/.bin。生产运行时不依赖包管理器生成的 CLI 链接，
  // 而绝对 symlink 会让 macOS codesign 报 invalid destination for symbolic link。
  const removedBinDirs = removeNodeModulesBinDirs(distModules);
  if (removedBinDirs > 0) {
    console.log(`[fix-modules] 清理 app node_modules 中 ${removedBinDirs} 个 .bin 目录`);
  }
};

exports.assertSeedResourcesReady = assertSeedResourcesReady;
exports.findSeedManifestPath = findSeedManifestPath;
exports.removeNodeModulesBinDirs = removeNodeModulesBinDirs;
