"use strict";

/**
 * artifact-boot.cjs — 打包模式 renderer + server 的版本化启动决策
 * （签名 seed 最初只覆盖 server，现已扩展到 renderer）
 *
 * main.cjs 在 packaged 模式下经由本模块决定"从哪个版本化目录 spawn server /
 * 加载 renderer"：promote(next→current) → [server 独有：三连败降级检查] →
 * 验 seed manifest 签名 → resolveBoot(current→previous) → 决策（直接启动 /
 * 激活 seed）→ 版本化目录。两种 kind 各自独立走这条链（"Fallback chain per
 * kind: current → previous → seed re-extract"）。
 *
 * 首启解压与热更新走同一条激活代码路径（artifact-core.activateFromArchive，
 * “seed 只是从磁盘抵达的 train 0”这一不变量）。dev 模式完全不经过本模块。
 *
 * 设计要点：
 * - 消费方硬报错：seed manifest 缺调用方需要的 kind（server 缺当前平台条目 /
 *   renderer 缺条目）→ 拒绝启动，绝不静默降级（schema 修正案的消费侧义务）。
 *   packaged 模式的组合入口 `prepareArtifactBoot` 要求两个 kind 都在场。
 * - seed 新鲜度：安装器是主要投递通道。随包签名 seed 的产品版本严格新于
 *   已解析指针时，以 seed 为准重新激活，即使指针来自 OTA train；相同或更旧
 *   的 seed 不覆盖 current，避免安装旧包或同版重装造成降级/无意义替换。
 *   旧指针缺少可比较版本时保留既有兼容规则：train 0 的 sha256 不同则重新
 *   激活随包 seed，train > 0 仍优先于 seed。
 * - 三连败降级：server 与 renderer都实现——boot
 *   哨兵连续 3 次未被健康清除 → current 降级到 previous；被降级的 train > 0
 *   时写入 quarantine（永不自动重试）。train 0 永不隔离：quarantine 按
 *   train 号匹配、每一代安装包的 seed 都是 train 0，隔离它会把未来所有 seed
 *   一起封死 —— seed 是终极兜底。降级路径上不套用 seed 新鲜度
 *   规则（否则会把刚降下去的目标又顶回崩溃版本）。server 与 renderer 各自
 *   独立计数（各自的指针命名空间下有自己的 `{channel}.sentinel.json`），
 *   互不影响——server 崩溃不会连累 renderer 被降级，反之亦然。renderer 的
 *   加载失败检测（`did-fail-load`/`render-process-gone` 事件 → 触发一次新
 *   的 `prepareArtifactRendererBoot` 调用）接在 desktop/main.cjs，本模块只
 *   提供决策 + 两个纯过滤函数（`isRendererMainFrameLoadCrash`／
 *   `isRenderProcessGoneCrash`），不直接依赖 Electron。
 * - 指针命名空间：server 沿用未加限定的 `channel`（"stable"），与签名 seed 管线
 *   已经落地的用户数据字节兼容——老用户升级后 stable.current.json 仍然有效；
 *   新指针按产品版本决定 seed 新鲜度，缺少可比较版本的旧指针继续按 train 与
 *   sha256 的既有规则恢复。renderer 采用独立指针命名空间，用
 *   `${channel}.renderer` 作为独立指针命名空间（pointer-store 的 channel
 *   参数只是一个不透明的文件名片段，不做语义校验）——两种 kind 各自的
 *   current/previous/next 互不覆盖。`SEED_CHANNEL` 与 `rendererPointerChannel`
 *   的唯一定义点是 `shared/artifact-core/pointer-channels.cjs`，本模块只
 *   re-export；desktop/src/shared/artifact-ota.cjs（及其下沉后的
 *   shared/artifact-core/ota-core.cjs 核心）也从同一处取值，不重复拼接
 *   `${channel}.renderer` 这条字符串规则。
 * - LUC_HOME 纪律：homeDir 由调用方（main.cjs 的入口注入）传入，本模块
 *   不读环境变量、不拼 `.luccode*` 字面量。
 */

