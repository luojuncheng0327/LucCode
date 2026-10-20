/**
 * build-server-artifact.mjs — 双 artifact 管线：server + renderer 树 → 一份签名 seed 归档
 *
 * 被 build-server.mjs 在 server 产出树完全就绪、renderer 产出树（desktop/dist-renderer/，
 * 由 build:renderer 先行产出）也已就绪后调用，产出安装包 extraResources 携带的
 * seed 四件套：
 *   dist-server-artifact/{os}-{arch}/
 *     server-<version>-<platform>-<arch>.tar.gz    ← packTree(dist-server 树) 产物
 *     renderer-<version>.tar.gz                    ← packTree(dist-renderer 树) 产物（平台无关，
 *                                                       先落 dist-renderer-artifact/ 一份共享，
 *                                                       再复制进本目录跟 server 归档同箱）
 *     seed-train-<platform>-<arch>.json            ← schema-1 train-0 manifest，
 *                                                       同时携带 artifacts.renderer 与 artifacts.server。
 *                                                       文件名按平台限定（seedManifestFileName）：CI 四个
 *                                                       平台 job 各产一份内容不同的 manifest（各自的
 *                                                       server 条目、各自的 releasedAt），同名会让人无法
 *                                                       从文件名判断来源，平台化命名消除这个歧义
 *     seed-train-<platform>-<arch>.json.sig        ← 对 manifest 精确字节的 ed25519 detached 签名
 *
 * 历史：签名 seed 管线 只有 server 一种 kind，manifest 由 packServerArtifact 内联生成。
 * 启用双 artifact 管线后 renderer 也拆出 asar 走同一条 artifact-core 激活代码路径
 * schema 只要求 artifacts 至少携带一个已知 kind；但安装包自己的构建策略是
 * "一个 train 发布完整两件套"，这是发布流水线约束，
 * 不是 schema 约束）。因此 manifest 生成从"打包 server 归档"这一步里搬出来，
 * 挪到"两个归档都打完之后"的编排步骤——ONE 签名 manifest，覆盖两种 kind。
 *
 * ⚠️ 签名顺序铁律：为满足 Apple notarization，
 * Apple notary service 会递归解包内嵌归档（含 tar.gz）并校验其中每一个
 * Mach-O —— 箱内出现未签名二进制会让整个 app 公证失败。Mach-O 签名是嵌入
 * 字节、能原样穿过 ustar 打包，但今天的签名发生在 electron-builder 遍历阶段，
 * 它看不进归档内部。因此：**先签名，后装箱** —— 对 server 树内二进制的一切
 * 签名（本地 ad-hoc；æ­£å¼ CI 的 Developer ID 同理）都必须发生在 packTree 之前。
 * release workflow 接 CI 时，Developer ID 签名步骤必须插在本模块 packServerArchive 调用
 * 之前，这个顺序没有任何例外。renderer 树是纯 web 静态资源，不含 Mach-O，
 * 因此不需要签名步骤，只需要一个"确实不含 Mach-O"的断言（防止未来某个
 * native 依赖被误拷进 dist-renderer 时静默把未签名二进制带进箱）。
 *
 * 签名密钥纪律：
 * - `LUC_SIGN_KEY=<private-key-path>` 必须设置；未设置时硬报错，绝不静默
 *   跳过或降级（一个没有签名 seed 的安装包是坏的安装包）。
 * - `LUC_SIGN_KEYSET=<path>` 是构建期输入：替换"打进当次构建"的 keyset
 *   文件（默认 repo 的 shared/artifact-core/pinned-keyset.json）。这不是
 *   运行期校验旁路——运行时永远读被打包进 bundle 的 keyset
 *  （vite.config.main.js 在 bundle 期做同一替换）。正式发版不设置此变量。
 * - 签名后立即用"将被打包的 keyset"做一次 verify：构建期就证明这颗 seed
 *   能被最终产物验证通过，密钥/keyset 不匹配在构建机上炸，不留到用户首启。
 */