const fs = require("fs");
const path = require("path");

const activation = require("../../../shared/artifact-core/activation.cjs");
const pointerStore = require("../../../shared/artifact-core/pointer-store.cjs");
const manifestModule = require("../../../shared/artifact-core/manifest.cjs");
const pointerChannels = require("../../../shared/artifact-core/pointer-channels.cjs");

const { SEED_CHANNEL, rendererPointerChannel } = pointerChannels;
/**
 * Per-platform seed manifest file name — same `seed-train-${platformArch}.json`
 * convention as scripts/build-server-artifact.mjs's seedManifestFileName
 * (duplicated here, not imported: that file is an ESM build-time script,
 * this one ships inside the bundled CJS desktop app; same reasoning as the
 * pre-existing SEED_MANIFEST_NAME constant this replaces). `platformArch`
 * is always `${process.platform}-${process.arch}` at boot time.
 * @param {string} platformArch
 * @returns {string}
 */
function seedManifestFileName(platformArch) {
  return `seed-train-${platformArch}.json`;
}
const HEALTHY_CLEAR_DELAY_MS = 60_000;
const CRASH_LOOP_THRESHOLD = 3;

/**
 * @param {string} resourcesPath
 * @param {string} platformArch
 */
function seedPaths(resourcesPath, platformArch) {
  const seedDir = path.join(resourcesPath, "seed");
  const manifestPath = path.join(seedDir, seedManifestFileName(platformArch));
  return { seedDir, manifestPath, sigPath: `${manifestPath}.sig` };
}

/**
 * 打包模式探测：Resources/seed/ 下 该平台的 manifest 与签名同时在场。
 * @param {string} resourcesPath
 * @param {string} platformArch
 * @returns {boolean}
 */
function hasSeed(resourcesPath, platformArch) {
  if (!resourcesPath || !platformArch) return false;
  const { manifestPath, sigPath } = seedPaths(resourcesPath, platformArch);
  return fs.existsSync(manifestPath) && fs.existsSync(sigPath);
}

/**
 * 验签 + 按 `requiredKinds` 取对应条目。条目缺失是硬错误（消费方义务，
 * schema 修正案：manifest 层面某个 kind 缺失是合法的，但消费方需要的 kind
 * 缺失必须拒绝启动）。默认只要求 server（签名 seed 管线的既有行为，向后兼容：
 * 老调用点/老测试不传 requiredKinds 时行为逐字节不变）；packaged 模式的
 * 组合入口按 `["server", "renderer"]` 调用，一次性验两个 kind 都在场。
 * @param {{manifestBytes: Buffer, sigBytes: Buffer,
 *          keyset: Array<{keyId: string, publicKey: string}>, platformArch?: string,
 *          requiredKinds?: Array<"server"|"renderer">}} opts
 * @returns {{manifest: object, serverEntry?: object, rendererEntry?: object}}
 */
function verifySeedManifest({ manifestBytes, sigBytes, keyset, platformArch, requiredKinds = ["server"] }) {
  const manifest = manifestModule.verifyManifest(manifestBytes, sigBytes, keyset);
  const result = { manifest };
  if (requiredKinds.includes("server")) {
    const serverEntry = manifest.artifacts.server && manifest.artifacts.server[platformArch];
    if (!serverEntry) {
      throw new Error(
        `artifact-boot: seed manifest carries no server artifact for ${platformArch}; refusing to boot`,
      );
    }
    result.serverEntry = serverEntry;
  }
  if (requiredKinds.includes("renderer")) {
    const rendererEntry = manifest.artifacts.renderer;
    if (!rendererEntry) {
      throw new Error("artifact-boot: seed manifest carries no renderer artifact; refusing to boot");
    }
    result.rendererEntry = rendererEntry;
  }
  return result;
}