import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const ustar = require("../shared/artifact-core/ustar.cjs");
const activation = require("../shared/artifact-core/activation.cjs");
const manifestModule = require("../shared/artifact-core/manifest.cjs");
const { loadPinnedKeyset } = require("../shared/artifact-core/keyset.cjs");
const { PRELOAD_API_VERSION, SERVER_PROTOCOL_VERSION } = require("../shared/contract-versions.cjs");
const { assertOfficePdfFontAssets } = require("../desktop/src/office-pdf-fonts.cjs");

/**
 * Per-platform seed manifest file name. Each CI platform-arch job produces
 * its own seed kit under dist-server-artifact/{os}-{arch}/ with DIFFERENT
 * manifest content (different artifacts.server entry, different
 * releasedAt) — the file name must disambiguate which platform-arch a
 * given seed-train-*.json/.sig actually describes. `platformArch` is the
 * exact `${platform}-${arch}` convention already used as the
 * `artifacts.server` object key (see buildSeedManifest below) and at boot
 * time (`${process.platform}-${process.arch}`, desktop/main.cjs /
 * desktop/src/shared/artifact-boot.cjs) — one naming convention, reused
 * everywhere a platform-arch pair needs to become a string. Duplicated
 * (not imported) in artifact-boot.cjs: this file is an ESM build-time
 * script, that one ships inside the bundled CJS desktop app.
 * @param {string} platformArch
 * @returns {string}
 */
export function seedManifestFileName(platformArch) {
  return `seed-train-${platformArch}.json`;
}

// Mach-O magic numbers as they appear as the first 4 bytes on disk.
// 32/64-bit thin binaries in both byte orders, plus fat/universal headers.
const MACHO_MAGICS = new Set([
  0xfeedface, // MH_MAGIC (32-bit)
  0xcefaedfe, // MH_CIGAM
  0xfeedfacf, // MH_MAGIC_64
  0xcffaedfe, // MH_CIGAM_64
  0xcafebabe, // FAT_MAGIC
  0xbebafeca, // FAT_CIGAM
  0xcafebabf, // FAT_MAGIC_64
  0xbfbafeca, // FAT_CIGAM_64
]);

/**
 * @param {Buffer} buf - first bytes of a file
 * @returns {boolean}
 */
export function isMachOBuffer(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return false;
  return MACHO_MAGICS.has(buf.readUInt32BE(0));
}

/**
 * Walks `rootDir` and returns every regular file whose leading bytes carry
 * a Mach-O magic (node binary, .node addons, spawn-helper 等). Magic-based
 * detection instead of extension lists so nothing signable slips through —
 * an unsigned Mach-O inside the seed fails notarization for the whole app.
 * @param {string} rootDir
 * @returns {string[]} absolute paths
 */
export function findMachOFiles(rootDir) {
  const found = [];
  const header = Buffer.alloc(4);

  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        let fd;
        try {
          fd = fs.openSync(full, "r");
          const bytesRead = fs.readSync(fd, header, 0, 4, 0);
          if (bytesRead === 4 && isMachOBuffer(header)) found.push(full);
        } finally {
          if (fd !== undefined) fs.closeSync(fd);
        }
      }
    }
  }

  walk(rootDir);
  return found;
}

/**
 * 组装单个文件的 codesign 参数（纯函数，供测试逐一断言）。双模式：
 * - identity 未设/为空 → ad-hoc `--sign - --force`（本地 install:local 现状，
 *   与 scripts/sign-local.cjs 同款，一字不变）。ad-hoc 不加 hardened runtime，
 *   因此也不需要 entitlements。
 * - identity 非空 → Developer ID 正式签名：identity + `--timestamp`
 *   （secure timestamp）+ `--force`（幂等重签）；`.node` addon 不加 hardened
 *   runtime，其余 Mach-O（node 可执行、spawn-helper 等）加 `--options runtime`，
 *   并且**必须**同时加 `--entitlements <entitlementsPath>`——arm64 macOS 严格
 *   执行 W^X，hardened runtime 二进制缺 com.apple.security.cs.allow-jit 时
 *   V8 无法申请可执行内存，node 启动即死于 CodeRange 虚拟内存保留失败。
 *   历史上这里"照抄旧实证流程、不加 entitlements"，产出的箱子能过公证但
 *   在 arm64 上完全无法运行；所以现在 hardened runtime 而 entitlementsPath
 *   缺失直接硬报错，禁止静默签出一个必然崩溃的二进制。
 *   不加 `--keychain`（identity 解析走 CI 已设好的 keychain 搜索列表，
 *   见 build.yml "Setup macOS signing keychain"）。
 * @param {{identity?: string, file: string, entitlementsPath?: string}} opts
 * @returns {string[]} codesign 的完整参数数组
 */