/**
 * 产品版本接受完整的 major.minor.patch（可带 v 前缀，可带 -prerelease / +build
 * 后缀；后缀不参与先后比较）。不可解析返回 null，由启动决策回退到旧指针兼容
 * 规则，不猜测版本先后。
 * @param {unknown} version
 * @returns {number[]|null}
 */
function parseProductVersion(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/.exec(String(version == null ? "" : version).trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * @param {unknown} leftVersion
 * @param {unknown} rightVersion
 * @returns {-1|0|1|null}
 */
function compareProductVersions(leftVersion, rightVersion) {
  const left = parseProductVersion(leftVersion);
  const right = parseProductVersion(rightVersion);
  if (!left || !right) return null;
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] > right[index] ? 1 : -1;
  }
  return 0;
}

/**
 * 纯决策：给定已解析指针、随包 seed 条目、是否处于三连败降级。
 * @param {{resolved: {slot: string, pointer: object} | null,
 *          seedEntry: {sha256: string, version?: string}, crashFallback: boolean}} opts
 * @returns {"boot"|"activate-seed"}
 */
function decideBootAction({ resolved, seedEntry, crashFallback }) {
  if (!resolved) return "activate-seed";
  if (crashFallback) return "boot"; // 绝不把降级目标又顶回 seed
  const pointer = resolved.pointer;
  const versionComparison = compareProductVersions(seedEntry.version, pointer.version);
  if (versionComparison !== null) {
    return versionComparison > 0 ? "activate-seed" : "boot";
  }

  // 老指针或异常数据没有完整产品版本时，逐字保留原来的 train/sha 决策：
  // seed-era 指针按内容新鲜度自愈，OTA train 不被无法比较的 seed 覆盖。
  const pointerTrain = Number.isInteger(pointer.train) ? pointer.train : 0;
  if (pointerTrain === 0 && pointer.sha256 !== seedEntry.sha256) {
    return "activate-seed";
  }
  return "boot";
}

/**
 * 打包模式启动准备：返回可 spawn 的版本化目录。任何失败都抛出（fail loud）。
 * @param {{
 *   homeDir: string,
 *   resourcesPath: string,
 *   platformArch: string,
 *   keyset: Array<{keyId: string, publicKey: string}>,
 *   channel?: string,
 *   onProgress?: () => void,
 *   log?: (msg: string) => void,
 * }} opts
 * @returns {Promise<{versionDir: string, train: number, version: string,
 *                    slot: string, activatedSeed: boolean, crashFallback: boolean,
 *                    quarantinedTrain: number|null, fromVersion: string|null,
 *                    toVersion: string|null}>}
 */
async function prepareArtifactServerBoot({
  homeDir,
  resourcesPath,
  platformArch,
  keyset,
  channel = SEED_CHANNEL,
  onProgress,
  log = console.log,
}) {
  if (!homeDir) throw new Error("artifact-boot: homeDir is required");

  // Whole-function critical section: this decision reads/writes the
  // channel's pointer files (promote/demote/quarantine/activate) and must
  // never interleave, within this process, with OTA's activation segment
  // in artifact-ota.cjs — an interleaving there can silently drop a
  // freshly-written `next` pointer. See pointer-store.cjs's
  // `withPointerMutex` doc comment for the full rationale.
  return pointerStore.withPointerMutex(homeDir, async () => {
    // 激活发生在下一次 boot —— 先把 next 顶成 current。
    await pointerStore.promote(homeDir, channel);

    // 三连败降级（crash-loop fallback）。
    const failures = await activation.consecutiveFailures(homeDir, channel);
    const crashFallback = failures >= CRASH_LOOP_THRESHOLD;
    let quarantinedTrain = null; // non-null only when a quarantine.json entry was actually appended this call
    // fromVersion/toVersion 只在 crashFallback 为真的这次调用里被填充——这是
    // 一次性信号（只有真正执行了 demote 的那次调用才是 true），调用方
    // （desktop/main.cjs）据此构造"版本 X 启动失败，已退回 Y"的用户可见提示；
    // 数据来源是指针文件本来就有的 version 字段，不需要额外持久化。
    let fromVersion = null;
    let toVersion = null;
    if (crashFallback) {
      const current = await pointerStore.readPointer(homeDir, channel, "current");
      const failedTrain = current && Number.isInteger(current.train) ? current.train : null;
      fromVersion = current && typeof current.version === "string" ? current.version : null;
      if (failedTrain !== null && failedTrain > 0) {
        await pointerStore.appendQuarantine(homeDir, {
          channel,
          train: failedTrain,
          reason: `crash-loop: ${failures} consecutive boot failures`,
        });
        quarantinedTrain = failedTrain;
        log(`[artifact-boot] train ${failedTrain} quarantined after ${failures} consecutive boot failures`);
      } else {
        // train 0 永不隔离：seed 是终极兜底，且 quarantine 按
        // train 号匹配，隔离 0 会连带封死未来所有安装包的 seed。
        log(`[artifact-boot] seed train crash-looped ${failures}x; falling back without quarantine`);
      }
      const demoted = await pointerStore.demoteToPrevious(homeDir, channel);
      toVersion = demoted && demoted.current && typeof demoted.current.version === "string" ? demoted.current.version : null;
      await activation.clearSentinel(homeDir, channel); // 降级目标从零开始计数
    }

    // 读 + 验 seed（无论是否需要激活都要验：新鲜度比对依赖 manifest 内容）。
    const { manifestPath, sigPath, seedDir } = seedPaths(resourcesPath, platformArch);
    if (!hasSeed(resourcesPath, platformArch)) {
      throw new Error(
        `artifact-boot: packaged resources carry no seed (expected ${manifestPath} + .sig); `
          + "the install is broken — reinstall the app",
      );
    }
    const { manifest, serverEntry } = verifySeedManifest({
      manifestBytes: fs.readFileSync(manifestPath),
      sigBytes: fs.readFileSync(sigPath),
      keyset,
      platformArch,
    });

    let resolved = await activation.resolveBoot(channel, homeDir);
    const action = decideBootAction({ resolved, seedEntry: serverEntry, crashFallback });

    let activatedSeed = false;
    if (action === "activate-seed") {
      const archivePath = path.join(seedDir, serverEntry.path);
      log(`[artifact-boot] activating seed train ${manifest.train} (${serverEntry.version}) from ${archivePath}`);
      if (onProgress) onProgress();
      // 与热更新完全相同的激活路径：一条代码路径，没有特例。allowReplaceProtected:
      // true 是安全的——这里运行的是首启/崩溃自愈的 seed 激活，此刻还没有任何进程
      // 在用这个目标目录（server 还没 spawn），不存在"边替换边被占用"的风险；
      // 后台 OTA 激活（artifact-ota.cjs）不传这个参数，默认走保护检查。
      await activation.activateFromArchive(archivePath, manifest, {
        homeDir,
        channel,
        kind: "server",
        platformArch,
        allowReplaceProtected: true,
      });
      await pointerStore.promote(homeDir, channel);
      resolved = await activation.resolveBoot(channel, homeDir);
      if (!resolved) {
        throw new Error("artifact-boot: seed activation completed but no bootable version resolved");
      }
      activatedSeed = true;
    }

    return {
      versionDir: resolved.pointer.versionDir,
      train: Number.isInteger(resolved.pointer.train) ? resolved.pointer.train : 0,
      version: resolved.pointer.version,
      slot: resolved.slot,
      activatedSeed,
      crashFallback,
      quarantinedTrain,
      fromVersion,
      toVersion,
    };
  });
}