export function buildCodesignArgs({ identity, file, entitlementsPath }) {
  if (!identity) {
    return ["--sign", "-", "--force", file];
  }
  const hardenedRuntime = !file.endsWith(".node");
  if (hardenedRuntime && !entitlementsPath) {
    throw new Error(
      `[build-server] refusing to sign ${file} with hardened runtime but no entitlements file. `
        + "A runtime-flagged binary without com.apple.security.cs.allow-jit cannot start V8 on "
        + "arm64 macOS (CodeRange OOM crash at launch); pass entitlementsPath.",
    );
  }
  return [
    "--sign", identity,
    "--timestamp",
    "--force",
    ...(hardenedRuntime ? ["--options", "runtime", "--entitlements", entitlementsPath] : []),
    file,
  ];
}

/**
 * 默认 darwin 签名器：装箱前对树内每个 Mach-O 签名（顺序铁律见文件头注释）。
 * 签名模式由 `env.LUC_MACHO_SIGN_IDENTITY` 决定：CI（release workflow）由 build.yml 的
 * keychain 前置步骤导出 Developer ID 证书 identity；本地未设置 → ad-hoc，
 * 行为与之前完全一致。参数组装见 buildCodesignArgs。
 * @param {string} outDir
 * @param {(msg: string) => void} log
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} env
 */
async function defaultSignMachOFiles(outDir, log, env = process.env) {
  const identity = env.LUC_MACHO_SIGN_IDENTITY;
  // Developer ID 模式下 hardened runtime 文件必须携带 JIT entitlements
  //（缺了它 node 在 arm64 上启动即崩，见 buildCodesignArgs 注释）。plist
  // 缺失必须硬报错——静默退回"无 entitlements 签名"正是当初的事故。
  let entitlementsPath;
  if (identity) {
    entitlementsPath = path.join(ROOT, "build", "server-macho-entitlements.plist");
    if (!fs.existsSync(entitlementsPath)) {
      throw new Error(
        `[build-server] server Mach-O entitlements plist missing: ${entitlementsPath}. `
          + "Developer ID signing requires it (hardened runtime without allow-jit produces a "
          + "binary that crashes at launch on arm64 macOS); refusing to sign without it.",
      );
    }
  }
  const machoFiles = findMachOFiles(outDir);
  for (const file of machoFiles) {
    execFileSync("codesign", buildCodesignArgs({ identity, file, entitlementsPath }), { stdio: "pipe" });
  }
  const mode = identity ? "Developer ID (LUC_MACHO_SIGN_IDENTITY)" : "ad-hoc";
  log(`[build-server] seed: ${mode} signed ${machoFiles.length} Mach-O file(s) before packing`);
}

/**
 * 装箱前启动烟测（darwin）：实际运行一次树内签好名的 node 二进制，证明它
 * 能活着走完进程启动（V8 初始化会立刻暴露签名/entitlements 问题——缺
 * allow-jit 的 hardened 二进制在 arm64 上此刻就崩）。任何非零退出、信号、
 * spawn 失败都硬报错中止装箱：签坏的二进制永远不该进归档、上货架。
 *
 * 跨架构说明：CI 在 arm64 runner 上也构建 x64 箱子，这一步会经 Rosetta
 * 执行 x64 node——照跑，不做"跑不了就跳过"的分支（GitHub 的 macOS runner
 * 带 Rosetta；真跑不了就该 CI 红，人来处理，而不是放一个没验证过的箱子过去）。
 * @param {string} outDir - server 产出树根目录（node 二进制位于 `<outDir>/node`，
 *   与 build-server.mjs 复制 runtime 的落点一致）
 * @param {(msg: string) => void} log
 */