/**
 * 打包模式启动准备：renderer 与 server 走同一条“current → previous → seed 重新
 * 激活"链，三连败降级逻辑与 `prepareArtifactServerBoot` 同构：读独立指针
 * 命名空间 `${channel}.renderer` 下的哨兵（不跟 server 的
 * `{channel}.sentinel.json` 互相覆盖，见文件头"指针命名空间"），连续 3 次
 * 未被健康清除 → demote 到 previous，train > 0 时写入 quarantine（train 0
 * 永不隔离）。调用方（desktop/main.cjs）负责在窗口 `did-fail-load` /
 * `render-process-gone` 事件触发时重新调用本函数——每次调用只做一次决策，
 * 不自己重试或轮询。任何失败都抛出（fail loud）。
 * `platformArch` 只用于定位这台机器 Resources/seed/ 下平台化命名的 manifest
 * 文件（renderer 归档本身平台无关，manifest 内容校验不看这个参数）。
 * @param {{
 *   homeDir: string,
 *   resourcesPath: string,
 *   platformArch: string,
 *   keyset: Array<{keyId: string, publicKey: string}>,
 *   channel?: string,
 *   onProgress?: () => void,
 *   log?: (msg: string) => void,
 * }} opts
 * @returns {Promise<{versionDir: string, train: number, version: string,
 *                    slot: string, activatedSeed: boolean, crashFallback: boolean,
 *                    quarantinedTrain: number|null, fromVersion: string|null,
 *                    toVersion: string|null}>}
 */
async function prepareArtifactRendererBoot({
  homeDir,
  resourcesPath,
  platformArch,
  keyset,
  channel = SEED_CHANNEL,
  onProgress,
  log = console.log,
}) {
  if (!homeDir) throw new Error("artifact-boot: homeDir is required");
  const pointerChannel = rendererPointerChannel(channel);

  // Whole-function critical section — same rationale as
  // `prepareArtifactServerBoot`'s: mutex-keyed by `homeDir` (not the
  // renderer's own pointer namespace), so it also serializes against the
  // server function's and OTA's activation segment, all of which share
  // the same homeDir. See pointer-store.cjs's `withPointerMutex` doc
  // comment.
  return pointerStore.withPointerMutex(homeDir, async () => {
    // 激活发生在下一次 boot —— 先把 next 顶成 current（由后台 OTA 写入 next 指针，
    // 的 renderer OTA 落地走的正是这个 next 指针）。
    await pointerStore.promote(homeDir, pointerChannel);

    // 三连败降级（crash-loop fallback），与 prepareArtifactServerBoot
    // 逐条同构，只是读写 renderer 自己的指针命名空间。
    const failures = await activation.consecutiveFailures(homeDir, pointerChannel);
    const crashFallback = failures >= CRASH_LOOP_THRESHOLD;
    let quarantinedTrain = null; // non-null only when a quarantine.json entry was actually appended this call
    // fromVersion/toVersion：同 prepareArtifactServerBoot 一侧的一次性信号语义，
    // 见该函数内对应注释。
    let fromVersion = null;
    let toVersion = null;
    if (crashFallback) {
      const current = await pointerStore.readPointer(homeDir, pointerChannel, "current");
      const failedTrain = current && Number.isInteger(current.train) ? current.train : null;
      fromVersion = current && typeof current.version === "string" ? current.version : null;
      if (failedTrain !== null && failedTrain > 0) {
        await pointerStore.appendQuarantine(homeDir, {
          channel: pointerChannel,
          train: failedTrain,
          reason: `crash-loop: ${failures} consecutive renderer load failures`,
        });
        quarantinedTrain = failedTrain;
        log(`[artifact-boot] renderer train ${failedTrain} quarantined after ${failures} consecutive load failures`);
      } else {
        // train 0 永不隔离：seed 是终极兜底。
        log(`[artifact-boot] renderer seed train crash-looped ${failures}x; falling back without quarantine`);
      }
      const demoted = await pointerStore.demoteToPrevious(homeDir, pointerChannel);
      toVersion = demoted && demoted.current && typeof demoted.current.version === "string" ? demoted.current.version : null;
      await activation.clearSentinel(homeDir, pointerChannel); // 降级目标从零开始计数
    }

    const { manifestPath, sigPath, seedDir } = seedPaths(resourcesPath, platformArch);
    if (!hasSeed(resourcesPath, platformArch)) {
      throw new Error(
        `artifact-boot: packaged resources carry no seed (expected ${manifestPath} + .sig); `
          + "the install is broken — reinstall the app",
      );
    }
    const { manifest, rendererEntry } = verifySeedManifest({
      manifestBytes: fs.readFileSync(manifestPath),
      sigBytes: fs.readFileSync(sigPath),
      keyset,
      requiredKinds: ["renderer"],
    });

    let resolved = await activation.resolveBoot(pointerChannel, homeDir);
    const action = decideBootAction({ resolved, seedEntry: rendererEntry, crashFallback });

    let activatedSeed = false;
    if (action === "activate-seed") {
      const archivePath = path.join(seedDir, rendererEntry.path);
      log(`[artifact-boot] activating renderer seed train ${manifest.train} (${rendererEntry.version}) from ${archivePath}`);
      if (onProgress) onProgress();
      // 与热更新完全相同的激活路径：一条代码路径，没有特例。allowReplaceProtected:
      // true 是安全的——触发这条分支的两个场景（首启、did-fail-load/
      // render-process-gone 之后的自愈重激活）里，上一次加载这个目录的渲染进程
      // 要么还没起来，要么已经崩溃/关闭，不存在"边替换边被占用"的风险；后台 OTA
      // 激活（artifact-ota.cjs）不传这个参数，默认走保护检查。
      await activation.activateFromArchive(archivePath, manifest, {
        homeDir,
        channel: pointerChannel,
        kind: "renderer",
        allowReplaceProtected: true,
      });
      await pointerStore.promote(homeDir, pointerChannel);
      resolved = await activation.resolveBoot(pointerChannel, homeDir);
      if (!resolved) {
        throw new Error("artifact-boot: renderer seed activation completed but no bootable version resolved");
      }
      activatedSeed = true;
    }

    return {
      versionDir: resolved.pointer.versionDir,
      train: Number.isInteger(resolved.pointer.train) ? resolved.pointer.train : 0,
      version: resolved.pointer.version,
      slot: resolved.slot,
      activatedSeed,
      crashFallback,
      quarantinedTrain,
      fromVersion,
      toVersion,
    };
  });
}