async function defaultSmokeTestNodeStartup(outDir, log) {
  const nodeBin = path.join(outDir, "node");
  try {
    execFileSync(nodeBin, ["-e", "process.exit(0)"], { stdio: "pipe", timeout: 30_000 });
  } catch (err) {
    const stderr = err?.stderr ? String(err.stderr).trim().slice(0, 2000) : "";
    const detail = err?.signal
      ? `killed by signal ${err.signal}`
      : err?.status != null
        ? `exit code ${err.status}`
        : `spawn failed: ${err?.message ?? err}`;
    throw new Error(
      `[build-server] signed node binary failed its startup smoke test (${detail}): ${nodeBin}. `
        + "Refusing to pack a binary that cannot start — this is exactly how a broken signature "
        + "(e.g. hardened runtime without JIT entitlements) would otherwise reach the shelf."
        + (stderr ? `\nstderr: ${stderr}` : ""),
    );
  }
  log("[build-server] seed: signed node binary passed the startup smoke test");
}

/**
 * 默认 manifest 签名器：走 scripts/artifact-sign.mjs（与 æ­£å¼ CI 用同一入口），
 * 在 manifest 旁写 `.sig`。
 * @param {{manifestPath: string, signKeyPath: string}} opts
 */
function defaultSignManifestFile({ manifestPath, signKeyPath }) {
  execFileSync(
    process.execPath,
    [path.join(ROOT, "scripts", "artifact-sign.mjs"), "--key", signKeyPath, "--file", manifestPath],
    { stdio: "pipe" },
  );
}

/**
 * 解析"打进当次构建"的 keyset：LUC_SIGN_KEYSET 覆盖文件，或 repo 默认
 * pinned keyset。覆盖文件缺失/畸形一律硬报错。
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} env
 * @returns {{keysetPath: string | null, keyset: Array<{keyId: string, publicKey: string}>}}
 */
export function resolveBuildKeyset(env) {
  const override = env.LUC_SIGN_KEYSET;
  if (!override) {
    return { keysetPath: null, keyset: loadPinnedKeyset() };
  }
  const keysetPath = path.resolve(override);
  if (!fs.existsSync(keysetPath)) {
    throw new Error(`[build-server] LUC_SIGN_KEYSET points at a missing file: ${keysetPath}`);
  }
  const value = JSON.parse(fs.readFileSync(keysetPath, "utf8"));
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((e) => e && typeof e.keyId === "string" && typeof e.publicKey === "string")
  ) {
    throw new Error(`[build-server] LUC_SIGN_KEYSET file must be a non-empty array of {keyId, publicKey}: ${keysetPath}`);
  }
  return { keysetPath, keyset: value };
}

/**
 * 校验签名密钥就位：LUC_SIGN_KEY 必须设置且指向真实文件。硬报错，绝不
 * 静默跳过或降级（一个没有签名 seed 的安装包是坏的安装包）。
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} env
 * @returns {string} signKeyPath
 */
function requireSignKeyPath(env) {
  const signKeyPath = env.LUC_SIGN_KEY;
  if (!signKeyPath) {
    throw new Error(
      "[build-server] LUC_SIGN_KEY is not set. The installer seed MUST be signed; "
        + "building an unsigned seed is not a thing. Set LUC_SIGN_KEY=<private-key-path> "
        + "(local validation: generate a throwaway pair with scripts/artifact-keygen.mjs "
        + "and point LUC_SIGN_KEYSET at its matching keyset file).",
    );
  }
  if (!fs.existsSync(signKeyPath)) {
    throw new Error(`[build-server] LUC_SIGN_KEY points at a missing file: ${signKeyPath}`);
  }
  return signKeyPath;
}

/**
 * 打包 server 树（sign-first-pack-second，铁律见文件头注释）。只负责归档本身，
 * 不生成/不签 manifest —— manifest 现在是"两个归档都打完之后"的编排步骤
 * （packDualKindSeed），因为它要同时描述 renderer 与 server 两个 kind。
 * @param {{
 *   outDir: string,
 *   artifactOutDir: string,
 *   version: string,
 *   platform: string,
 *   arch: string,
 *   env?: NodeJS.ProcessEnv | Record<string, string | undefined>,
 *   log?: (msg: string) => void,
 *   deps?: {
 *     signMachOFiles?: (outDir: string, log: (msg: string) => void, env: NodeJS.ProcessEnv | Record<string, string | undefined>) => Promise<void>,
 *     smokeTestNodeStartup?: (outDir: string, log: (msg: string) => void) => Promise<void>,
 *     packTree?: (srcDir: string, archivePath: string) => Promise<void>,
 *     sha256File?: (filePath: string) => Promise<string>,
 *     statSize?: (filePath: string) => number,
 *   },
 * }} opts
 * @returns {Promise<{archivePath: string, archiveName: string, sha256: string, size: number}>}
 */
export async function packServerArchive({ outDir, artifactOutDir, version, platform, arch, env = process.env, log = console.log, deps = {} }) {
  const {
    signMachOFiles = defaultSignMachOFiles,
    smokeTestNodeStartup = defaultSmokeTestNodeStartup,
    packTree = ustar.packTree,
    sha256File = activation.sha256File,
    statSize = (filePath) => fs.statSync(filePath).size,
  } = deps;

  // ── 先签名（铁律见文件头注释）：darwin 树内 Mach-O 装箱前必须带签名 ──
  // æ­£å¼ CI 的 Developer ID 签名同样必须发生在这一行语义位置之前/之处。
  // env 显式传参（不在签名器里抓 process.env），LUC_MACHO_SIGN_IDENTITY
  // 决定 ad-hoc / Developer ID 双模式，见 defaultSignMachOFiles。
  if (platform === "darwin") {
    await signMachOFiles(outDir, log, env);
    // ── 签完立刻启动烟测：实际跑一次签好名的 node，签坏的二进制在这里
    // 就地报错中止装箱，永远到不了货架（见 defaultSmokeTestNodeStartup）──
    await smokeTestNodeStartup(outDir, log);
  }

  // ── 后装箱：干净目录，绝不让上一次构建的残留文件混进这次的 seed ──
  fs.rmSync(artifactOutDir, { recursive: true, force: true });
  fs.mkdirSync(artifactOutDir, { recursive: true });
  const archiveName = `server-${version}-${platform}-${arch}.tar.gz`;
  const archivePath = path.join(artifactOutDir, archiveName);
  await packTree(outDir, archivePath);

  const sha256 = await sha256File(archivePath);
  const size = statSize(archivePath);
  log(`[build-server] seed: packed ${archiveName} → ${artifactOutDir}`);
  return { archivePath, archiveName, sha256, size };
}

/**
 * 打包 renderer 树（desktop/dist-renderer/ → renderer-<version>.tar.gz）。
 * 平台无关：输出到 `artifactOutDir`（建议 dist-renderer-artifact/ 顶层目录，
 * 不按 os-arch 分目录）。renderer 树是纯 web 静态资源，不该含任何 Mach-O ——
 * 断言这一点而不是静默放行，防止未来某个 native 依赖被误拷进
 * dist-renderer 时把未签名二进制悄悄带进箱（装箱后无法再签名，会在
 * notarization 阶段才炸，那时已经太晚）。
 * @param {{
 *   rendererDistDir: string,
 *   artifactOutDir: string,
 *   version: string,
 *   log?: (msg: string) => void,
 *   deps?: {
 *     findMachOFiles?: (dir: string) => string[],
 *     packTree?: (srcDir: string, archivePath: string) => Promise<void>,
 *     sha256File?: (filePath: string) => Promise<string>,
 *     statSize?: (filePath: string) => number,
 *   },
 * }} opts
 * @returns {Promise<{archivePath: string, archiveName: string, sha256: string, size: number}>}
 */