/**
 * packaged 模式的组合入口：解析两个 kind 都需要就位的
 * 启动状态——先对 seed manifest 做一次"两个 kind 都在场"的整体校验（硬
 * 报错优先于任何一侧的部分解压，避免"server 已解压、renderer 才发现缺
 * 失"这种半吊子状态），再分别走 server 和 renderer（各自独立三连败降级，
 * 恢复机制启用后两者同构）各自的 current→previous→seed 链。
 * @param {{
 *   homeDir: string,
 *   resourcesPath: string,
 *   platformArch: string,
 *   keyset: Array<{keyId: string, publicKey: string}>,
 *   channel?: string,
 *   onProgress?: () => void,
 *   log?: (msg: string) => void,
 * }} opts
 * @returns {Promise<{
 *   server: {versionDir: string, train: number, version: string, slot: string, activatedSeed: boolean, crashFallback: boolean},
 *   renderer: {versionDir: string, train: number, version: string, slot: string, activatedSeed: boolean},
 * }>}
 */
async function prepareArtifactBoot({
  homeDir,
  resourcesPath,
  platformArch,
  keyset,
  channel = SEED_CHANNEL,
  onProgress,
  log = console.log,
}) {
  if (!hasSeed(resourcesPath, platformArch)) {
    throw new Error(
      `artifact-boot: packaged resources carry no seed (expected under ${path.join(resourcesPath, "seed")}); `
        + "the install is broken — reinstall the app",
    );
  }
  const { manifestPath, sigPath } = seedPaths(resourcesPath, platformArch);
  // 两个 kind 都必须在场（consumer 必须保证）——校验
  // 一次即可，下面的 per-kind 函数各自还会再验一次自己需要的那半（廉价：
  // 一次 ed25519 verify + 一次小文件读取），换来的是各函数可以独立调用/
  // 独立测试，不需要把已验证的 manifest 一路穿透传参。
  verifySeedManifest({
    manifestBytes: fs.readFileSync(manifestPath),
    sigBytes: fs.readFileSync(sigPath),
    keyset,
    platformArch,
    requiredKinds: ["server", "renderer"],
  });

  const server = await prepareArtifactServerBoot({ homeDir, resourcesPath, platformArch, keyset, channel, onProgress, log });
  const renderer = await prepareArtifactRendererBoot({ homeDir, resourcesPath, platformArch, keyset, channel, onProgress, log });

  return { server, renderer };
}