export async function packRendererArtifact({ rendererDistDir, artifactOutDir, version, log = console.log, deps = {} }) {
  const {
    findMachOFiles: findMachOFilesDep = findMachOFiles,
    packTree = ustar.packTree,
    sha256File = activation.sha256File,
    statSize = (filePath) => fs.statSync(filePath).size,
  } = deps;

  if (!fs.existsSync(rendererDistDir)) {
    throw new Error(
      `[build-server] renderer dist dir not found: ${rendererDistDir}. `
        + "Run npm run build:renderer (or build:client) before packing the renderer artifact.",
    );
  }

  // Office HTML→PDF helper resolves fonts from the activated renderer artifact.
  // Refuse to create a renderer box whose CSS or referenced font files are
  // incomplete: Chromium would otherwise silently print with fallback fonts.
  try {
    assertOfficePdfFontAssets({ themesDir: path.join(rendererDistDir, "themes") });
  } catch (err) {
    throw new Error(
      `[build-server] renderer Office PDF font assets are invalid: ${err?.message || err}`,
      { cause: err },
    );
  }

  // ── 装箱前断言：renderer 树不含 Mach-O（纯 web 静态资源，装箱后无法再签名）──
  const macho = findMachOFilesDep(rendererDistDir);
  if (macho.length > 0) {
    throw new Error(
      `[build-server] renderer dist dir unexpectedly contains ${macho.length} Mach-O file(s): `
        + `${macho.slice(0, 5).join(", ")}${macho.length > 5 ? ", ..." : ""}. `
        + "The renderer artifact must be pure web assets — refusing to pack an unsigned binary into an unsigned archive.",
    );
  }

  fs.rmSync(artifactOutDir, { recursive: true, force: true });
  fs.mkdirSync(artifactOutDir, { recursive: true });
  const archiveName = `renderer-${version}.tar.gz`;
  const archivePath = path.join(artifactOutDir, archiveName);
  await packTree(rendererDistDir, archivePath);

  const sha256 = await sha256File(archivePath);
  const size = statSize(archivePath);
  log(`[build-server] seed: packed ${archiveName} → ${artifactOutDir}`);
  return { archivePath, archiveName, sha256, size };
}

/**
 * 复用 CI 单点构建好的 renderer 归档字节，而不是在当前 job 里现场打包。
 *
 * 背景：renderer 归档（desktop/dist-renderer/ 树）是纯 web 静态资源，构建结果
 * 平台无关。但 packTree 在 tar 头里写入真实文件 mtime，四个平台 runner 各自
 * 现场打包会产生"内容相同、字节不同、sha256 不同"的四份归档——GitHub Release
 * 上只发布其中一份（mac-arm64），而每个安装包里内嵌的种子却是各自 runner
 * 自己那份，导致"全新安装后本地种子哈希与货架永远不一致"的生产事故。
 *
 * 修法：由独立 CI job 打包一次，四个平台 job 下载同一份字节复用，而不是各自
 * 现场打包。这个函数只做"接过一份已经打好的箱子，量出它的哈希/体积，搬到
 * 该搬的地方"——不做任何裁剪或改写，也绝不允许把内容跟版本号对不上的箱子
 * 悄悄放行（文件名必须与传入的 version 精确匹配 renderer-<version>.tar.gz）。
 * @param {{
 *   archivePath: string,
 *   rendererArtifactOutDir: string,
 *   version: string,
 *   log?: (msg: string) => void,
 *   deps?: {
 *     sha256File?: (filePath: string) => Promise<string>,
 *     statSize?: (filePath: string) => number,
 *   },
 * }} opts
 * @returns {Promise<{archivePath: string, archiveName: string, sha256: string, size: number}>}
 */
async function usePrebuiltRendererArchive({ archivePath, rendererArtifactOutDir, version, log = console.log, deps = {} }) {
  const {
    sha256File = activation.sha256File,
    statSize = (filePath) => fs.statSync(filePath).size,
  } = deps;

  if (!fs.existsSync(archivePath)) {
    throw new Error(
      `[build-server] prebuilt renderer archive path invalid: ${archivePath} does not exist. `
        + "LUC_PREBUILT_RENDERER_BOX (or the prebuiltRendererArchive option) must point at the renderer "
        + "box produced by the shared CI job (see scripts/pack-renderer-box.mjs).",
    );
  }

  const expectedName = `renderer-${version}.tar.gz`;
  const actualName = path.basename(archivePath);
  if (actualName !== expectedName) {
    throw new Error(
      `[build-server] prebuilt renderer archive name mismatch: expected "${expectedName}" `
        + `(matching build version ${version}), got "${actualName}". Refusing to pack a renderer box `
        + "built for a different version — this guards against a stale/mismatched shared artifact "
        + "silently ending up inside this platform's seed.",
    );
  }

  fs.mkdirSync(rendererArtifactOutDir, { recursive: true });
  // 清掉上一次构建残留的旧归档（与 packRendererArtifact 的清理承诺一致），
  // 但绝不删掉源文件本身——CI 里源文件通常在下载目录，跟这里是两个目录，
  // 但本地手跑时调用方可能就地传入已经躺在 rendererArtifactOutDir 里的文件。
  for (const entry of fs.readdirSync(rendererArtifactOutDir)) {
    const entryPath = path.join(rendererArtifactOutDir, entry);
    if (path.resolve(entryPath) === path.resolve(archivePath)) continue;
    fs.rmSync(entryPath, { recursive: true, force: true });
  }
  const destPath = path.join(rendererArtifactOutDir, actualName);
  if (path.resolve(destPath) !== path.resolve(archivePath)) {
    fs.copyFileSync(archivePath, destPath);
  }

  const sha256 = await sha256File(destPath);
  const size = statSize(destPath);
  log(`[build-server] seed: reusing prebuilt ${actualName} (sha256=${sha256.slice(0, 12)}…) → ${rendererArtifactOutDir}`);
  return { archivePath: destPath, archiveName: actualName, sha256, size };
}

/**
 * schema-1 seed train manifest，双 kind：同时携带
 * artifacts.renderer 与 artifacts.server（启用双 artifact 管线后，安装包不再只带
 * server，renderer 也已拆出 asar）。contract.{preload,serverProtocol} 取自
 * shared/contract-versions.cjs 这个唯一常量源（种子与之后 publish-train 组装的
 * 正式列车共用同一份值），不在这里维护字面量副本。
 * @param {{version: string, platform: string, arch: string, keyId: string, releasedAt: string,
 *          renderer: {sha256: string, size: number, archiveName: string},
 *          server: {sha256: string, size: number, archiveName: string}}} opts
 */
export function buildSeedManifest({ version, platform, arch, keyId, releasedAt, renderer, server }) {
  return {
    schema: 1,
    train: 0,
    channel: "stable",
    releasedAt,
    keyId,
    minShell: version,
    contract: { preload: PRELOAD_API_VERSION, serverProtocol: SERVER_PROTOCOL_VERSION },
    urgent: false,
    rollout: { percent: 100, salt: "seed" },
    artifacts: {
      renderer: { version, sha256: renderer.sha256, size: renderer.size, path: renderer.archiveName },
      server: {
        [`${platform}-${arch}`]: { version, sha256: server.sha256, size: server.size, path: server.archiveName },
      },
    },
    mirrors: [],
  };
}

/**
 * 编排：打包 server + renderer 两个归档、生成并签名 ONE 覆盖两种 kind 的
 * seed manifest，四件套落进同一个 `artifactOutDir`（extraResources 的
 * seed/ 来源目录）。构建顺序固定为：两个归档
 * 都打完 → manifest → 签名。deps 可注入用于测试；默认全部走真实实现。
 * @param {{
 *   outDir: string,
 *   rendererDistDir: string,
 *   rendererArtifactOutDir: string,
 *   artifactOutDir: string,
 *   version: string,
 *   platform: string,
 *   arch: string,
 *   env?: NodeJS.ProcessEnv | Record<string, string | undefined>,
 *   log?: (msg: string) => void,
 *   deps?: {
 *     signMachOFiles?: (outDir: string, log: (msg: string) => void, env: NodeJS.ProcessEnv | Record<string, string | undefined>) => Promise<void>,
 *     packTree?: (srcDir: string, archivePath: string) => Promise<void>,
 *     sha256File?: (filePath: string) => Promise<string>,
 *     statSize?: (filePath: string) => number,
 *     findMachOFiles?: (dir: string) => string[],
 *     signManifestFile?: (opts: {manifestPath: string, signKeyPath: string}) => void,
 *     verifyManifest?: (manifestBytes: Buffer, sigBytes: Buffer, keyset: unknown[]) => object,
 *   },
 *   prebuiltRendererArchive?: string,
 * }} opts
 * @returns {Promise<{serverArchivePath: string, rendererArchivePath: string,
 *                    manifestPath: string, sigPath: string, manifest: object}>}
 */