/**
 * spawn 前登记 boot 哨兵（同 train 连续未清除会累加计数）。
 * @param {string} homeDir
 * @param {string} channel
 * @param {number} train
 */
function writeBootSentinel(homeDir, channel, train) {
  return activation.writeSentinel(homeDir, channel, train);
}

/**
 * 健康观察期后清除哨兵：健康运行 60 秒后清除。返回的 timer
 * 已 unref，不阻塞进程退出；进程在观察期内死亡 → 哨兵留存 → 下次 boot 计数。
 * @param {{homeDir: string, channel: string, delayMs?: number, log?: (msg: string) => void}} opts
 */
function scheduleHealthySentinelClear({ homeDir, channel, delayMs = HEALTHY_CLEAR_DELAY_MS, log = console.log }) {
  const timer = setTimeout(() => {
    activation.clearSentinel(homeDir, channel).catch((err) => {
      log(`[artifact-boot] failed to clear boot sentinel: ${err.message}`);
    });
  }, delayMs);
  if (typeof timer.unref === "function") timer.unref();
  return timer;
}

// ---- renderer load-failure event guards  ---------------
//
// Pure, Electron-free filters consumed by desktop/main.cjs's
// `did-fail-load` / `render-process-gone` listeners on artifact-loaded
// windows, so "does this event mean the renderer artifact itself failed
// to come up" is a single tested decision instead of ad-hoc inline
// conditionals at each of the (several) window-creation call sites.

// ERR_ABORTED: fires on ordinary cancelled navigations (e.g. a reload
// racing a window close) — never a real renderer-artifact crash.
const IGNORED_LOAD_FAILURE_ERROR_CODES = new Set([-3]);

/**
 * Filters Electron's `did-fail-load` event: sub-frame failures
 * (`isMainFrame === false`) and ERR_ABORTED (-3) on the main frame are
 * never real renderer-artifact crashes and must never feed the
 * crash-loop sentinel.
 * @param {{errorCode: number, isMainFrame: boolean}} opts
 * @returns {boolean}
 */
function isRendererMainFrameLoadCrash({ errorCode, isMainFrame }) {
  if (isMainFrame === false) return false;
  return !IGNORED_LOAD_FAILURE_ERROR_CODES.has(errorCode);
}

/**
 * Filters Electron's `render-process-gone` event: a `clean-exit` reason
 * means the process exited on purpose and must never feed the crash-loop
 * sentinel; every other reason (`crashed`, `oom`, `killed`,
 * `launch-failed`, `integrity-failure`, `abnormal-exit`, ...) counts.
 * @param {{reason: string}} opts
 * @returns {boolean}
 */
function isRenderProcessGoneCrash({ reason }) {
  return reason !== "clean-exit";
}

module.exports = {
  SEED_CHANNEL,
  seedManifestFileName,
  HEALTHY_CLEAR_DELAY_MS,
  CRASH_LOOP_THRESHOLD,
  seedPaths,
  hasSeed,
  verifySeedManifest,
  decideBootAction,
  rendererPointerChannel,
  prepareArtifactServerBoot,
  prepareArtifactRendererBoot,
  prepareArtifactBoot,
  writeBootSentinel,
  scheduleHealthySentinelClear,
  isRendererMainFrameLoadCrash,
  isRenderProcessGoneCrash,
};