export async function packDualKindSeed({
  outDir,
  rendererDistDir,
  rendererArtifactOutDir,
  artifactOutDir,
  version,
  platform,
  arch,
  env = process.env,
  log = console.log,
  deps = {},
  // CI 的四个平台 job 各自现场打包 renderer 树会产生同内容不同字节的四份
  // 归档（tar 头里的 mtime 不同），而发布货架只上传其中一份。设置这个参数
  // （或环境变量 LUC_PREBUILT_RENDERER_BOX）指向共享 job 已经打好的箱子，
  // 就跳过现场打包，直接复用那份字节——四个平台安装包内嵌的种子从此和货架
  // 上的归档字节完全一致。留空（本地开发者手跑 / 未设置该环境变量）时行为
  // 与过去完全一致：现场从 rendererDistDir 打包。
  prebuiltRendererArchive = env.LUC_PREBUILT_RENDERER_BOX || undefined,
}) {
  const { signManifestFile = defaultSignManifestFile, verifyManifest = manifestModule.verifyManifest } = deps;

  // ── 守卫：签名密钥必须在场（硬报错，禁止静默跳过或降级）──
  const signKeyPath = requireSignKeyPath(env);
  const { keysetPath, keyset } = resolveBuildKeyset(env);
  if (keysetPath) {
    log(`[build-server] seed: using LUC_SIGN_KEYSET override for THIS build: ${keysetPath}`);
  }

  // ── 两个归档都打完 ──
  const serverPack = await packServerArchive({ outDir, artifactOutDir, version, platform, arch, env, log, deps });
  const rendererPackShared = prebuiltRendererArchive
    ? await usePrebuiltRendererArchive({
        archivePath: prebuiltRendererArchive,
        rendererArtifactOutDir,
        version,
        log,
        deps,
      })
    : await packRendererArtifact({
        rendererDistDir,
        artifactOutDir: rendererArtifactOutDir,
        version,
        log,
        deps,
      });
  // renderer 归档平台无关，先落共享目录（dist-renderer-artifact/），再复制一份
  // 进这次构建的 per-platform seed 目录，跟 server 归档同箱（extraResources
  // 按 ${os}-${arch} 取整个目录）。
  fs.mkdirSync(artifactOutDir, { recursive: true });
  const rendererArchiveInSeed = path.join(artifactOutDir, rendererPackShared.archiveName);
  fs.copyFileSync(rendererPackShared.archivePath, rendererArchiveInSeed);

  // ── seed train manifest（schema 1 / train 0 / stable，双 kind）──
  const manifest = buildSeedManifest({
    version,
    platform,
    arch,
    keyId: keyset[0].keyId,
    releasedAt: new Date().toISOString(),
    renderer: { sha256: rendererPackShared.sha256, size: rendererPackShared.size, archiveName: rendererPackShared.archiveName },
    server: { sha256: serverPack.sha256, size: serverPack.size, archiveName: serverPack.archiveName },
  });
  const manifestFileName = seedManifestFileName(`${platform}-${arch}`);
  const manifestPath = path.join(artifactOutDir, manifestFileName);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

  // ── 签 manifest，并用"将被打包的 keyset"当场 verify ──
  signManifestFile({ manifestPath, signKeyPath });
  const sigPath = `${manifestPath}.sig`;
  if (!fs.existsSync(sigPath)) {
    throw new Error(`[build-server] manifest signing produced no signature file: ${sigPath}`);
  }
  verifyManifest(fs.readFileSync(manifestPath), fs.readFileSync(sigPath), keyset);

  log(`[build-server] seed: ${serverPack.archiveName} + ${rendererPackShared.archiveName} + ${manifestFileName}(.sig) → ${artifactOutDir}`);
  return {
    serverArchivePath: serverPack.archivePath,
    rendererArchivePath: rendererArchiveInSeed,
    manifestPath,
    sigPath,
    manifest,
  };
}
