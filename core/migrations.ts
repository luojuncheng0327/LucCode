/**
 * 数据迁移 runner
 *
 * 所有用户数据格式变更集中在此文件。
 * preferences.json._dataVersion 保留为连续完成的高水位。
 * 高水位之后的成功条目会单独记录，不会因为前面某条失败而重跑。
 *
 * 添加新迁移：在 migrations 对象末尾加一条，key 为递增整数。
 *
 * 跨分支合并规约：若合并双方在各自分支上都新增过迁移编号（冲突通常落在本文件
 * 或测试里的 LATEST_DATA_VERSION 上，那就是触发信号），禁止裸改号或折叠合入
 * 既有编号——"编号 ≤ 高水位即跳过"意味着任何 ≤ 对方高水位的槽位对对方存量
 * 用户永远不可达，改号救不了；预留高段位同样错误（高号会把高水位推顶，反向
 * 跳过另一侧后续迁移）。唯一正确做法：新增一条更高位的幂等 reconcile 迁移，
 * 依次重放双方全部新增载荷；各载荷的幂等性必须有测试背书（对已迁移状态重跑
 * 断言零变更），并补双方历史高水位的组合测试。
 */
import fs from "fs";
import path from "path";
import YAML from "js-yaml";
import { atomicWriteSync, safeReadYAMLSync } from "../shared/safe-fs.ts";
import { ensureSecretDirModeSync, ensureSecretFileModeSync, writeSecretFileSync } from "../shared/secret-fs.ts";
import {
  ensureLocalIdentityRegistries,
  ensureRemoteAccessFoundationRegistries,
} from "./server-identity.ts";
import { saveConfig } from "../lib/memory/config-loader.ts";
import {
  getSubagentSessionMetaPath,
  mergeExecutorMetadata,
  normalizeExecutorMetadata,
  readSubagentSessionMetaSync,
} from "../lib/subagent-executor-metadata.ts";
import { SessionFileRegistry } from "../lib/session-files/session-file-registry.ts";
import { isSessionJsonlFilename } from "../lib/session-jsonl.ts";
import { SubagentRunStore } from "../lib/subagent-run-store.ts";
import { SubagentThreadStore } from "../lib/subagent-thread-store.ts";
import { persistBrowserScreenshotFileSync } from "../lib/session-files/browser-screenshot-file.ts";
import { getInvalidProviderModelIds } from "../shared/provider-model-validation.ts";
import { normalizeThinkingLevelForModel } from "./session-thinking-level.ts";
import {
  legacyAccessModeFromPermissionMode,
  normalizeBridgePermissionMode,
  normalizeSessionPermissionMode,
  SESSION_PERMISSION_MODES,
} from "./session-permission-mode.ts";
import { lookupKnown } from "../shared/known-models.ts";
import { SESSION_PREFIX_MAP } from "../lib/bridge/session-key.ts";
import {
  DINGTALK_LEGACY_AUTH_MODE,
  canonicalizeDingTalkBridgeConfig,
} from "../lib/bridge/dingtalk-contract.ts";
import { migrateLegacyApiKeyAuthToProviders } from "./provider-auth-migration.ts";
import { createModuleLogger } from "../lib/debug-log.ts";
import { patchAutomationJobForMigration } from "../lib/desk/automation-normalizer.ts";
import { parseSkillMetadata } from "../lib/skills/skill-metadata.ts";
import { safeConversationStem } from "../lib/conversations/agent-phone-projection.ts";
import { DEFAULT_DISABLED_TOOL_NAMES } from "../shared/tool-categories.ts";
import { ProviderCatalogStore } from "./provider-catalog.ts";
import { migrationBackupsRoot } from "./migration-backups.ts";
import { REFERENCE_BLOCK_PREFIX, REMINDER_BLOCK_PREFIX } from "./session-reminders.ts";
import { repairProviderModelMetadata } from "./provider-model-metadata-migration.ts";
import { sessionIdFromFilename } from "../lib/session-jsonl.ts";
import {
  filesystemIdentityKeySync,
  isDirectoryLikeDirentSync,
  isFileLikeDirentSync,
  readDirectoryLikeDirentsSync,
} from "../shared/link-aware-fs.ts";

const moduleLog = createModuleLogger("migrations");

// ── 迁移表 ──────────────────────────────────────────────────────────────────

const migrations = {
  // #356: 清理悬空 provider 引用（agent config + preferences）
  1: cleanDanglingProviderRefs,
  // bridge 配置从全局 preferences 迁移到各 agent 的 config.yaml
  2: migrateBridgeToPerAgent,
  // workspace (home_folder) 从全局 preferences 迁移到主 agent config.yaml
  3: migrateWorkspaceToPerAgent,
  // subagent executor metadata 显式化，避免历史回放依赖目录推断
  4: migrateSubagentExecutorMetadata,
  // models.* 字段全量迁移到 {id, provider} 复合键对象；
  // 裸 id / "provider/id" 字符串统一归一化
  5: migrateModelRefsToCompositeKey,
  // channels.enabled 从 agent scope 错位位置迁到 global preferences；
  // 尊重老用户显式意图：任一 agent 显式 true → 保留开，否则默认关
  6: migrateChannelsToGlobalDefaultOff,
  // 模型能力字段 vision → image 全量重命名（added-models.yaml + agent config.yaml）
  // 配合 core/model-sync.ts 和 core/provider-registry.ts 的读时兼容形成双保险
  7: migrateVisionToImage,
  // 修复 migration #5 之后仍有入口把 models.* 写回旧字符串格式的问题
  8: repairPostMigrationModelRefs,
  // bridge.readOnly 从 agent scope 收敛回全局 preferences
  9: migrateBridgeReadOnlyToGlobal,
  // summarizer / compiler 角色从未接通业务，删除 preferences 与 agent config 里的残留字段
  10: cleanupSummarizerCompilerRemnants,
  // cron job 的 model 字段补齐为 {id, provider}，修复旧任务只保存裸 id 的问题
  11: repairCronJobModelRefs,
  // 老 session 的文件引用补齐到 session file sidecar；作为最后一步，不重写历史 JSONL
  12: backfillLegacySessionFiles,
  // 最近版本把默认值和 provider 校验收紧后，对旧磁盘数据做一次显式化修补
  13: normalizeRecentLegacyCompatibilityState,
  // Gemini 3 工具调用需要 native Google 协议保留 thoughtSignature
  14: migrateGeminiOpenAICompatToNative,
  // 旧 prompt snapshot 会话里无法证明 xhigh 支持的记录显式降级为 high
  15: repairLegacySessionSidecarThinkingLevels,
  // 视频能力进入 model.input 后，修补老的模型投影和残留 override
  16: migrateVideoCapabilityProjection,
  // bridge sessionKey 引入 @agentId 后，修补旧 index 中无 agent 维度的 key
  17: migrateBridgeSessionKeysToAgentScoped,
  // Studio 基础身份：为旧 LUC_HOME 补齐 server / legacy owner / default Studio registry
  18: migrateLocalIdentityRegistries,
  // API-key provider 凭证真相源迁移：auth.json → added-models.yaml
  19: migrateLegacyApiKeyAuthEntriesToProviders,
  // Pi SDK 0.70+ 严格限制 model.input，只允许 text/image；Luc 视频能力迁入 compat
  20: migratePiInputSchemaVideoCompat,
  // 刷新高确定性视频模型能力；补齐已升级用户 models.json 里的 Luc compat
  21: refreshVideoCapabilityProjection,
  // 频道 phone 设置显式化：主动提醒默认 31 分钟，模型覆写默认关闭
  22: migrateChannelPhoneSettingsDefaults,
  // 删除本轮开发期间加入但已废弃的自由文本回复范围设置
  23: removeAgentPhoneReplyInstructions,
  // 频道 phone 轮次 guard limit 显式化，默认按成员数 × 12
  24: migrateChannelPhoneGuardLimitDefaults,
  // 频道主动发起开关显式化，旧频道保持开启
  25: migrateChannelPhoneProactiveDefaults,
  // Space → Studio：把已落过盘的 spaces.json 迁出为 studios.json
  26: migrateStudioIdentityRegistries,
  // 远程访问 UI 前地基：补齐设备、网络和挂载空 registry
  27: migrateRemoteAccessFoundationRegistries,
  // subagent 子会话长期映射：把临时 deferred 队列里的历史事实迁入 durable registry
  28: migrateDurableSubagentRunRegistry,
  // 巡检显式 opt-in：历史缺省值统一落盘为 false，避免旧配置被运行时当成开启
  29: migrateHeartbeatDefaultExplicitOff,
  // cron → automation read model：补齐 trigger / executor / createdBy，保留旧字段兼容
  30: migrateCronJobsToAutomationReadModel,
  // learned-skills 收敛进全局 skill pool，并只为来源 agent 默认启用
  31: migrateLearnedSkillsToGlobalSkillPool,
  // Agent Phone runtime 状态从 projection 迁入独立 sidecar
  32: migrateAgentPhoneRuntimeOutOfProjection,
  // 小花美术默认显式关闭；旧 Agent 配置只有用户手动开启后才可用
  33: migrateBeautifyDefaultExplicitOff,
  // workflow 默认显式关闭：从全局设置页开关迁移为 per-agent 工具开关后，老 agent 补 disabled
  34: migrateWorkflowDefaultExplicitOff,
  // MiniMax Token Plan 官方入口迁到 Anthropic-compatible endpoint，但保留独立 provider 边界
  35: migrateMiniMaxTokenPlanAnthropicEndpoint,
  // subagent thread/run 分层：从旧 run/reusable 账本迁出显式 thread registry
  36: migrateSubagentThreadRegistry,
  // subagent direct instance：旧 ephemeral/reusable kind 归一为 direct，instance 变成展示 label
  37: migrateSubagentDirectThreadSemantics,
  // automation 执行模型收敛：旧 direct notify 显式改写为 Agent Run
  38: migrateDirectNotifyAutomationsToAgentRuns,
  // automation 归属修复：所有可运行任务必须能确定执行 Agent；旧 plugin/direct 执行器收敛为 Agent Run
  39: repairAutomationOwnershipAfterAgentRunConsolidation,
  // session permission mode 收敛：旧 sidecar 的 planMode/accessMode 补齐 canonical permissionMode
  40: migrateSessionPermissionModeSidecars,
  // identity 首启种子曾把 {{userName}} 写成空串，修回动态用户名占位符
  41: migrateIdentityUserNamePlaceholders,
  // Provider Catalog v2：provider/model/capability canonical store 一次性 cutover
  42: migrateProviderCatalogV2Cutover,
  // Codex 生图参数改为 mode schema 的 resolution 后，清掉旧配置残留的 size 默认值
  43: migrateCodexImageGenerationDefaultsToResolutionSchema,
  // OAuth 模型管理收回 Provider Catalog：合并旧 runtime alias、自定义模型偏好并清掉双数据源
  44: migrateOAuthModelsToProviderCatalog,
  // 保留旧版本已持久化的 Codex OAuth 模型引用，避免固定 allowlist 让旧会话失效
  45: recoverReferencedCodexOAuthModels,
  // 清理旧 Provider Catalog 中当前校验器明确拒绝的模型元数据，并先保存可恢复原件
  46: repairLegacyProviderModelMetadata,
  // stable 钉钉配置使用旧应用 token 接口；显式标记后继续沿用旧契约
  47: migrateStableDingTalkCredentialsToLegacyAuthMode,
  // stable 会加载项目内兼容技能目录；只为缺少新策略字段的旧 Agent 显式保留该行为
  48: preserveStableCompatibleWorkspaceSkillDiscovery,
  // 迁移 #45 曾把 model_change / assistant message 事件记录自身的 id 误收为
  // Codex 模型 id 并写入 Provider Catalog；用闭环证据法清理这批污染条目
  49: repairPollutedCodexEventIdModels,
  // Gemini 生图 preview 模型退役：默认、provider key、catalog 与可重试任务统一到 stable ID
  50: migrateGeminiImagePreviewIdsToStable,
  // 用户名正源收敛到全局 preferences；各 agent 里重复的同名副本一并清掉
  51: migrateUserNameToGlobalPreferences,
  // agent 级 user.name 覆盖层取消：读取侧不再看这个字段，残留字段一并删掉
  52: migrateClearUserNameOverrides,
  // 标题生成曾直接读注入过信封的首条 user 消息；删掉被信封字面量占满的存量标题
  53: migrateCleanEnvelopeSessionTitles,
};

// Migration ids are a single monotonic ladder shared across release channels;
// a new id must exceed the highest id ever shipped on ANY channel, because the
// runner treats id <= highWaterMark as completed.

const migrationDependencies = {
  8: [5],
  21: [16, 20],
  37: [36],
  39: [38],
  44: [42],
  45: [42, 44],
  46: [42],
  49: [42, 45],
  50: [42],
};

const migrationIds = Object.keys(migrations).map(Number).sort((a, b) => a - b);
const latestMigrationId = migrationIds.at(-1) || 0;

function normalizeMigrationState(preferences) {
  const highWaterMark = Number.isInteger(preferences?._dataVersion) && preferences._dataVersion > 0
    ? preferences._dataVersion
    : 0;
  const rawState = preferences?._migrationState;
  const completedIds: number[] = Array.isArray(rawState?.completedIds)
    ? rawState.completedIds.filter((id) => Number.isInteger(id) && migrationIds.includes(id) && id > highWaterMark)
    : [];
  const lastFailedIds: number[] = Array.isArray(rawState?.lastFailedIds)
    ? rawState.lastFailedIds.filter((id) => Number.isInteger(id) && migrationIds.includes(id) && id > highWaterMark)
    : [];
  return {
    highWaterMark,
    completedIds: [...new Set(completedIds)].sort((a, b) => a - b),
    lastFailedIds: [...new Set(lastFailedIds)].sort((a, b) => a - b),
  };
}

function completedMigrationIds(state) {
  const completed = new Set(state.completedIds);
  for (const id of migrationIds) {
    if (id <= state.highWaterMark) completed.add(id);
  }
  return completed;
}

function compactMigrationState(state, completed) {
  let highWaterMark = state.highWaterMark;
  for (const id of migrationIds) {
    if (id <= highWaterMark) continue;
    if (id !== highWaterMark + 1 || !completed.has(id)) break;
    highWaterMark = id;
  }
  return {
    highWaterMark,
    completedIds: [...completed].filter((id) => id > highWaterMark).sort((a, b) => a - b),
    lastFailedIds: state.lastFailedIds.filter((id) => id > highWaterMark).sort((a, b) => a - b),
  };
}

function saveMigrationState(prefs, state) {
  const fresh = prefs.getPreferences();
  fresh._dataVersion = state.highWaterMark;
  fresh._migrationState = {
    completedIds: state.completedIds,
    lastFailedIds: state.lastFailedIds,
  };
  prefs.savePreferences(fresh);
}

/**
 * Returns legacy migration readiness without changing preferences or user data.
 * Accepts either a PreferencesManager-like object or an already-read preferences object.
 */
export function getMigrationStatus(prefsOrPreferences) {
  const preferences = typeof prefsOrPreferences?.getPreferences === "function"
    ? prefsOrPreferences.getPreferences()
    : (prefsOrPreferences || {});
  const state = normalizeMigrationState(preferences);
  const completed = completedMigrationIds(state);
  return {
    registryLatestId: latestMigrationId,
    pendingIds: migrationIds.filter((id) => !completed.has(id)),
    lastFailedIds: state.lastFailedIds.filter((id) => !completed.has(id)),
  };
}

// ── Runner ──────────────────────────────────────────────────────────────────

/**
 * @param {object} ctx
 * @param {string}   ctx.luccodeHome
 * @param {string}   ctx.agentsDir
 * @param {import('./preferences-manager.ts').PreferencesManager} ctx.prefs
 * @param {import('./provider-registry.ts').ProviderRegistry}     ctx.providerRegistry
 * @param {Function} ctx.log
 */
export function runMigrations(ctx) {
  const { prefs, log } = ctx;
  const preferences = prefs.getPreferences();
  let state = normalizeMigrationState(preferences);
  const completed = completedMigrationIds(state);
  const pending = migrationIds.filter((id) => !completed.has(id));

  if (!pending.length) return getMigrationStatus(prefs);

  log(`[migrations] _dataVersion=${state.highWaterMark}，待执行 ${pending.length} 条迁移`);

  for (const v of pending) {
    const unmetDependencies = (migrationDependencies[v] || []).filter((id) => !completed.has(id));
    if (unmetDependencies.length > 0) {
      log(`[migrations] #${v} 等待前置迁移 #${unmetDependencies.join(", #")}`);
      continue;
    }

    try {
      migrations[v](ctx);
      log(`[migrations] #${v} 完成`);
      completed.add(v);
      state.lastFailedIds = state.lastFailedIds.filter((id) => id !== v);
    } catch (err) {
      moduleLog.error(`#${v} 失败: ${err.message}`);
      if (!state.lastFailedIds.includes(v)) state.lastFailedIds.push(v);
    }

    // 每次尝试后立即持久化收据，防止后续崩溃导致重跑已成功的迁移。
    state = compactMigrationState(state, completed);
    try {
      saveMigrationState(prefs, state);
    } catch (err) {
      // The migration's own result and the receipt write are separate
      // failure domains. A read-only disk or a transient atomic-rename
      // failure must not turn maintenance bookkeeping into a global startup
      // failure. Without a durable receipt the successful migration remains
      // pending and will be retried on the next launch.
      moduleLog.error(`迁移收据保存失败: ${err.message}`);
      log(`[migrations] 收据保存失败，应用将继续启动；未落盘的迁移会在下次启动重试`);
    }
  }

  return getMigrationStatus(prefs);
}

// ── 迁移实现 ─────────────────────────────────────────────────────────────────

/**
 * #1 — 清理悬空 provider 引用
 *
 * 用户删除 provider 后，agent config.yaml 和 preferences.json 中
 * 可能残留指向已不存在 provider 的引用，导致启动时模型解析失败。
 * 本迁移扫描所有引用位置，将悬空引用清空。
 */
function cleanDanglingProviderRefs(ctx) {
  const { agentsDir, prefs, providerRegistry, log } = ctx;

  const providerExists = (id) => !!providerRegistry.get(id);

  // ── 1. Agent config.yaml ──

  let agentDirs;
  try {
    agentDirs = readDirectoryLikeDirentsSync(agentsDir);
  } catch { return; }

  for (const dir of agentDirs) {
    const cfgPath = path.join(agentsDir, dir.name, "config.yaml");
    const config = safeReadYAMLSync(cfgPath, null, YAML);
    if (!config) continue;

    let changed = false;

    // api.provider / embedding_api.provider / utility_api.provider
    for (const block of ["api", "embedding_api", "utility_api"]) {
      const provider = config[block]?.provider;
      if (provider && !providerExists(provider)) {
        config[block].provider = "";
        changed = true;
        log(`[migrations] ${dir.name}: ${block}.provider "${provider}" 不存在，已清空`);
      }
    }

    // models.* — 字符串 "provider/model" 或 { id, provider } 对象
    if (config.models) {
      for (const role of ["chat", "utility", "utility_large", "embedding"]) {
        const ref = config.models[role];
        if (!ref) continue;

        if (typeof ref === "object" && ref.provider && !providerExists(ref.provider)) {
          config.models[role] = "";
          changed = true;
          log(`[migrations] ${dir.name}: models.${role}.provider "${ref.provider}" 不存在，已清空`);
        } else if (typeof ref === "string" && ref.includes("/")) {
          const provider = ref.slice(0, ref.indexOf("/"));
          if (!providerExists(provider)) {
            config.models[role] = "";
            changed = true;
            log(`[migrations] ${dir.name}: models.${role} "${ref}" provider 不存在，已清空`);
          }
        }
      }
    }

    if (changed) {
      writeSecretFileSync(cfgPath, YAML.dump(config, { indent: 2, lineWidth: -1, sortKeys: false, quotingType: '"' }));
    }
  }

  // ── 2. Preferences ──

  const preferences = prefs.getPreferences();
  let prefsChanged = false;

  // 共享模型字段：utility_model, utility_large_model
  for (const key of ["utility_model", "utility_large_model"]) {
    const val = preferences[key];
    if (!val) continue;

    if (typeof val === "object" && val.provider && !providerExists(val.provider)) {
      preferences[key] = null;
      prefsChanged = true;
      log(`[migrations] preferences.${key}.provider "${val.provider}" 不存在，已清空`);
    } else if (typeof val === "string" && val.includes("/")) {
      const provider = val.slice(0, val.indexOf("/"));
      if (!providerExists(provider)) {
        preferences[key] = null;
        prefsChanged = true;
        log(`[migrations] preferences.${key} "${val}" provider 不存在，已清空`);
      }
    }
  }

  // utility_api_provider
  if (preferences.utility_api_provider && !providerExists(preferences.utility_api_provider)) {
    log(`[migrations] preferences.utility_api_provider "${preferences.utility_api_provider}" 不存在，已清空`);
    preferences.utility_api_provider = null;
    prefsChanged = true;
  }

  if (prefsChanged) {
    prefs.savePreferences(preferences);
  }
}

/**
 * #2 — bridge 配置从全局 preferences 迁移到 per-agent config.yaml
 *
 * preferences.json 中的 bridge.telegram / feishu / qq / wechat / whatsapp
 * 各自可能带 agentId 字段指定归属 agent。迁移后每个 platform config
 * 写入对应 agent 的 config.yaml，owner 信息一并合入。
 * bridge.permissionMode / readOnly / receiptEnabled / richStreamingEnabled 保留为全局偏好。
 */
function migrateBridgeToPerAgent(ctx) {
  const { agentsDir, prefs, log } = ctx;
  const preferences = prefs.getPreferences();
  const bridge = preferences.bridge;
  if (!bridge) return; // nothing to migrate

  const primaryAgentId = preferences.primaryAgent || null;
  const ownerDict = bridge.owner || {};
  const explicitPermissionMode = typeof bridge.permissionMode === "string"
    ? normalizeBridgePermissionMode({ permissionMode: bridge.permissionMode })
    : null;
  const readOnly = explicitPermissionMode
    ? explicitPermissionMode === SESSION_PERMISSION_MODES.READ_ONLY
    : bridge.readOnly === true;
  const receiptEnabled = bridge.receiptEnabled === false ? false : undefined;
  const richStreamingEnabled = bridge.richStreamingEnabled === false ? false : undefined;

  const PLATFORMS = ["telegram", "feishu", "qq", "wechat", "whatsapp"];
  const agentConfigs = new Map(); // agentId → { platform: config }

  // Find fallback agent: primary if it exists, otherwise first available
  let fallbackAgentId = null;
  if (primaryAgentId) {
    const primaryDir = path.join(agentsDir, primaryAgentId);
    if (fs.existsSync(path.join(primaryDir, "config.yaml"))) {
      fallbackAgentId = primaryAgentId;
    } else {
      log(`[migrations] primaryAgent "${primaryAgentId}" dir/config.yaml not found, scanning for fallback`);
    }
  }
  if (!fallbackAgentId) {
    try {
      const dirs = readDirectoryLikeDirentsSync(agentsDir);
      for (const d of dirs) {
        if (fs.existsSync(path.join(agentsDir, d.name, "config.yaml"))) {
          fallbackAgentId = d.name;
          break;
        }
      }
    } catch {}
  }

  for (const platform of PLATFORMS) {
    const cfg = bridge[platform];
    if (!cfg) continue;

    // Determine target agent
    let targetAgentId = cfg.agentId || null;
    if (targetAgentId) {
      const agentCfg = path.join(agentsDir, targetAgentId, "config.yaml");
      if (!fs.existsSync(agentCfg)) {
        log(`[migrations] bridge.${platform}.agentId "${targetAgentId}" not found, using fallback`);
        targetAgentId = null;
      }
    }
    if (!targetAgentId) targetAgentId = fallbackAgentId;
    if (!targetAgentId) {
      log(`[migrations] no agent available for bridge.${platform}, skipping`);
      continue;
    }

    if (!agentConfigs.has(targetAgentId)) agentConfigs.set(targetAgentId, {});
    const ac = agentConfigs.get(targetAgentId);

    // Clean config: strip agentId field (now implicit by location)
    const cleanCfg = { ...cfg };
    delete cleanCfg.agentId;

    // Resolve owner: composite key "platform:agentId" > legacy "platform"
    const compositeKey = `${platform}:${targetAgentId}`;
    const owner = ownerDict[compositeKey] || ownerDict[platform] || null;
    if (owner) cleanCfg.owner = owner;

    ac[platform] = cleanCfg;
  }

  // Write to each agent's config.yaml
  for (const [agentId, bridgeConfig] of agentConfigs) {
    const cfgPath = path.join(agentsDir, agentId, "config.yaml");
    if (!fs.existsSync(cfgPath)) {
      log(`[migrations] agent ${agentId} config.yaml not found, skipping`);
      continue;
    }
    saveConfig(cfgPath, { bridge: { ...bridgeConfig } });
    log(`[migrations] migrated bridge config → agent ${agentId} (${Object.keys(bridgeConfig).join(", ")})`);
  }

  // 清理旧的 platform / owner 键，只保留新的全局偏好键
  const nextBridgePrefs: any = {};
  if (explicitPermissionMode && explicitPermissionMode !== SESSION_PERMISSION_MODES.AUTO) {
    nextBridgePrefs.permissionMode = explicitPermissionMode;
  }
  if (readOnly) nextBridgePrefs.readOnly = true;
  if (receiptEnabled === false) nextBridgePrefs.receiptEnabled = false;
  if (richStreamingEnabled === false) nextBridgePrefs.richStreamingEnabled = false;
  if (Object.keys(nextBridgePrefs).length > 0) preferences.bridge = nextBridgePrefs;
  else delete preferences.bridge;
  prefs.savePreferences(preferences);
  log(`[migrations] migrated prefs.bridge platform config to agents`);
}

function migrateSubagentExecutorMetadata(ctx) {
  const { agentsDir, lucHome, log } = ctx;
  const agentSnapshots = new Map();
  const childSessionCandidates = new Map();

  const agentDirs = (() => {
    try {
      return readDirectoryLikeDirentsSync(agentsDir)
        .filter((d) => fs.existsSync(path.join(agentsDir, d.name, "config.yaml")));
    } catch {
      return [];
    }
  })();

  for (const dir of agentDirs) {
    const cfgPath = path.join(agentsDir, dir.name, "config.yaml");
    const cfg = safeReadYAMLSync(cfgPath, {}, YAML);
    agentSnapshots.set(dir.name, cfg?.agent?.name || dir.name);
  }

  function ownerIdentityFor(agentId) {
    if (!agentId) return null;
    return normalizeExecutorMetadata({
      agentId,
      agentName: agentSnapshots.get(agentId) || agentId,
    });
  }

  function rememberChildSessionIdentity(sessionPath, identity, priority) {
    if (!sessionPath || !identity) return;
    const current = childSessionCandidates.get(sessionPath);
    if (!current || priority > current.priority) {
      childSessionCandidates.set(sessionPath, { identity, priority });
    }
  }

  function inferOwnerAgentId(sessionPath) {
    const rel = path.relative(agentsDir, sessionPath);
    if (rel.startsWith("..")) return null;
    return rel.split(path.sep)[0] || null;
  }

  for (const dir of agentDirs) {
    const agentId = dir.name;
    const sessionDir = path.join(agentsDir, agentId, "sessions");
    let sessionFiles = [];
    try {
      sessionFiles = fs.readdirSync(sessionDir)
        .filter(isSessionJsonlFilename)
        .map((name) => path.join(sessionDir, name));
    } catch {
      sessionFiles = [];
    }

    for (const sessionFile of sessionFiles) {
      let changed = false;
      const outputLines = [];
      let raw = "";
      try {
        raw = fs.readFileSync(sessionFile, "utf-8");
      } catch {
        continue;
      }

      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;

        let entry;
        try {
          entry = JSON.parse(line);
        } catch {
          outputLines.push(line);
          continue;
        }

        const msg = entry?.message;
        if (entry?.type !== "message" || msg?.role !== "toolResult" || msg?.toolName !== "subagent" || !msg?.details) {
          outputLines.push(JSON.stringify(entry));
          continue;
        }

        const details = msg.details;
        const explicitIdentity = normalizeExecutorMetadata(details);
        const childSessionPath = details.sessionPath || null;
        const ownerIdentity = ownerIdentityFor(agentId);
        const inferredOwnerIdentity = childSessionPath
          ? ownerIdentityFor(inferOwnerAgentId(childSessionPath))
          : null;
        const identity = explicitIdentity || ownerIdentity || inferredOwnerIdentity;

        if (identity) {
          const before = JSON.stringify(details);
          mergeExecutorMetadata(details, identity);
          if (JSON.stringify(details) !== before) changed = true;
          if (childSessionPath) {
            rememberChildSessionIdentity(childSessionPath, identity, explicitIdentity ? 2 : 1);
          }
        }

        outputLines.push(JSON.stringify(entry));
      }

      if (changed) {
        fs.writeFileSync(sessionFile, outputLines.join("\n") + "\n", "utf-8");
        log(`[migrations] subagent executor metadata patched: ${sessionFile}`);
      }
    }
  }

  for (const dir of agentDirs) {
    const agentId = dir.name;
    const subagentDir = path.join(agentsDir, agentId, "subagent-sessions");
    let childFiles = [];
    try {
      childFiles = fs.readdirSync(subagentDir)
        .filter(isSessionJsonlFilename)
        .map((name) => path.join(subagentDir, name));
    } catch {
      childFiles = [];
    }

    for (const childFile of childFiles) {
      if (!childSessionCandidates.has(childFile)) {
        const sessionMeta = readSubagentSessionMetaSync(childFile);
        const identity = sessionMeta || ownerIdentityFor(agentId);
        rememberChildSessionIdentity(childFile, identity, sessionMeta ? 3 : 0);
      }
    }
  }

  const sidecarWrites = new Map();
  for (const [childSessionPath, { identity }] of childSessionCandidates) {
    if (!identity) continue;
    const metaPath = getSubagentSessionMetaPath(childSessionPath);
    if (!metaPath) continue;
    let meta = sidecarWrites.get(metaPath);
    if (!meta) {
      try {
        meta = fs.existsSync(metaPath)
          ? JSON.parse(fs.readFileSync(metaPath, "utf-8"))
          : {};
      } catch {
        meta = {};
      }
      sidecarWrites.set(metaPath, meta);
    }

    const sessKey = path.basename(childSessionPath);
    meta[sessKey] = {
      ...meta[sessKey],
      ...identity,
    };
  }

  for (const [metaPath, meta] of sidecarWrites) {
    fs.mkdirSync(path.dirname(metaPath), { recursive: true });
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + "\n", "utf-8");
    log(`[migrations] subagent session sidecar patched: ${metaPath}`);
  }

  const deferredTasksPath = path.join(lucHome, ".ephemeral", "deferred-tasks.json");
  try {
    if (!fs.existsSync(deferredTasksPath)) return;
    const deferredTasks = JSON.parse(fs.readFileSync(deferredTasksPath, "utf-8"));
    let changed = false;
    for (const task of Object.values(deferredTasks) as any[]) {
      if (task?.meta?.type !== "subagent") continue;
      const sessionPath = task.meta.sessionPath || null;
      const candidate =
        normalizeExecutorMetadata(task.meta)
        || (sessionPath ? childSessionCandidates.get(sessionPath)?.identity || readSubagentSessionMetaSync(sessionPath) : null)
        || (sessionPath ? ownerIdentityFor(inferOwnerAgentId(sessionPath)) : null);
      if (!candidate) continue;
      const before = JSON.stringify(task.meta);
      mergeExecutorMetadata(task.meta, candidate);
      if (JSON.stringify(task.meta) !== before) changed = true;
    }
    if (changed) {
      fs.mkdirSync(path.dirname(deferredTasksPath), { recursive: true });
      fs.writeFileSync(deferredTasksPath, JSON.stringify(deferredTasks, null, 2) + "\n", "utf-8");
      log(`[migrations] subagent deferred metadata patched: ${deferredTasksPath}`);
    }
  } catch (err) {
    log(`[migrations] deferred task patch skipped: ${err.message}`);
  }
}

/**
 * #5 — models.* 字段全量迁移到 {id, provider} 复合键对象
 *
 * 目标：运行时（非 UI 层）模型引用只有一种合法形态——{id, provider} 对象。
 * 之前历史数据里混存了三种：
 *   1. 裸 id 字符串 "glm-5.1"                 → 通过 added-models.yaml 推断 provider
 *   2. "provider/id" 字符串 "zhipu/glm-5.1"   → 拆成 {id, provider}
 *   3. {id, provider: ""} 半成品对象          → 视作裸 id 推断
 *
 * 作用范围：
 *   - 每个 agent 目录下 config.yaml 里的 models.{chat,utility,utility_large}
 *     （embedding 角色不在复合键范围内——走 embedding_api 独立配置）
 *   - preferences.json 的 {utility,utility_large}_model
 *
 * 推断规则：
 *   - "provider/id" → {provider, id}（直接拆）
 *   - 裸 id 或半成品对象：遍历 added-models.yaml 里每个 provider 的 models，
 *     取首个命中。多 provider 同 id 时取 added-models.yaml 第一个（已有行为不变）。
 *     找不到保留原值（避免热删有效配置，/providers 设置页重启会自愈）。
 */
function normalizeCompositeModelRefs(ctx, { migrationId }) {
  const { agentsDir, prefs, providerRegistry, log } = ctx;

  // ── 构建 id → provider 查找表（多 provider 同 id 取首个） ──
  const idToProvider = new Map();
  const rawProviders = providerRegistry.getAllProvidersRaw?.() || {};
  for (const [providerId, p] of Object.entries(rawProviders || {}) as [string, any][]) {
    for (const m of p.models || []) {
      const id = typeof m === "object" ? m.id : m;
      if (id && !idToProvider.has(id)) idToProvider.set(id, providerId);
    }
  }

  function normalize(ref) {
    // 返回 { value, changed }；value 为迁移后的值（可能是原值）
    if (!ref) return { value: ref, changed: false };

    // {id, provider} 对象
    if (typeof ref === "object") {
      if (ref.id && ref.provider) return { value: ref, changed: false };
      if (ref.id && !ref.provider) {
        const guess = idToProvider.get(ref.id);
        if (guess) return { value: { id: ref.id, provider: guess }, changed: true };
        return { value: ref, changed: false };
      }
      return { value: ref, changed: false };
    }

    if (typeof ref !== "string") return { value: ref, changed: false };

    // "provider/id"
    const slashIdx = ref.indexOf("/");
    if (slashIdx > 0 && slashIdx < ref.length - 1) {
      return { value: { provider: ref.slice(0, slashIdx), id: ref.slice(slashIdx + 1) }, changed: true };
    }

    // 裸 id
    const guess = idToProvider.get(ref);
    if (guess) return { value: { id: ref, provider: guess }, changed: true };
    return { value: ref, changed: false };
  }

  const ROLES = ["chat", "utility", "utility_large"];

  // ── agent config.yaml ──
  let agentDirs;
  try {
    agentDirs = readDirectoryLikeDirentsSync(agentsDir);
  } catch {
    agentDirs = [];
  }

  for (const dir of agentDirs) {
    const cfgPath = path.join(agentsDir, dir.name, "config.yaml");
    const config = safeReadYAMLSync(cfgPath, null, YAML);
    if (!config?.models) continue;

    let changed = false;
    const next = { ...config.models };
    for (const role of ROLES) {
      const { value, changed: ch } = normalize(config.models[role]);
      if (ch) {
        next[role] = value;
        changed = true;
        log(`[migrations] #${migrationId} ${dir.name}: models.${role} → ${value.provider}/${value.id}`);
      }
    }

    if (changed) {
      saveConfig(cfgPath, { models: next });
    }
  }

  // ── preferences.json (shared models) ──
  const preferences = prefs.getPreferences();
  let prefsChanged = false;
  const prefKeys = ["utility_model", "utility_large_model"];
  for (const key of prefKeys) {
    const { value, changed } = normalize(preferences[key]);
    if (changed) {
      preferences[key] = value;
      prefsChanged = true;
      log(`[migrations] #${migrationId} preferences.${key} → ${value.provider}/${value.id}`);
    }
  }
  if (prefsChanged) prefs.savePreferences(preferences);
}

function migrateModelRefsToCompositeKey(ctx) {
  normalizeCompositeModelRefs(ctx, { migrationId: 5 });
}

function repairPostMigrationModelRefs(ctx) {
  normalizeCompositeModelRefs(ctx, { migrationId: 8 });
}

/**
 * #6 — channels.enabled 统一迁移到 global preferences，尊重老用户意图
 *
 * 背景：旧版本 /channels/toggle 把 `channels.enabled` 通过 updateConfig 写入了
 * 每个被 toggle 过的 agent 的 config.yaml（因为 schema 当时没登记这是 global 字段）。
 * 现在把真相源收敛到 preferences.channels_enabled。
 *
 * 合并策略（因为老数据没时间戳，无法按"最后一次"取值）：
 *   - 任一 agent config 显式 `channels.enabled === true` → 最终保留 true（说明用户想用）
 *   - 所有显式值都是 false，或根本没人设过 → 最终 false（产品默认）
 *
 * 这样既尊重显式开过的老用户、不让他们升级后发现功能被强关，
 * 又让从没用过频道的大多数用户默认关闭（产品判断：bug 修之前 ticker 无条件跑，
 * 所以老行为里"config 显示开"并不代表用户真的想开，只有"显式设过 true"才能说明意图）。
 */
function migrateChannelsToGlobalDefaultOff(ctx) {
  const { agentsDir, prefs, log } = ctx;

  let agentDirs;
  try {
    agentDirs = readDirectoryLikeDirentsSync(agentsDir);
  } catch {
    agentDirs = [];
  }

  // ── 1. 扫描：收集老用户的显式意图 ──
  let anyEnabledTrue = false;
  let anyExplicit = false;

  for (const dir of agentDirs) {
    const cfgPath = path.join(agentsDir, dir.name, "config.yaml");
    const config = safeReadYAMLSync(cfgPath, null, YAML);
    if (!config?.channels || typeof config.channels !== "object") continue;
    if (!("enabled" in config.channels)) continue;
    anyExplicit = true;
    if (config.channels.enabled === true) anyEnabledTrue = true;
  }

  // ── 2. 清理所有 agent config.yaml 中错位的 channels.enabled ──
  for (const dir of agentDirs) {
    const cfgPath = path.join(agentsDir, dir.name, "config.yaml");
    const config = safeReadYAMLSync(cfgPath, null, YAML);
    if (!config?.channels || typeof config.channels !== "object") continue;

    let changed = false;
    if ("enabled" in config.channels) {
      delete config.channels.enabled;
      log(`[migrations] #6 ${dir.name}: 移除 agent-level channels.enabled`);
      changed = true;
    }
    if (Object.keys(config.channels).length === 0) {
      delete config.channels;
      changed = true;
    }

    if (changed) {
      writeSecretFileSync(cfgPath, YAML.dump(config, { indent: 2, lineWidth: -1, sortKeys: false, quotingType: '"' }));
    }
  }

  // ── 3. 写入 global preferences ──
  const finalValue = anyEnabledTrue;
  const preferences = prefs.getPreferences();
  preferences.channels_enabled = finalValue;
  prefs.savePreferences(preferences);

  if (anyEnabledTrue) {
    log(`[migrations] #6: preferences.channels_enabled = true（保留：检测到至少一个 agent 显式开启过）`);
  } else if (anyExplicit) {
    log(`[migrations] #6: preferences.channels_enabled = false（所有显式设置都是关闭）`);
  } else {
    log(`[migrations] #6: preferences.channels_enabled = false（无显式历史设置，按产品默认关闭）`);
  }
}

/**
 * #9 — bridge.readOnly 从 per-agent 收敛到 global preferences
 *
 * 历史上 readOnly 被放在 agent.config.bridge.readOnly，但页面语义后来演进为
 * 总开关。这里收敛到 preferences.bridge.readOnly，并清理所有 agent-level
 * 残留字段。
 *
 * 冲突策略：任一 agent 显式 true → 全局 true，保证更保守的权限边界。
 * 若 preferences 已有 bridge.readOnly，则以 preferences 为准，只做清理。
 */
function migrateBridgeReadOnlyToGlobal(ctx) {
  const { agentsDir, prefs, log } = ctx;

  let agentDirs;
  try {
    agentDirs = readDirectoryLikeDirentsSync(agentsDir);
  } catch {
    agentDirs = [];
  }

  let anyReadOnlyTrue = false;
  let anyExplicit = false;

  for (const dir of agentDirs) {
    const cfgPath = path.join(agentsDir, dir.name, "config.yaml");
    const config = safeReadYAMLSync(cfgPath, null, YAML);
    if (!config?.bridge || typeof config.bridge !== "object") continue;
    if (!("readOnly" in config.bridge)) continue;
    anyExplicit = true;
    if (config.bridge.readOnly === true) anyReadOnlyTrue = true;
  }

  for (const dir of agentDirs) {
    const cfgPath = path.join(agentsDir, dir.name, "config.yaml");
    const config = safeReadYAMLSync(cfgPath, null, YAML);
    if (!config?.bridge || typeof config.bridge !== "object") continue;
    if (!("readOnly" in config.bridge)) continue;

    delete config.bridge.readOnly;
    if (Object.keys(config.bridge).length === 0) delete config.bridge;

    writeSecretFileSync(cfgPath, YAML.dump(config, { indent: 2, lineWidth: -1, sortKeys: false, quotingType: '"' }));
    log(`[migrations] #9 ${dir.name}: 移除 agent-level bridge.readOnly`);
  }

  const preferences = prefs.getPreferences();
  const hadPrefsValue = typeof preferences.bridge?.readOnly === "boolean";
  const finalValue = hadPrefsValue
    ? preferences.bridge.readOnly
    : anyReadOnlyTrue;
  const bridgePrefs = { ...(preferences.bridge || {}) };
  if (finalValue) bridgePrefs.readOnly = true;
  else delete bridgePrefs.readOnly;
  if (Object.keys(bridgePrefs).length === 0) delete preferences.bridge;
  else preferences.bridge = bridgePrefs;
  prefs.savePreferences(preferences);

  if (hadPrefsValue && !anyExplicit) {
    log(`[migrations] #9: preferences.bridge.readOnly 保持现值 ${finalValue}`);
  } else if (anyReadOnlyTrue) {
    log(`[migrations] #9: preferences.bridge.readOnly = true（检测到至少一个 agent 显式开启）`);
  } else if (anyExplicit) {
    log(`[migrations] #9: preferences.bridge.readOnly = false（所有显式设置都是关闭）`);
  } else {
    log(`[migrations] #9: preferences.bridge.readOnly = false（无显式历史设置，按产品默认关闭）`);
  }
}

/**
 * #51 — 用户名正源从各 agent config 收敛到全局 preferences
 *
 * 名字描述的是使用者本人，跨 agent 必须一致：在设置里改一次名字，所有 agent
 * 都该跟着改口。历史上这个字段写在每个 agent 自己的 config.yaml 里，于是同一
 * 个人在不同 agent 那儿可能有好几份互相不同步的副本。
 *
 * 策略：先提升，再按值清理。
 * - 全局已有名字 → 整条迁移跳过，各 agent 里的值一律当作刻意覆盖，不动
 * - 否则取主 agent 的名字；主 agent 没配过就取第一个配过的；全都没有则不写
 * - 写入全局后，各 agent 里与全局值相同的副本删掉（重复数据），
 *   不同的保留下来当作刻意的 per-agent 覆盖
 */
function migrateUserNameToGlobalPreferences(ctx) {
  const { agentsDir, prefs, log } = ctx;
  const preferences = prefs.getPreferences();

  if (typeof preferences.userName === "string" && preferences.userName.trim()) {
    log(`[migrations] #51: preferences.userName 已存在，跳过`);
    return;
  }

  let agentDirs;
  try {
    agentDirs = readDirectoryLikeDirentsSync(agentsDir);
  } catch {
    agentDirs = [];
  }

  const readUserName = (cfg) => (typeof cfg?.user?.name === "string" ? cfg.user.name.trim() : "");

  // 主 agent 的名字最能代表用户本人，排在最前面挑
  const primaryAgentId = preferences.primaryAgent || "luc";
  const ordered = [...agentDirs].sort((a, b) => {
    if (a.name === primaryAgentId) return -1;
    if (b.name === primaryAgentId) return 1;
    return 0;
  });

  let chosen = "";
  for (const dir of ordered) {
    const cfg = safeReadYAMLSync(path.join(agentsDir, dir.name, "config.yaml"), null, YAML);
    const name = readUserName(cfg);
    if (name) {
      chosen = name;
      log(`[migrations] #51: 用户名取自 agent "${dir.name}"`);
      break;
    }
  }

  if (!chosen) {
    log(`[migrations] #51: 没有任何 agent 配置过用户名，不写入全局值`);
    return;
  }

  // 先把目的地写durable，再清理来源：清理中途失败也不会丢名字
  preferences.userName = chosen;
  prefs.savePreferences(preferences);
  log(`[migrations] #51: preferences.userName 已写入`);

  for (const dir of agentDirs) {
    const cfgPath = path.join(agentsDir, dir.name, "config.yaml");
    const config = safeReadYAMLSync(cfgPath, null, YAML);
    if (readUserName(config) !== chosen) continue;

    delete config.user.name;
    if (Object.keys(config.user).length === 0) delete config.user;

    writeSecretFileSync(cfgPath, YAML.dump(config, { indent: 2, lineWidth: -1, sortKeys: false, quotingType: '"' }));
    log(`[migrations] #51 ${dir.name}: 移除与全局值重复的 user.name`);
  }
}

/**
 * #52 — 清除 agent 级 user.name 覆盖层
 *
 * #51 把用户名的正源收敛到全局 preferences，但留了"值和全局不同就当作刻意的
 * per-agent 覆盖"这条尾巴。覆盖层现在取消了：一个用户一个名字，改一次称呼所有
 * agent 都跟着改口。读取侧已经不看 agent config 的 user.name，所以配置文件里
 * 残留的字段必须删掉，否则留着一个再也不生效的名字，下次谁读到都会被误导。
 *
 * 全局值为空时（#51 当时没有任何 agent 配过名字，或者用户装得比 #51 还早又
 * 一直没走到），先按 #51 的同款选择逻辑提升一个上去再清理，避免把用户唯一配过
 * 的名字直接删没。
 *
 * 幂等：字段删完之后重跑什么都不做。
 */
function migrateClearUserNameOverrides(ctx) {
  const { agentsDir, prefs, log } = ctx;
  const preferences = prefs.getPreferences();

  let agentDirs;
  try {
    agentDirs = readDirectoryLikeDirentsSync(agentsDir);
  } catch {
    agentDirs = [];
  }

  const readUserName = (cfg) => (typeof cfg?.user?.name === "string" ? cfg.user.name.trim() : "");

  // 全局还没名字：先提升一个，主 agent 的名字最能代表用户本人，排在最前面挑
  if (!(typeof preferences.userName === "string" && preferences.userName.trim())) {
    const primaryAgentId = preferences.primaryAgent || "luc";
    const ordered = [...agentDirs].sort((a, b) => {
      if (a.name === primaryAgentId) return -1;
      if (b.name === primaryAgentId) return 1;
      return 0;
    });
    for (const dir of ordered) {
      const cfg = safeReadYAMLSync(path.join(agentsDir, dir.name, "config.yaml"), null, YAML);
      const name = readUserName(cfg);
      if (name) {
        // 先把目的地写durable，再清理来源：清理中途失败也不会丢名字
        preferences.userName = name;
        prefs.savePreferences(preferences);
        log(`[migrations] #52: 用户名取自 agent "${dir.name}" 提升为全局值`);
        break;
      }
    }
  }

  for (const dir of agentDirs) {
    const cfgPath = path.join(agentsDir, dir.name, "config.yaml");
    const config = safeReadYAMLSync(cfgPath, null, YAML);
    if (!config?.user || !("name" in config.user)) continue;

    delete config.user.name;
    if (Object.keys(config.user).length === 0) delete config.user;

    writeSecretFileSync(cfgPath, YAML.dump(config, { indent: 2, lineWidth: -1, sortKeys: false, quotingType: '"' }));
    log(`[migrations] #52 ${dir.name}: 移除失效的 user.name 覆盖`);
  }
}

/**
 * 会话标题曾直接取首条 user 消息，而提交路径会在那条消息前面注入 reminder /
 * reference 信封和附件标记。没配摘要模型的用户于是拿到一堆信封字面量当标题
 * （截断到 30 字，所以只看得到开头）。
 *
 * 这里只删不改：标题条目删掉之后，列表回退到同样剥离过信封的首条消息展示，
 * 下一轮对话也可以重新生成。判定按前缀而不是完整标记正则——存量标题是截断
 * 过的，附件标记的结尾方括号大概率已经被切掉了。
 *
 * 幂等：脏条目删完之后重跑什么都不做。
 */
const ENVELOPE_TITLE_PREFIXES = [
  REMINDER_BLOCK_PREFIX,
  REFERENCE_BLOCK_PREFIX,
  "[attached_",
  "[SessionFile]",
];

function collectAgentSessionTitlePaths(agentsDir) {
  let agentDirs;
  try {
    agentDirs = readDirectoryLikeDirentsSync(agentsDir);
  } catch {
    return [];
  }

  const out = [];
  for (const dir of agentDirs) {
    const titlePath = path.join(agentsDir, dir.name, "sessions", "session-titles.json");
    try {
      if (fs.statSync(titlePath).isFile()) out.push(titlePath);
    } catch {
      // 还没生成过标题的 agent 没有这个文件，属于正常情况。
    }
  }
  return out;
}

function migrateCleanEnvelopeSessionTitles(ctx) {
  const { agentsDir, log } = ctx;
  let removed = 0;

  for (const titlePath of collectAgentSessionTitlePaths(agentsDir)) {
    let titles;
    try {
      titles = JSON.parse(fs.readFileSync(titlePath, "utf-8"));
    } catch (err) {
      log?.(`[migrations] #53: 跳过无法解析的标题文件 ${titlePath}: ${err.message}`);
      continue;
    }
    if (!titles || typeof titles !== "object" || Array.isArray(titles)) continue;

    let changed = false;
    for (const [sessionKey, title] of Object.entries(titles)) {
      if (typeof title !== "string") continue;
      if (!ENVELOPE_TITLE_PREFIXES.some((prefix) => title.startsWith(prefix))) continue;
      delete titles[sessionKey];
      changed = true;
      removed += 1;
    }
    if (!changed) continue;

    atomicWriteSync(titlePath, JSON.stringify(titles, null, 2));
  }

  log?.(`[migrations] #53: 清除注入信封污染的会话标题（${removed}）`);
}

/**
 * #3 — workspace 迁移 + 非主 agent 巡检默认关闭
 *
 * 两件事：
 * 1. home_folder 从全局 preferences 迁移到主 agent 的 config.yaml
 * 2. 非主 agent 的 heartbeat_enabled 设为 false（老用户预期只有主 agent 巡检）
 */
function migrateWorkspaceToPerAgent(ctx) {
  const { agentsDir, prefs, log } = ctx;
  const preferences = prefs.getPreferences();
  const homeFolder = preferences.home_folder;
  const primaryAgentId = preferences.primaryAgent || null;

  // ── 1. 找到主 agent ──

  let targetAgentId = null;

  if (primaryAgentId) {
    const cfgPath = path.join(agentsDir, primaryAgentId, "config.yaml");
    if (fs.existsSync(cfgPath)) {
      targetAgentId = primaryAgentId;
    } else {
      log(`[migrations] #3: primaryAgent "${primaryAgentId}" config.yaml not found, scanning`);
    }
  }

  if (!targetAgentId) {
    try {
      const dirs = readDirectoryLikeDirentsSync(agentsDir);
      for (const d of dirs) {
        if (fs.existsSync(path.join(agentsDir, d.name, "config.yaml"))) {
          targetAgentId = d.name;
          break;
        }
      }
    } catch {}
  }

  // ── 2. 迁移 home_folder ──

  if (homeFolder) {
    if (!targetAgentId) {
      throw new Error("no agent with config.yaml found, home_folder preserved in preferences");
    }

    const cfgPath = path.join(agentsDir, targetAgentId, "config.yaml");
    saveConfig(cfgPath, { desk: { home_folder: homeFolder } });

    // Verify write
    const verify = safeReadYAMLSync(cfgPath, null, YAML);
    if (verify?.desk?.home_folder !== homeFolder) {
      throw new Error(`write verification failed for agent ${targetAgentId}, home_folder preserved in preferences`);
    }

    delete preferences.home_folder;
    prefs.savePreferences(preferences);
    log(`[migrations] #3: migrated home_folder "${homeFolder}" → agent ${targetAgentId}`);
  }

  // ── 3. 非主 agent 的巡检默认关闭 ──

  try {
    const dirs = readDirectoryLikeDirentsSync(agentsDir);
    for (const d of dirs) {
      if (d.name === targetAgentId) continue; // 主 agent 保持原状
      const cfgPath = path.join(agentsDir, d.name, "config.yaml");
      if (!fs.existsSync(cfgPath)) continue;

      const config = safeReadYAMLSync(cfgPath, null, YAML);
      if (!config) continue;
      // 只在未显式设置过时关闭（如果用户已经手动设了，尊重他的选择）
      if (config.desk?.heartbeat_enabled !== undefined) continue;

      saveConfig(cfgPath, { desk: { heartbeat_enabled: false } });
      log(`[migrations] #3: disabled heartbeat for non-primary agent "${d.name}"`);
    }
  } catch (err) {
    log(`[migrations] #3: warning — failed to disable non-primary heartbeats: ${err.message}`);
  }
}

/**
 * #29 — 巡检默认显式关闭
 *
 * 旧配置里缺失 desk.heartbeat_enabled 时，运行时代码曾把它当成开启。
 * 现在产品默认是 opt-in：只有明确写 true 才启动巡检。
 * 迁移只补缺省 false，尊重用户已有 true / false。
 */
function migrateHeartbeatDefaultExplicitOff(ctx) {
  const { agentsDir, log } = ctx;
  let dirs;
  try {
    dirs = readDirectoryLikeDirentsSync(agentsDir);
  } catch {
    return;
  }

  for (const dir of dirs) {
    const cfgPath = path.join(agentsDir, dir.name, "config.yaml");
    if (!fs.existsSync(cfgPath)) continue;
    const config = safeReadYAMLSync(cfgPath, null, YAML);
    if (!config) continue;
    if (config.desk?.heartbeat_enabled !== undefined) continue;
    saveConfig(cfgPath, { desk: { heartbeat_enabled: false } });
    log(`[migrations] #29: heartbeat defaulted to false for "${dir.name}"`);
  }
}

/**
 * #33 — 小花美术默认显式关闭
 *
 * Beautify 是新加入的低频审美生成工具，默认先 opt-in。老配置若已经
 * 写过 tools.disabled: []，运行时无法判断它是否代表用户想开启这个
 * 未来工具，所以迁移显式把 beautify 补进 disabled。用户之后手动开关
 * 会正常覆盖这个值。
 */
function migrateBeautifyDefaultExplicitOff(ctx) {
  const { agentsDir, log } = ctx;
  let dirs;
  try {
    dirs = readDirectoryLikeDirentsSync(agentsDir);
  } catch {
    return;
  }

  for (const dir of dirs) {
    const cfgPath = path.join(agentsDir, dir.name, "config.yaml");
    if (!fs.existsSync(cfgPath)) continue;
    const config = safeReadYAMLSync(cfgPath, null, YAML);
    if (!config) continue;
    const existing = Array.isArray(config.tools?.disabled)
      ? config.tools.disabled
      : DEFAULT_DISABLED_TOOL_NAMES.filter((name) => name !== "beautify");
    if (existing.includes("beautify")) continue;
    saveConfig(cfgPath, { tools: { disabled: [...existing, "beautify"] } });
    log(`[migrations] #33: beautify defaulted to disabled for "${dir.name}"`);
  }
}

/**
 * #34 — workflow 工具默认显式关闭
 *
 * workflow 从全局高权限设置页开关迁移为 per-agent 工具开关，默认 opt-in 关闭。
 * 老配置的 tools.disabled 里不会有 workflow（旧机制下它不是 per-agent 工具），
 * 迁移显式把 workflow 补进 disabled，让升级用户默认关，需在助手页手动开启。
 * 已含则跳过（幂等），用户后续手动开关会正常覆盖。
 */
function migrateWorkflowDefaultExplicitOff(ctx) {
  const { agentsDir, log } = ctx;
  let dirs;
  try {
    dirs = readDirectoryLikeDirentsSync(agentsDir);
  } catch {
    return;
  }

  for (const dir of dirs) {
    const cfgPath = path.join(agentsDir, dir.name, "config.yaml");
    if (!fs.existsSync(cfgPath)) continue;
    const config = safeReadYAMLSync(cfgPath, null, YAML);
    if (!config) continue;
    const existing = Array.isArray(config.tools?.disabled)
      ? config.tools.disabled
      : DEFAULT_DISABLED_TOOL_NAMES.filter((name) => name !== "workflow");
    if (existing.includes("workflow")) continue;
    saveConfig(cfgPath, { tools: { disabled: [...existing, "workflow"] } });
    log(`[migrations] #34: workflow defaulted to disabled for "${dir.name}"`);
  }
}

const MINIMAX_TOKEN_PLAN_PROVIDER_ID = "minimax-token-plan";
const MINIMAX_TOKEN_PLAN_LEGACY_BASE_URLS = new Set([
  "https://api.minimax.io/v1",
  "https://api.minimaxi.com/v1",
]);
const MINIMAX_TOKEN_PLAN_LEGACY_API = "openai-completions";
const MINIMAX_CURRENT_ANTHROPIC_BASE_URL = "https://api.minimaxi.com/anthropic";
const MINIMAX_CURRENT_ANTHROPIC_API = "anthropic-messages";

function normalizeProviderUrlForMigration(value) {
  if (typeof value !== "string") return "";
  return value.trim().replace(/\/+$/, "");
}

/**
 * #35 — MiniMax Token Plan 接入点迁到当前官方 Anthropic-compatible API
 *
 * Token Plan 和普通 MiniMax 现在都走 api.minimaxi.com/anthropic，但密钥、
 * 套餐和 Provider ID 仍然是两套边界。本迁移只修旧官方默认值，遇到自定义
 * 代理或非官方 URL 时不猜测。
 */
function migrateMiniMaxTokenPlanAnthropicEndpoint(ctx) {
  const { lucHome, log } = ctx;
  const ymlPath = path.join(lucHome, "added-models.yaml");
  const raw = safeReadYAMLSync(ymlPath, null, YAML);
  if (!raw?.providers || typeof raw.providers !== "object") {
    log?.("[migrations] #35: MiniMax Token Plan endpoint migration skipped (no providers)");
    return;
  }

  const provider = raw.providers[MINIMAX_TOKEN_PLAN_PROVIDER_ID];
  if (!provider || typeof provider !== "object" || Array.isArray(provider)) {
    log?.("[migrations] #35: MiniMax Token Plan endpoint migrated (patched=0)");
    return;
  }

  const baseUrl = normalizeProviderUrlForMigration(provider.base_url);
  const api = typeof provider.api === "string" ? provider.api.trim() : "";
  const isLegacyOfficialDefault = MINIMAX_TOKEN_PLAN_LEGACY_BASE_URLS.has(baseUrl)
    && (!api || api === MINIMAX_TOKEN_PLAN_LEGACY_API);

  if (!isLegacyOfficialDefault) {
    log?.("[migrations] #35: MiniMax Token Plan endpoint migrated (patched=0)");
    return;
  }

  provider.base_url = MINIMAX_CURRENT_ANTHROPIC_BASE_URL;
  provider.api = MINIMAX_CURRENT_ANTHROPIC_API;

  const header =
    "# LucCode 供应商配置（全局，跨 agent 共享）\n" +
    "# 由设置页面管理\n\n";
  const yamlStr = header + YAML.dump(raw, {
    indent: 2,
    lineWidth: -1,
    sortKeys: false,
    quotingType: "\"",
    forceQuotes: false,
  });
  writeSecretFileSync(ymlPath, yamlStr);

  if (ctx.providerRegistry) {
    ctx.providerRegistry._addedModelsCache = null;
    ctx.providerRegistry._addedModelsMtime = 0;
  }

  log?.("[migrations] #35: MiniMax Token Plan endpoint migrated (patched=1)");
}

/**
 * #7 — 模型能力字段 vision → image 全量重命名
 *
 * 历史包袱：项目早期在 Pi SDK Model 对象上挂了一份自定义的 vision:boolean 字段，
 * 与 Pi SDK 标准字段 input 数组重复。本次统一到 Pi SDK 标准，
 * 把用户意图层（added-models.yaml + agent config.yaml）的 vision 重命名为 image，
 * 运行时层只保留 input 数组。
 *
 * 覆盖位置：
 *   1. ~/.luccode/added-models.yaml 的 providers.*.models[] 数组（用户主战场）
 *   2. ~/.luccode/agents/*\/config.yaml 的 models.overrides（历史残留兜底）
 *
 * 幂等：只在发现 vision 字段时改写；image 已存在时保留不覆盖。
 * 配合读时兼容（model-sync.js、provider-registry.js）形成双保险。
 */
function migrateVisionToImage(ctx) {
  const { lucHome, agentsDir, log } = ctx;
  let ymlCount = 0;
  let overrideCount = 0;

  // ── 1. added-models.yaml ──
  const ymlPath = path.join(lucHome, "added-models.yaml");
  const raw = safeReadYAMLSync(ymlPath, null, YAML);
  if (raw?.providers && typeof raw.providers === "object") {
    let changed = false;
    for (const prov of Object.values(raw.providers) as any[]) {
      if (!prov || !Array.isArray(prov.models)) continue;
      for (const m of prov.models) {
        if (!m || typeof m !== "object") continue;
        if (!Object.prototype.hasOwnProperty.call(m, "vision")) continue;
        if (m.image === undefined) m.image = m.vision;
        delete m.vision;
        changed = true;
        ymlCount++;
      }
    }
    if (changed) {
      const header =
        "# LucCode 供应商配置（全局，跨 agent 共享）\n" +
        "# 由设置页面管理\n\n";
      const yamlStr = header + YAML.dump(raw, {
        indent: 2,
        lineWidth: -1,
        sortKeys: false,
        quotingType: "\"",
        forceQuotes: false,
      });
      writeSecretFileSync(ymlPath, yamlStr);
    }
  }

  // ── 2. agent/*/config.yaml 的 models.overrides（兜底残留）──
  let agentDirs;
  try {
    agentDirs = readDirectoryLikeDirentsSync(agentsDir);
  } catch {
    agentDirs = [];
  }

  for (const dir of agentDirs) {
    const cfgPath = path.join(agentsDir, dir.name, "config.yaml");
    const cfg = safeReadYAMLSync(cfgPath, null, YAML);
    if (!cfg?.models?.overrides || typeof cfg.models.overrides !== "object") continue;

    let changed = false;
    for (const ov of Object.values(cfg.models.overrides) as any[]) {
      if (!ov || typeof ov !== "object") continue;
      if (!Object.prototype.hasOwnProperty.call(ov, "vision")) continue;
      if (ov.image === undefined) ov.image = ov.vision;
      delete ov.vision;
      changed = true;
      overrideCount++;
    }
    if (changed) {
      writeSecretFileSync(
        cfgPath,
        YAML.dump(cfg, { indent: 2, lineWidth: -1, sortKeys: false, quotingType: "\"" }),
      );
    }
  }

  log(`[migrations] #7: vision→image renamed (added-models.yaml=${ymlCount}, agent overrides=${overrideCount})`);
}

function buildModelProviderIndex(providerRegistry) {
  const idToProvider = new Map();
  const providerModelIds = new Map();
  const rawProviders = providerRegistry.getAllProvidersRaw?.() || {};

  for (const [providerId, provider] of Object.entries(rawProviders || {}) as [string, any][]) {
    const ids = new Set();
    for (const m of provider?.models || []) {
      const id = typeof m === "object" ? m.id : m;
      if (!id) continue;
      ids.add(id);
      if (!idToProvider.has(id)) idToProvider.set(id, providerId);
    }
    providerModelIds.set(providerId, ids);
  }

  return { idToProvider, providerModelIds };
}

function normalizeCronModelRefForMigration(ref, index) {
  if (!ref) return { value: "", changed: ref !== "" };

  if (typeof ref === "object") {
    if (!ref.id) return { value: ref, changed: false };
    if (ref.provider) return { value: ref, changed: false };
    const provider = index.idToProvider.get(ref.id);
    if (provider) return { value: { id: ref.id, provider }, changed: true };
    return { value: ref, changed: false };
  }

  if (typeof ref !== "string") return { value: ref, changed: false };

  const s = ref.trim();
  if (!s) return { value: "", changed: ref !== "" };

  // 先按完整 id 查，避免把 openrouter 这类包含 "/" 的裸模型 id 误拆成 provider/id。
  const exactProvider = index.idToProvider.get(s);
  if (exactProvider) return { value: { id: s, provider: exactProvider }, changed: true };

  const slashIdx = s.indexOf("/");
  if (slashIdx > 0 && slashIdx < s.length - 1) {
    const provider = s.slice(0, slashIdx);
    const id = s.slice(slashIdx + 1);
    const knownIds = index.providerModelIds.get(provider);
    if (knownIds?.has(id) || index.providerModelIds.has(provider)) {
      return { value: { id, provider }, changed: true };
    }
  }

  return { value: ref, changed: false };
}

/**
 * #11 — cron job 的 model 字段迁移为复合键对象
 *
 * v0.11x 的模型复合键重构要求运行期模型引用必须带 provider，但 cron 任务
 * 仍把 UI 选择的模型保存为裸 id，导致后台执行时偶发 "找不到模型"。
 */
function repairCronJobModelRefs(ctx) {
  const { agentsDir, providerRegistry, log } = ctx;
  const index = buildModelProviderIndex(providerRegistry);

  let agentDirs;
  try {
    agentDirs = readDirectoryLikeDirentsSync(agentsDir);
  } catch {
    return;
  }

  let patched = 0;
  for (const dir of agentDirs) {
    const jobsPath = path.join(agentsDir, dir.name, "desk", "cron-jobs.json");
    if (!fs.existsSync(jobsPath)) continue;

    let data;
    try {
      data = JSON.parse(fs.readFileSync(jobsPath, "utf-8"));
    } catch (err) {
      log(`[migrations] #11 ${dir.name}: skipped invalid cron-jobs.json (${err.message})`);
      continue;
    }
    if (!Array.isArray(data.jobs)) continue;

    let changed = false;
    for (const job of data.jobs) {
      const { value, changed: modelChanged } = normalizeCronModelRefForMigration(job.model, index);
      if (!modelChanged) continue;
      job.model = value;
      changed = true;
      patched++;
    }

    if (changed) {
      const tmp = jobsPath + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf-8");
      fs.renameSync(tmp, jobsPath);
      log(`[migrations] #11 ${dir.name}: repaired cron model refs`);
    }
  }

  log(`[migrations] #11: cron model refs repaired (${patched})`);
}

/**
 * #30 — cron job 补齐 automation read model 字段
 *
 * v0 Automation Executor 把旧 cron job 的 "什么时候" 与 "做什么" 拆成
 * trigger + executor。迁移只补字段，不删除 type / schedule / prompt 等旧字段。
 */
function migrateCronJobsToAutomationReadModel(ctx) {
  const { lucHome, agentsDir, log } = ctx;
  const paths = [];

  const studiosDir = path.join(lucHome, "studios");
  try {
    for (const entry of fs.readdirSync(studiosDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      paths.push(path.join(studiosDir, entry.name, "desk", "cron-jobs.json"));
    }
  } catch {}

  try {
    for (const entry of readDirectoryLikeDirentsSync(agentsDir)) {
      paths.push(path.join(agentsDir, entry.name, "desk", "cron-jobs.json"));
    }
  } catch {}

  let patchedFiles = 0;
  let patchedJobs = 0;
  for (const jobsPath of paths) {
    const result = patchCronJobsFileForAutomation(jobsPath, log);
    if (!result.changed) continue;
    patchedFiles++;
    patchedJobs += result.patchedJobs;
  }

  log?.(`[migrations] #30: cron automation fields patched (${patchedJobs} jobs in ${patchedFiles} files)`);
}

function patchCronJobsFileForAutomation(jobsPath, log) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(jobsPath, "utf-8"));
  } catch (err) {
    if (err.code !== "ENOENT") {
      log?.(`[migrations] #30 skipped invalid cron-jobs.json at ${jobsPath} (${err.message})`);
    }
    return { changed: false, patchedJobs: 0 };
  }
  if (!Array.isArray(data.jobs)) return { changed: false, patchedJobs: 0 };

  let patchedJobs = 0;
  const jobs = data.jobs.map((job) => {
    const next = patchAutomationJobForMigration(job);
    if (JSON.stringify(next) !== JSON.stringify(job)) patchedJobs++;
    return next;
  });
  if (!patchedJobs) return { changed: false, patchedJobs: 0 };

  atomicWriteSync(jobsPath, JSON.stringify({ ...data, jobs }, null, 2) + "\n");
  return { changed: true, patchedJobs };
}

function migrateProviderCatalogV2Cutover(ctx) {
  const { lucHome, providerRegistry, log } = ctx;
  const store = providerRegistry?._catalog || new ProviderCatalogStore(lucHome);
  const catalog = store.cutoverFromLegacy();
  if (providerRegistry) {
    providerRegistry._addedModelsCache = null;
    providerRegistry._addedModelsMtime = 0;
    providerRegistry._entries?.clear?.();
  }
  log?.(`[migrations] #42: provider catalog v2 ready (${Object.keys(catalog.providers || {}).length} providers)`);
}

const CODEX_IMAGE_PROVIDER_ID = "openai-codex-oauth";

function migrateCodexImageGenerationDefaultsToResolutionSchema(ctx) {
  const { lucHome, prefs, log } = ctx;
  const preferences = prefs.getPreferences();
  const prefsChanged = removeCodexImageSizeDefault(
    preferences?.imageGeneration?.providerDefaults,
  );
  if (prefsChanged) {
    prefs.savePreferences(preferences);
  }

  const pluginChanged = removeCodexImageSizeDefaultFromPluginConfig(lucHome, log);
  log?.(`[migrations] #43: Codex stale image size defaults removed (preferences=${prefsChanged}, pluginConfig=${pluginChanged})`);
}

const CODEX_OAUTH_PROVIDER_ID = "openai-codex-oauth";
const CODEX_OAUTH_RUNTIME_ALIAS = "openai-codex";

function migrationModelId(model) {
  return typeof model === "object" && model !== null ? model.id : model;
}

function mergeMigrationModelLists(...lists) {
  const order = [];
  const byId = new Map();
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const rawModel of list) {
      const id = migrationModelId(rawModel);
      if (typeof id !== "string" || !id.trim()) continue;
      const normalizedId = id.trim();
      const incoming = typeof rawModel === "object" && rawModel !== null
        ? { ...rawModel, id: normalizedId }
        : normalizedId;
      if (!byId.has(normalizedId)) {
        order.push(normalizedId);
        byId.set(normalizedId, incoming);
        continue;
      }
      const current = byId.get(normalizedId);
      if (typeof incoming === "object") {
        byId.set(normalizedId, typeof current === "object"
          ? { ...current, ...incoming, id: normalizedId }
          : incoming);
      }
    }
  }
  return order.map((id) => byId.get(id));
}

function nonEmptyMigrationModels(config) {
  return Array.isArray(config?.models) && config.models.length > 0 ? config.models : null;
}

function migrateOAuthModelsToProviderCatalog(ctx) {
  const { lucHome, prefs, providerRegistry, log } = ctx;
  const store = providerRegistry?._catalog || new ProviderCatalogStore(lucHome);
  const catalog = store.load();
  const providers = structuredClone(catalog.providers || {});
  const preferences = prefs.getPreferences();
  const customByProvider = preferences?.oauth_custom_models && typeof preferences.oauth_custom_models === "object"
    ? preferences.oauth_custom_models
    : {};

  const legacyCodex = providers[CODEX_OAUTH_RUNTIME_ALIAS];
  const canonicalCodex = providers[CODEX_OAUTH_PROVIDER_ID];
  const codexCustom = mergeMigrationModelLists(
    customByProvider[CODEX_OAUTH_RUNTIME_ALIAS],
    customByProvider[CODEX_OAUTH_PROVIDER_ID],
  );
  if (legacyCodex || canonicalCodex || codexCustom.length > 0) {
    const { models: _legacyModels, ...legacyScalars } = legacyCodex || {};
    const { models: _canonicalModels, ...canonicalScalars } = canonicalCodex || {};
    const mergedConfig = { ...legacyScalars, ...canonicalScalars };
    delete mergedConfig.api_key;

    const explicitModels = mergeMigrationModelLists(
      nonEmptyMigrationModels(legacyCodex),
      nonEmptyMigrationModels(canonicalCodex),
    );
    if (explicitModels.length > 0) {
      mergedConfig.models = mergeMigrationModelLists(explicitModels, codexCustom);
    } else if (codexCustom.length > 0) {
      mergedConfig.models = mergeMigrationModelLists(
        providerRegistry?.getDefaultModels?.(CODEX_OAUTH_PROVIDER_ID) || [],
        codexCustom,
      );
    }
    // 旧版本的 models: [] 表示“没有 allowlist，使用 SDK 目录”。迁移时删除空字段，
    // 让它进入新的 Luc/plugin 默认语义；#44 之后新写入的 [] 才表示明确关闭。
    providers[CODEX_OAUTH_PROVIDER_ID] = mergedConfig;
  }
  delete providers[CODEX_OAUTH_RUNTIME_ALIAS];

  for (const [legacyProviderId, rawCustomModels] of Object.entries(customByProvider) as [string, any][]) {
    if (legacyProviderId === CODEX_OAUTH_RUNTIME_ALIAS || legacyProviderId === CODEX_OAUTH_PROVIDER_ID) continue;
    if (!Array.isArray(rawCustomModels) || rawCustomModels.length === 0) continue;
    const resolved = providerRegistry?.resolveChatProvider?.(legacyProviderId);
    const providerId = resolved?.sourceProviderId || legacyProviderId;
    const current = providers[providerId] || {};
    const currentModels = nonEmptyMigrationModels(current)
      || providerRegistry?.getDefaultModels?.(providerId)
      || [];
    providers[providerId] = {
      ...current,
      models: mergeMigrationModelLists(currentModels, rawCustomModels),
    };
  }

  store.saveProviders(providers, { oauthCustomModelsMigratedAt: new Date().toISOString() });
  if (Object.prototype.hasOwnProperty.call(preferences, "oauth_custom_models")) {
    delete preferences.oauth_custom_models;
    prefs.savePreferences(preferences);
  }
  if (providerRegistry) {
    providerRegistry._addedModelsCache = null;
    providerRegistry._addedModelsMtime = 0;
    providerRegistry._entries?.clear?.();
  }
  log?.(`[migrations] #44: OAuth models moved to Provider Catalog (providers=${Object.keys(customByProvider).length})`);
}

const CODEX_OAUTH_PROVIDER_IDS = new Set([
  CODEX_OAUTH_PROVIDER_ID,
  CODEX_OAUTH_RUNTIME_ALIAS,
]);

const MODEL_ID_KEYS_BY_PROVIDER_KEY = new Map([
  ["provider", ["id", "modelId", "model"]],
  ["providerId", ["id", "modelId", "model"]],
  ["modelProvider", ["id", "modelId", "model"]],
  ["model_provider", ["id", "modelId", "model"]],
  ["modelOverrideProvider", ["modelOverrideId", "modelId", "model"]],
  ["model_override_provider", ["model_override_id", "modelId", "model"]],
  ["agentPhoneModelOverrideProvider", ["agentPhoneModelOverrideId"]],
]);

// Session event records — `model_change` entries and assistant `message`
// entries written by the Pi SDK session writer (core/session-manager.js
// appendModelChange / appendMessage) — always carry the record's OWN event id
// under `id` (an 8-hex session-tree node id from randomUUID().slice(0, 8)),
// never a model id. Only `modelId` (model_change) or `model` (assistant
// message) legitimately hold a Codex model id in these two shapes.
//
// This cannot be merged into MODEL_ID_KEYS_BY_PROVIDER_KEY above: both shapes
// key their provider under the same "provider" property name that legitimate
// model *descriptor* objects also use (e.g. `{ provider, id }` stored in
// preferences.utility_model, config.models.chat, entry.model snapshots).
// Descriptor objects are never event records — their `id` genuinely is the
// model id — so the key name alone can't distinguish the two shapes. The
// distinguishing fact is the caller's structural knowledge of which shape it
// is looking at (an event-record field vs. a standalone descriptor value),
// which is exactly what routes callers to this table instead of the one
// above. See collectCodexEventRecordModelReference.
const EVENT_RECORD_MODEL_ID_KEYS_BY_PROVIDER_KEY = new Map([
  ["provider", ["modelId", "model"]],
]);

const PROVIDER_SCOPED_MODEL_VALUE_KEYS = new Set([
  "chat",
  "utility",
  "utility_large",
  "model",
  "modelId",
  "defaultModel",
  "modelOverrideId",
  "model_override_id",
  "agentPhoneModelOverrideId",
]);

function migrationCodexProviderId(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return CODEX_OAUTH_PROVIDER_IDS.has(normalized) ? normalized : null;
}

function migrationCodexModelId(value) {
  if (typeof value !== "string") return null;
  let normalized = value.trim();
  if (!normalized) return null;
  for (const providerId of CODEX_OAUTH_PROVIDER_IDS) {
    const prefix = `${providerId}/`;
    if (normalized.startsWith(prefix)) {
      normalized = normalized.slice(prefix.length).trim();
      break;
    }
  }
  return normalized || null;
}

/**
 * Extracts referenced Codex OAuth model ids from a model *descriptor* value —
 * e.g. `{ provider, id }` stored in preferences.utility_model, an agent
 * config.yaml models.chat ref, a DM/channel frontmatter override, or a cron
 * job's model field. In this shape `id` legitimately identifies the model.
 */
function collectCodexModelReference(value, modelIds) {
  collectCodexModelReferenceWithKeyTable(value, modelIds, MODEL_ID_KEYS_BY_PROVIDER_KEY);
}

/**
 * Extracts referenced Codex OAuth model ids from a session *event record* —
 * a `model_change` entry or an assistant `message` entry. These shapes carry
 * their own session-tree event id under `id`, which must never be read as a
 * model id (see EVENT_RECORD_MODEL_ID_KEYS_BY_PROVIDER_KEY above).
 */
function collectCodexEventRecordModelReference(value, modelIds) {
  collectCodexModelReferenceWithKeyTable(value, modelIds, EVENT_RECORD_MODEL_ID_KEYS_BY_PROVIDER_KEY);
}

function collectCodexModelReferenceWithKeyTable(value, modelIds, keyTable) {
  if (typeof value === "string") {
    const modelId = migrationCodexModelIdFromQualifiedRef(value);
    if (modelId) modelIds.add(modelId);
    return;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return;

  for (const [providerKey, modelKeys] of keyTable) {
    if (!migrationCodexProviderId(value[providerKey])) continue;
    for (const modelKey of modelKeys) {
      const modelId = migrationCodexModelId(value[modelKey]);
      if (modelId) modelIds.add(modelId);
    }
  }

  for (const [key, entry] of Object.entries(value)) {
    if (PROVIDER_SCOPED_MODEL_VALUE_KEYS.has(key)) {
      const modelId = typeof entry === "string"
        ? migrationCodexModelIdFromQualifiedRef(entry)
        : null;
      if (modelId) modelIds.add(modelId);
    }
  }
}

function migrationCodexModelIdFromQualifiedRef(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  for (const providerId of CODEX_OAUTH_PROVIDER_IDS) {
    const prefix = `${providerId}/`;
    if (normalized.startsWith(prefix)) {
      return migrationCodexModelId(normalized);
    }
  }
  return null;
}

function migrationPathIsInsideHome(lucHome, candidatePath) {
  const homeKey = filesystemIdentityKeySync(lucHome);
  const candidateKey = filesystemIdentityKeySync(candidatePath);
  return candidateKey === homeKey || candidateKey.startsWith(homeKey + path.sep);
}

function migrationRealDirectory(lucHome, directory) {
  try {
    return fs.lstatSync(directory).isDirectory()
      && migrationPathIsInsideHome(lucHome, directory);
  } catch {
    return false;
  }
}

function migrationRealFile(lucHome, filePath) {
  try {
    return fs.lstatSync(filePath).isFile()
      && migrationPathIsInsideHome(lucHome, filePath);
  } catch {
    return false;
  }
}

function migrationReadDirectoryEntries(lucHome, directory, log) {
  if (!migrationRealDirectory(lucHome, directory)) return [];
  try {
    return fs.readdirSync(directory, { withFileTypes: true });
  } catch (err) {
    log?.(`[migrations] #45 skipped unreadable directory ${directory} (${err.message})`);
    return [];
  }
}

function migrationWalkRealFiles(lucHome, root, accept, log) {
  const files = [];
  const walk = (directory) => {
    for (const entry of migrationReadDirectoryEntries(lucHome, directory, log)) {
      // Never follow directory or file symlinks. A user-managed link may point
      // outside LUC_HOME, and migration discovery must remain read-only there.
      if (entry.isSymbolicLink()) continue;
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(entryPath);
      } else if (entry.isFile() && accept(entryPath)) {
        files.push(entryPath);
      }
    }
  };
  if (migrationRealDirectory(lucHome, root)) walk(root);
  return files;
}

function migrationReadStructuredFile(filePath, parser, modelIds, log, kind) {
  try {
    const parsed = parser(fs.readFileSync(filePath, "utf-8"));
    return parsed;
  } catch (err) {
    log?.(`[migrations] #45 skipped invalid ${kind} at ${filePath} (${err.message})`);
    return null;
  }
}

function migrationReadSessionJsonl(filePath, modelIds, log) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch (err) {
    log?.(`[migrations] #45 skipped unreadable session JSONL at ${filePath} (${err.message})`);
    return;
  }

  const lines = raw.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    if (!lines[index].trim()) continue;
    try {
      const entry = JSON.parse(lines[index]);
      if (entry?.type === "model_change") collectCodexEventRecordModelReference(entry, modelIds);
      if (entry?.type === "message" && entry.message?.role === "assistant") {
        collectCodexEventRecordModelReference(entry.message, modelIds);
      }
      // Some older Luc-produced snapshots stored the restored model beside
      // the entry as a bare `{ provider, id }` descriptor rather than as a
      // model_change record — that's a descriptor, not an event record, so
      // its `id` is read through the descriptor-context extractor.
      collectCodexModelReference(entry?.model, modelIds);
    } catch (err) {
      log?.(`[migrations] #45 skipped invalid session JSONL line at ${filePath}:${index + 1} (${err.message})`);
    }
  }
}

function migrationFrontmatter(raw) {
  const lines = raw.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") throw new Error("missing frontmatter opener");
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end < 0) throw new Error("missing frontmatter closer");
  const parsed = YAML.load(lines.slice(1, end).join("\n"));
  return parsed && typeof parsed === "object" ? parsed : {};
}

function collectCodexModelsFromLegacyPersistence(ctx) {
  const { lucHome, agentsDir, prefs, log } = ctx;
  const modelIds = new Set();
  const preferences = prefs.getPreferences();
  collectCodexModelReference(preferences.utility_model, modelIds);
  collectCodexModelReference(preferences.utility_large_model, modelIds);

  const agentEntries = migrationReadDirectoryEntries(lucHome, agentsDir, log)
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink());
  for (const agentEntry of agentEntries) {
    const agentDir = path.join(agentsDir, agentEntry.name);
    const configPath = path.join(agentDir, "config.yaml");
    if (migrationRealFile(lucHome, configPath)) {
      const config = migrationReadStructuredFile(configPath, YAML.load, modelIds, log, "agent config.yaml");
      for (const role of ["chat", "utility", "utility_large"]) {
        collectCodexModelReference(config?.models?.[role], modelIds);
      }
    }

    const dmDir = path.join(agentDir, "dm");
    for (const entry of migrationReadDirectoryEntries(lucHome, dmDir, log)) {
      if (entry.isSymbolicLink() || !entry.isFile() || !entry.name.endsWith(".md")) continue;
      const dmPath = path.join(dmDir, entry.name);
      const frontmatter = migrationReadStructuredFile(dmPath, migrationFrontmatter, modelIds, log, "DM frontmatter");
      collectCodexModelReference(frontmatter, modelIds);
    }

    const cronPath = path.join(agentDir, "desk", "cron-jobs.json");
    if (migrationRealFile(lucHome, cronPath)) {
      const cron = migrationReadStructuredFile(cronPath, JSON.parse, modelIds, log, "agent cron-jobs.json");
      collectCodexModelsFromCronJobs(cron, modelIds);
    }
  }

  for (const sessionPath of migrationWalkRealFiles(
    lucHome,
    agentsDir,
    (filePath) => filePath.endsWith(".jsonl"),
    log,
  )) {
    migrationReadSessionJsonl(sessionPath, modelIds, log);
  }

  const studiosDir = path.join(lucHome, "studios");
  for (const studioEntry of migrationReadDirectoryEntries(lucHome, studiosDir, log)) {
    if (studioEntry.isSymbolicLink() || !studioEntry.isDirectory()) continue;
    const cronPath = path.join(studiosDir, studioEntry.name, "desk", "cron-jobs.json");
    if (migrationRealFile(lucHome, cronPath)) {
      const cron = migrationReadStructuredFile(cronPath, JSON.parse, modelIds, log, "Studio cron-jobs.json");
      collectCodexModelsFromCronJobs(cron, modelIds);
    }
  }

  const channelsDir = path.join(lucHome, "channels");
  for (const entry of migrationReadDirectoryEntries(lucHome, channelsDir, log)) {
    if (entry.isSymbolicLink() || !entry.isFile() || !entry.name.endsWith(".md")) continue;
    const channelPath = path.join(channelsDir, entry.name);
    const frontmatter = migrationReadStructuredFile(channelPath, migrationFrontmatter, modelIds, log, "channel frontmatter");
    collectCodexModelReference(frontmatter, modelIds);
  }

  return [...modelIds];
}

function collectCodexModelsFromCronJobs(cron, modelIds) {
  if (!Array.isArray(cron?.jobs)) return;
  for (const job of cron.jobs) {
    collectCodexModelReference(job?.model, modelIds);
    collectCodexModelReference(job?.executor?.model, modelIds);
  }
}

function recoverReferencedCodexOAuthModels(ctx) {
  const { lucHome, providerRegistry, log } = ctx;
  const referencedModels = collectCodexModelsFromLegacyPersistence(ctx);
  if (referencedModels.length === 0) {
    log?.("[migrations] #45: no persisted Codex OAuth model references found");
    return;
  }

  const store = providerRegistry?._catalog || new ProviderCatalogStore(lucHome);
  const catalog = store.load();
  const providers = structuredClone(catalog.providers || {});
  const current = providers[CODEX_OAUTH_PROVIDER_ID] || {};
  const hasExplicitModels = Object.prototype.hasOwnProperty.call(current, "models");

  if (hasExplicitModels && Array.isArray(current.models) && current.models.length === 0) {
    log?.(`[migrations] #45: preserved explicit empty Codex OAuth model allowlist (references=${referencedModels.length})`);
    return;
  }
  if (hasExplicitModels && !Array.isArray(current.models)) {
    log?.("[migrations] #45: skipped malformed Codex OAuth model allowlist");
    return;
  }

  const defaults = providerRegistry?.getDefaultModelEntries?.(CODEX_OAUTH_PROVIDER_ID)
    || providerRegistry?.getDefaultModels?.(CODEX_OAUTH_PROVIDER_ID)
    || [];
  const nextModels = hasExplicitModels
    ? mergeMigrationModelLists(current.models, referencedModels)
    : mergeMigrationModelLists(defaults, referencedModels);
  const next = { ...current, models: nextModels };
  if (JSON.stringify(next) === JSON.stringify(current)) {
    log?.(`[migrations] #45: persisted Codex OAuth references already available (references=${referencedModels.length})`);
    return;
  }

  providers[CODEX_OAUTH_PROVIDER_ID] = next;
  store.saveProviders(providers);
  if (providerRegistry) {
    providerRegistry._addedModelsCache = null;
    providerRegistry._addedModelsMtime = 0;
    providerRegistry._entries?.clear?.();
  }
  log?.(`[migrations] #45: recovered persisted Codex OAuth models (references=${referencedModels.length}, models=${nextModels.length})`);
}

function writeProviderModelMetadataMigrationBackup({ store, lucHome, repairs }) {
  if (!fs.existsSync(store.catalogPath)) {
    throw new Error("provider catalog source is missing before metadata repair");
  }

  const backupRoot = migrationBackupsRoot(lucHome);
  fs.mkdirSync(backupRoot, { recursive: true });
  ensureSecretDirModeSync(backupRoot);
  const backupDir = fs.mkdtempSync(path.join(backupRoot, "provider-model-metadata-v46-"));
  const backupPath = path.join(backupDir, path.basename(store.catalogPath));
  // 逐字节复制，不做解码再编码：备份必须与源文件完全一致
  fs.copyFileSync(store.catalogPath, backupPath);
  ensureSecretFileModeSync(backupPath);

  const report = {
    migration: 46,
    createdAt: new Date().toISOString(),
    sourceFile: path.basename(store.catalogPath),
    repairs,
  };
  writeSecretFileSync(
    path.join(backupDir, "migration-report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  return backupDir;
}

function repairLegacyProviderModelMetadata(ctx) {
  const { lucHome, providerRegistry, log } = ctx;
  const store = providerRegistry?._catalog || new ProviderCatalogStore(lucHome);
  const catalog = store.load();
  const result = repairProviderModelMetadata(catalog.providers || {});
  if (!result.changed) {
    log?.("[migrations] #46: Provider Catalog model metadata already valid");
    return;
  }

  const backupDir = writeProviderModelMetadataMigrationBackup({
    store,
    lucHome,
    repairs: result.repairs,
  });
  store.saveProviders(result.providers);
  if (providerRegistry) {
    providerRegistry._addedModelsCache = null;
    providerRegistry._addedModelsMtime = 0;
    providerRegistry._entries?.clear?.();
  }

  for (const repair of result.repairs) {
    log?.(
      `[migrations] #46 repaired ${repair.providerId}/${repair.modelId} fields: ${repair.fields.join(", ")}`,
    );
  }
  log?.(
    `[migrations] #46: repaired Provider Catalog model metadata (models=${result.repairs.length}, backup=${path.basename(backupDir)})`,
  );
}

/**
 * #49 — 清理迁移 #45 误把 session 事件 id 收成 Codex 模型 id 而写入
 * Provider Catalog 的污染条目。
 *
 * 识别标准是闭环证据法，不是模式匹配：重新走一遍 #45 当时扫描的同一批持久化
 * 面，用修复后的提取器算出 S_correct（真正被引用过的模型 id），再单独重放
 * model_change / assistant message 两种事件记录形状下"把 id 当模型 id 读"这一
 * 具体错误算出 S_wrong（旧版提取器会误收的 id 集合）。S_wrong 里但不在
 * S_correct 里的 id 才是可证伪的污染条目；真实模型 id 即使恰好撞上某个事件
 * id，只要它同时被 S_correct 收录（换句话说，它在别处也被合法引用过），就
 * 保留不删。禁止按"八位十六进制"之类的形状特征直接匹配删除。
 */
function collectPreFixPollutedCodexEventIds(ctx) {
  const { lucHome, agentsDir, log } = ctx;
  const wrongIds = new Set();

  for (const sessionPath of migrationWalkRealFiles(
    lucHome,
    agentsDir,
    (filePath) => filePath.endsWith(".jsonl"),
    log,
  )) {
    let raw;
    try {
      raw = fs.readFileSync(sessionPath, "utf-8");
    } catch (err) {
      log?.(`[migrations] #49 skipped unreadable session JSONL at ${sessionPath} (${err.message})`);
      continue;
    }

    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        // #45's own scan already logs malformed lines when it computes
        // S_correct; skip silently here to avoid duplicate log noise.
        continue;
      }

      if (entry?.type === "model_change" && migrationCodexProviderId(entry.provider)) {
        const wrongId = migrationCodexModelId(entry.id);
        if (wrongId) wrongIds.add(wrongId);
      }
      if (
        entry?.type === "message"
        && entry.message?.role === "assistant"
        && migrationCodexProviderId(entry.message?.provider)
      ) {
        const wrongId = migrationCodexModelId(entry.message?.id);
        if (wrongId) wrongIds.add(wrongId);
      }
    }
  }

  return wrongIds;
}

function writeCodexEventIdPollutionRepairBackup({ store, lucHome, removed }) {
  if (!fs.existsSync(store.catalogPath)) {
    throw new Error("provider catalog source is missing before Codex event-id pollution repair");
  }

  const backupRoot = migrationBackupsRoot(lucHome);
  fs.mkdirSync(backupRoot, { recursive: true });
  ensureSecretDirModeSync(backupRoot);
  const backupDir = fs.mkdtempSync(path.join(backupRoot, "codex-model-id-pollution-v49-"));
  const backupPath = path.join(backupDir, path.basename(store.catalogPath));
  // 逐字节复制，不做解码再编码：备份必须与源文件完全一致
  fs.copyFileSync(store.catalogPath, backupPath);
  ensureSecretFileModeSync(backupPath);

  const report = {
    migration: 49,
    createdAt: new Date().toISOString(),
    sourceFile: path.basename(store.catalogPath),
    removed,
  };
  writeSecretFileSync(
    path.join(backupDir, "migration-report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  return backupDir;
}

function repairPollutedCodexEventIdModels(ctx) {
  const { lucHome, providerRegistry, log } = ctx;
  const store = providerRegistry?._catalog || new ProviderCatalogStore(lucHome);

  let catalog;
  try {
    catalog = store.load();
  } catch (err) {
    log?.(`[migrations] #49 skipped unreadable provider catalog (${err.message})`);
    return;
  }

  const providers = structuredClone(catalog.providers || {});
  const current = providers[CODEX_OAUTH_PROVIDER_ID];
  if (!current || !Array.isArray(current.models) || current.models.length === 0) {
    log?.("[migrations] #49: no Codex OAuth model list to repair");
    return;
  }

  const correctIds = new Set(collectCodexModelsFromLegacyPersistence(ctx));
  const wrongIds = collectPreFixPollutedCodexEventIds(ctx);
  const wrongOnlyIds = new Set([...wrongIds].filter((id) => !correctIds.has(id)));
  if (wrongOnlyIds.size === 0) {
    log?.("[migrations] #49: no polluted Codex OAuth event-id entries found");
    return;
  }

  // Extra safety net: a shipped default model is never removed even if one
  // were to coincidentally collide with a wrongly-collected event id.
  const defaultIds = new Set(
    (providerRegistry?.getDefaultModelEntries?.(CODEX_OAUTH_PROVIDER_ID)
      || providerRegistry?.getDefaultModels?.(CODEX_OAUTH_PROVIDER_ID)
      || [])
      .map((model) => migrationModelId(model))
      .filter((id) => typeof id === "string" && id),
  );

  const removed = [];
  const nextModels = current.models.filter((model) => {
    const id = migrationModelId(model);
    if (typeof id !== "string" || !wrongOnlyIds.has(id) || defaultIds.has(id)) return true;
    removed.push(id);
    return false;
  });

  if (removed.length === 0) {
    log?.("[migrations] #49: polluted event ids found but none present in the current Codex OAuth model list");
    return;
  }

  const backupDir = writeCodexEventIdPollutionRepairBackup({ store, lucHome, removed });
  providers[CODEX_OAUTH_PROVIDER_ID] = { ...current, models: nextModels };
  store.saveProviders(providers);
  if (providerRegistry) {
    providerRegistry._addedModelsCache = null;
    providerRegistry._addedModelsMtime = 0;
    providerRegistry._entries?.clear?.();
  }
  log?.(
    `[migrations] #49: removed ${removed.length} polluted Codex OAuth event-id entries (${removed.join(", ")}, backup=${path.basename(backupDir)})`,
  );
}

/**
 * #47 — stable 钉钉应用凭据继续使用旧 token 契约
 *
 * stable 保存的配置没有 corpId，并通过 appKey/appSecret/restBaseUrl 这组旧字段
 * 或其中的 restBaseUrl 识别。只给这种明确的持久化形态写 compatibility marker；
 * 当前 canonical 配置缺 corpId 仍由运行时显式报错，不能启发式降级。
 */
function migrateStableDingTalkCredentialsToLegacyAuthMode(ctx) {
  const { agentsDir, log } = ctx;
  const safeErrorCode = (error, fallback) => {
    const code = typeof error?.code === "string" ? error.code : "";
    return /^[A-Z0-9_]+$/.test(code) ? code : fallback;
  };
  let agentEntries;
  try {
    // Deliberately use native Dirent predicates here. Link-aware traversal is
    // useful for reads elsewhere, but a migration must never rewrite a linked
    // Agent directory or config file outside the owned data tree.
    if (!fs.lstatSync(agentsDir).isDirectory()) {
      log?.("[migrations] #47: no real agent directory");
      return;
    }
    agentEntries = fs.readdirSync(agentsDir, { withFileTypes: true });
  } catch {
    log?.("[migrations] #47: no readable agent configs");
    return;
  }

  let migrated = 0;
  let invalid = 0;
  for (const entry of agentEntries) {
    if (!entry.isDirectory()) continue;
    const configPath = path.join(agentsDir, entry.name, "config.yaml");
    let stat;
    try {
      stat = fs.lstatSync(configPath);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;

    let config;
    try {
      config = YAML.load(fs.readFileSync(configPath, "utf-8"));
    } catch (error) {
      invalid += 1;
      log?.(
        `[migrations] #47 skipped invalid config for "${entry.name}" ` +
        `(stage=read_or_parse, code=${safeErrorCode(error, "INVALID_YAML")})`,
      );
      continue;
    }
    const dingtalk = config?.bridge?.dingtalk;
    if (!dingtalk || typeof dingtalk !== "object" || Array.isArray(dingtalk)) continue;
    if (Object.prototype.hasOwnProperty.call(dingtalk, "authMode")) continue;
    if (typeof dingtalk.corpId === "string" && dingtalk.corpId.trim()) continue;
    const hasLegacyPersistentKey = ["appKey", "appSecret", "restBaseUrl"]
      .some((key) => Object.prototype.hasOwnProperty.call(dingtalk, key));
    if (!hasLegacyPersistentKey) continue;

    let canonical;
    try {
      canonical = canonicalizeDingTalkBridgeConfig({
        ...dingtalk,
        authMode: DINGTALK_LEGACY_AUTH_MODE,
      });
      delete canonical.appKey;
      delete canonical.appSecret;
      delete canonical.restBaseUrl;
      config.bridge.dingtalk = canonical;
    } catch (error) {
      invalid += 1;
      log?.(
        `[migrations] #47 skipped invalid config for "${entry.name}" ` +
        `(stage=canonicalize, code=${safeErrorCode(error, "INVALID_DINGTALK_CONFIG")})`,
      );
      continue;
    }

    try {
      writeSecretFileSync(
        configPath,
        YAML.dump(config, {
          indent: 2,
          lineWidth: -1,
          sortKeys: false,
          quotingType: "\"",
        }),
      );
    } catch (error) {
      const code = safeErrorCode(error, "WRITE_FAILED");
      log?.(
        `[migrations] #47 could not persist config for "${entry.name}" ` +
        `(stage=write, code=${code})`,
      );
      throw new Error(`DingTalk config migration write failed for "${entry.name}" (code=${code})`);
    }
    migrated += 1;
    log?.(`[migrations] #47 migrated DingTalk auth contract for "${entry.name}"`);
  }

  log?.(`[migrations] #47: DingTalk stable credentials migrated (configs=${migrated}, invalid=${invalid})`);
}

/**
 * #48 — 为 stable Agent 保留项目内兼容技能发现
 *
 * stable 没有 workspace_context 策略字段，会加载 .claude/.codex/.openclaw
 * 项目技能。新 Agent 模板已显式写 false；因此只补缺失值为 true，就能区分
 * 升级用户与新建 Agent，并完整尊重用户已经保存的 true / false。
 */
function preserveStableCompatibleWorkspaceSkillDiscovery(ctx) {
  const { agentsDir, log } = ctx;
  let entries;
  try {
    if (!fs.lstatSync(agentsDir).isDirectory()) return;
    entries = fs.readdirSync(agentsDir, { withFileTypes: true });
  } catch {
    log?.("[migrations] #48: no readable agent configs");
    return;
  }

  let migrated = 0;
  let invalid = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const configPath = path.join(agentsDir, entry.name, "config.yaml");
    try {
      if (!fs.lstatSync(configPath).isFile()) continue;
    } catch {
      continue;
    }

    let config;
    try {
      config = YAML.load(fs.readFileSync(configPath, "utf-8"));
    } catch {
      invalid += 1;
      log?.(`[migrations] #48 skipped invalid config for "${entry.name}" (stage=read_or_parse)`);
      continue;
    }
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      invalid += 1;
      log?.(`[migrations] #48 skipped invalid config for "${entry.name}" (stage=shape)`);
      continue;
    }

    const workspaceContext = config.workspace_context;
    if (workspaceContext !== undefined
      && (!workspaceContext || typeof workspaceContext !== "object" || Array.isArray(workspaceContext))) {
      invalid += 1;
      log?.(`[migrations] #48 skipped invalid config for "${entry.name}" (stage=workspace_context)`);
      continue;
    }
    if (workspaceContext
      && Object.prototype.hasOwnProperty.call(workspaceContext, "discover_compatible_project_skills")) {
      continue;
    }

    config.workspace_context = {
      ...(workspaceContext || {}),
      discover_compatible_project_skills: true,
    };
    try {
      writeSecretFileSync(
        configPath,
        YAML.dump(config, {
          indent: 2,
          lineWidth: -1,
          sortKeys: false,
          quotingType: "\"",
        }),
      );
    } catch (error) {
      const code = typeof error?.code === "string" && /^[A-Z0-9_]+$/.test(error.code)
        ? error.code
        : "WRITE_FAILED";
      log?.(`[migrations] #48 could not persist config for "${entry.name}" (stage=write, code=${code})`);
      throw new Error(`workspace skill policy migration write failed for "${entry.name}" (code=${code})`);
    }
    migrated += 1;
    log?.(`[migrations] #48 preserved compatible project skill discovery for "${entry.name}"`);
  }

  log?.(`[migrations] #48: compatible project skill policy migrated (configs=${migrated}, invalid=${invalid})`);
}

function removeCodexImageSizeDefault(providerDefaults) {
  const defaults = migrationRecord(providerDefaults);
  const codexDefaults = migrationRecord(defaults?.[CODEX_IMAGE_PROVIDER_ID]);
  if (!codexDefaults || !Object.prototype.hasOwnProperty.call(codexDefaults, "size")) {
    return false;
  }
  delete codexDefaults.size;
  return true;
}

function removeCodexImageSizeDefaultFromPluginConfig(lucHome, log) {
  const configPath = path.join(lucHome, "plugin-data", "image-gen", "config.json");
  if (!fs.existsSync(configPath)) return false;

  let config;
  try {
    config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  } catch (err) {
    log?.(`[migrations] #43: image-gen plugin config unreadable, skipped (${err.message})`);
    return false;
  }

  const changed = removeCodexImageSizeDefault(config?.global?.providerDefaults);
  if (!changed) return false;

  writeSecretFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  return true;
}

const GEMINI_IMAGE_MODEL_ID_MIGRATION = Object.freeze({
  "gemini-3.1-flash-image-preview": "gemini-3.1-flash-image",
  "gemini-3-pro-image-preview": "gemini-3-pro-image",
});

function stableGeminiImageModelId(value) {
  if (typeof value !== "string") return value;
  return GEMINI_IMAGE_MODEL_ID_MIGRATION[value] || value;
}

function migrateGeminiModelKeyedDefaults(providerDefaults) {
  const defaults = migrationRecord(providerDefaults);
  const gemini = migrationRecord(defaults?.gemini);
  if (!gemini) return false;
  const before = JSON.stringify(gemini);
  const models = migrationRecord(gemini.models);
  if (models) {
    for (const [previewId, stableId] of Object.entries(GEMINI_IMAGE_MODEL_ID_MIGRATION)) {
      if (!Object.prototype.hasOwnProperty.call(models, previewId)) continue;
      const previewValue = models[previewId];
      if (!Object.prototype.hasOwnProperty.call(models, stableId)) {
        models[stableId] = previewValue;
      } else if (migrationRecord(previewValue) && migrationRecord(models[stableId])) {
        // An explicitly saved stable-ID value wins field conflicts, while
        // non-conflicting defaults from the retired key are retained.
        models[stableId] = { ...previewValue, ...models[stableId] };
      }
      delete models[previewId];
    }
  }
  for (const key of ["model", "modelId", "defaultModelId"]) {
    if (typeof gemini[key] === "string") gemini[key] = stableGeminiImageModelId(gemini[key]);
  }
  return JSON.stringify(gemini) !== before;
}

function migrateGeminiImageConfigRecord(config) {
  const record = migrationRecord(config);
  if (!record) return false;
  const before = JSON.stringify(record);
  const defaultModel = migrationRecord(record.defaultImageModel);
  if (defaultModel?.provider === "gemini" && typeof defaultModel.id === "string") {
    defaultModel.id = stableGeminiImageModelId(defaultModel.id);
  }
  migrateGeminiModelKeyedDefaults(record.providerDefaults);
  return JSON.stringify(record) !== before;
}

function migrateGeminiCatalogModelList(models) {
  if (!Array.isArray(models)) return { models, changed: false };
  const order = [];
  const byId = new Map();
  let changed = false;

  for (const rawModel of models) {
    const rawId = migrationModelId(rawModel);
    if (typeof rawId !== "string" || !rawId) {
      const invalidKey = Symbol("invalid-model");
      order.push(invalidKey);
      byId.set(invalidKey, { value: rawModel, stableSource: true });
      continue;
    }
    const stableId = stableGeminiImageModelId(rawId);
    const isStableSource = stableId === rawId;
    if (!isStableSource) changed = true;
    const incoming = migrationRecord(rawModel)
      ? { ...rawModel, id: stableId }
      : stableId;
    if (!byId.has(stableId)) {
      order.push(stableId);
      byId.set(stableId, { value: incoming, stableSource: isStableSource });
      continue;
    }

    changed = true;
    const current = byId.get(stableId);
    const currentRecord = migrationRecord(current.value);
    const incomingRecord = migrationRecord(incoming);
    if (currentRecord && incomingRecord) {
      current.value = isStableSource
        ? { ...currentRecord, ...incomingRecord, id: stableId }
        : { ...incomingRecord, ...currentRecord, id: stableId };
      current.stableSource = current.stableSource || isStableSource;
    } else if (isStableSource && !current.stableSource) {
      current.value = incoming;
      current.stableSource = true;
    }
  }

  return {
    models: order.map((id) => byId.get(id)?.value),
    changed,
  };
}

function migrateGeminiCatalogProvider(provider) {
  const record = migrationRecord(provider);
  if (!record) return false;
  const before = JSON.stringify(record);
  if (Array.isArray(record.models)) {
    record.models = migrateGeminiCatalogModelList(record.models).models;
  }
  const media = migrationRecord(record.media);
  for (const key of ["image_generation", "imageGeneration"]) {
    const capability = migrationRecord(media?.[key]);
    if (!capability) continue;
    if (typeof capability.defaultModelId === "string") {
      capability.defaultModelId = stableGeminiImageModelId(capability.defaultModelId);
    }
    if (Array.isArray(capability.models)) {
      capability.models = migrateGeminiCatalogModelList(capability.models).models;
    }
  }
  return JSON.stringify(record) !== before;
}

function migrateGeminiPersistedTasks(lucHome, log) {
  const tasksPath = path.join(lucHome, "plugin-data", "image-gen", "tasks.json");
  if (!fs.existsSync(tasksPath)) return false;
  let tasks;
  try {
    tasks = JSON.parse(fs.readFileSync(tasksPath, "utf-8"));
  } catch (err) {
    log?.(`[migrations] #45: image-gen tasks unreadable, skipped (${err.message})`);
    return false;
  }
  if (!Array.isArray(tasks)) return false;
  const before = JSON.stringify(tasks);
  for (const task of tasks) {
    if (!migrationRecord(task)) continue;
    const params = migrationRecord(task.params);
    const isGemini = task.providerId === "gemini"
      || task.adapterId === "gemini"
      || params?.providerId === "gemini";
    if (!isGemini) continue;
    if (typeof task.modelId === "string") task.modelId = stableGeminiImageModelId(task.modelId);
    if (params) {
      if (typeof params.modelId === "string") params.modelId = stableGeminiImageModelId(params.modelId);
      if (typeof params.model === "string") params.model = stableGeminiImageModelId(params.model);
    }
  }
  if (JSON.stringify(tasks) === before) return false;
  atomicWriteSync(tasksPath, JSON.stringify(tasks, null, 2) + "\n");
  return true;
}

function migrateGeminiPluginConfig(lucHome, log) {
  const configPath = path.join(lucHome, "plugin-data", "image-gen", "config.json");
  if (!fs.existsSync(configPath)) return false;
  let config;
  try {
    config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  } catch (err) {
    log?.(`[migrations] #45: image-gen plugin config unreadable, skipped (${err.message})`);
    return false;
  }
  const changed = migrateGeminiImageConfigRecord(config?.global);
  if (!changed) return false;
  writeSecretFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  return true;
}

function migrateGeminiImagePreviewIdsToStable(ctx) {
  const { lucHome, prefs, providerRegistry, log } = ctx;
  const preferences = prefs.getPreferences();
  const preferencesChanged = migrateGeminiImageConfigRecord(preferences.imageGeneration);
  if (preferencesChanged) prefs.savePreferences(preferences);

  const pluginConfigChanged = migrateGeminiPluginConfig(lucHome, log);
  const tasksChanged = migrateGeminiPersistedTasks(lucHome, log);

  const store = providerRegistry?._catalog || new ProviderCatalogStore(lucHome);
  const catalog = store.load();
  const providers = structuredClone(catalog.providers || {});
  const catalogChanged = migrateGeminiCatalogProvider(providers.gemini);
  if (catalogChanged) {
    store.saveProviders(providers, { geminiImageStableIdsMigratedAt: new Date().toISOString() });
    if (providerRegistry) {
      providerRegistry._addedModelsCache = null;
      providerRegistry._addedModelsMtime = 0;
      providerRegistry._entries?.clear?.();
    }
  }

  log?.(
    `[migrations] #45: Gemini image IDs migrated `
      + `(preferences=${preferencesChanged}, pluginConfig=${pluginConfigChanged}, `
      + `catalog=${catalogChanged}, tasks=${tasksChanged})`,
  );
}

function migrateDirectNotifyAutomationsToAgentRuns(ctx) {
  const { lucHome, agentsDir, log } = ctx;
  const paths = [];

  const studiosDir = path.join(lucHome, "studios");
  try {
    for (const entry of fs.readdirSync(studiosDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      paths.push(path.join(studiosDir, entry.name, "desk", "cron-jobs.json"));
    }
  } catch {}

  try {
    for (const entry of readDirectoryLikeDirentsSync(agentsDir)) {
      paths.push(path.join(agentsDir, entry.name, "desk", "cron-jobs.json"));
    }
  } catch {}

  let patchedFiles = 0;
  let patchedJobs = 0;
  for (const jobsPath of paths) {
    const result = patchCronJobsFileForAutomation(jobsPath, log);
    if (!result.changed) continue;
    patchedFiles++;
    patchedJobs += result.patchedJobs;
  }

  log?.(`[migrations] #38: direct notify automations rewritten as Agent runs (${patchedJobs} jobs in ${patchedFiles} files)`);
}

function repairAutomationOwnershipAfterAgentRunConsolidation(ctx) {
  const { lucHome, agentsDir, log } = ctx;
  const stores = [];

  const studiosDir = path.join(lucHome, "studios");
  try {
    for (const entry of fs.readdirSync(studiosDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      stores.push({
        jobsPath: path.join(studiosDir, entry.name, "desk", "cron-jobs.json"),
        fallbackAgentId: null,
      });
    }
  } catch {}

  try {
    for (const entry of readDirectoryLikeDirentsSync(agentsDir)) {
      stores.push({
        jobsPath: path.join(agentsDir, entry.name, "desk", "cron-jobs.json"),
        fallbackAgentId: entry.name,
      });
    }
  } catch {}

  let patchedFiles = 0;
  let patchedJobs = 0;
  for (const store of stores) {
    const result = repairAutomationOwnershipFile(store.jobsPath, store.fallbackAgentId, log);
    if (!result.changed) continue;
    patchedFiles++;
    patchedJobs += result.patchedJobs;
  }

  log?.(`[migrations] #39: automation ownership repaired (${patchedJobs} jobs in ${patchedFiles} files)`);
}

const AUTOMATION_OWNER_WARNING = {
  code: "missing_automation_owner",
  message: "需要选择执行助手后再启用",
};

const AUTOMATION_EXECUTOR_WARNING = {
  code: "unsupported_automation_executor",
  message: "需要重新保存为 Agent Run 后再启用",
};

function migrationOptionalString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function migrationClone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function migrationRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function inferAutomationOwner(job, fallbackAgentId) {
  return migrationOptionalString(job?.actorAgentId)
    || migrationOptionalString(job?.executor?.agentId)
    || migrationOptionalString(job?.legacyRef?.agentId)
    || migrationOptionalString(fallbackAgentId);
}

function migrationExecutionContext(job, actorAgentId, fallbackAgentId) {
  const executorContext = migrationRecord(job?.executor?.executionContext);
  const sourceContext = migrationRecord(job?.executionContext) || executorContext;
  const source = sourceContext ? migrationClone(sourceContext) : {};
  const legacyLike = !!migrationOptionalString(job?.legacyRef?.agentId) || !!migrationOptionalString(fallbackAgentId);
  return {
    kind: migrationOptionalString(source.kind) || (legacyLike ? "legacy_agent_home" : "migration_repaired"),
    cwd: migrationOptionalString(source.cwd),
    workspaceFolders: Array.isArray(source.workspaceFolders)
      ? source.workspaceFolders.filter((item) => typeof item === "string" && item.trim())
      : [],
    sourceSessionPath: migrationOptionalString(source.sourceSessionPath),
    createdByAgentId: migrationOptionalString(source.createdByAgentId) || actorAgentId,
  };
}

function repairAutomationJobForOwnership(job, fallbackAgentId) {
  let next = patchAutomationJobForMigration(job);
  const owner = inferAutomationOwner(next, fallbackAgentId);
  const executor = migrationRecord(next.executor);
  const unsupportedExecutor = executor?.kind && executor.kind !== "agent_session";

  if (unsupportedExecutor) {
    next = {
      ...next,
      enabled: false,
      migrationWarning: AUTOMATION_EXECUTOR_WARNING,
    };
    return next;
  }

  if (!owner) {
    const nextExecutor = executor?.kind === "agent_session"
      ? { ...executor, agentId: null }
      : executor;
    return {
      ...next,
      enabled: false,
      executor: nextExecutor,
      createdBy: migrationRecord(next.createdBy) || { kind: "unknown" },
      migrationWarning: AUTOMATION_OWNER_WARNING,
    };
  }

  const executionContext = migrationExecutionContext(next, owner, fallbackAgentId);
  const prompt = typeof next.prompt === "string"
    ? next.prompt
    : typeof executor?.prompt === "string"
      ? executor.prompt
      : "";
  return {
    ...next,
    prompt,
    actorAgentId: owner,
    executionContext,
    executor: {
      ...(executor || {}),
      kind: "agent_session",
      agentId: owner,
      prompt,
      model: Object.prototype.hasOwnProperty.call(next, "model")
        ? migrationClone(next.model ?? "")
        : migrationClone(executor?.model ?? ""),
      executionContext,
    },
    createdBy: migrationRecord(next.createdBy) && next.createdBy.kind !== "unknown"
      ? next.createdBy
      : { kind: "agent", agentId: owner },
    ...(next.migrationWarning?.code === AUTOMATION_OWNER_WARNING.code ? { migrationWarning: undefined } : {}),
  };
}

function repairAutomationOwnershipFile(jobsPath, fallbackAgentId, log) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(jobsPath, "utf-8"));
  } catch (err) {
    if (err.code !== "ENOENT") {
      log?.(`[migrations] #39 skipped invalid cron-jobs.json at ${jobsPath} (${err.message})`);
    }
    return { changed: false, patchedJobs: 0 };
  }
  if (!Array.isArray(data.jobs)) return { changed: false, patchedJobs: 0 };

  let patchedJobs = 0;
  const jobs = data.jobs.map((job) => {
    const next = repairAutomationJobForOwnership(job, fallbackAgentId);
    if (Object.prototype.hasOwnProperty.call(next, "migrationWarning") && next.migrationWarning === undefined) {
      delete next.migrationWarning;
    }
    if (JSON.stringify(next) !== JSON.stringify(job)) patchedJobs++;
    return next;
  });
  if (!patchedJobs) return { changed: false, patchedJobs: 0 };

  atomicWriteSync(jobsPath, JSON.stringify({ ...data, jobs }, null, 2) + "\n");
  return { changed: true, patchedJobs };
}

const MIGRATION_SAFE_SKILL_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

function sanitizeMigrationSkillName(raw, fallback = "skill") {
  const candidate = typeof raw === "string" ? raw.trim() : "";
  if (MIGRATION_SAFE_SKILL_NAME.test(candidate)) return candidate;
  const slug = candidate
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^[^a-zA-Z0-9]+/, "")
    .replace(/-+/g, "-")
    .slice(0, 64)
    .replace(/[-_]+$/, "");
  if (MIGRATION_SAFE_SKILL_NAME.test(slug)) return slug;
  const fallbackCandidate = typeof fallback === "string" ? fallback.trim() : "skill";
  if (MIGRATION_SAFE_SKILL_NAME.test(fallbackCandidate)) return fallbackCandidate;
  return "skill";
}

function escapeYamlScalar(value) {
  const text = String(value);
  return MIGRATION_SAFE_SKILL_NAME.test(text) ? text : JSON.stringify(text);
}

function upsertFrontmatterLine(frontmatter, key, value) {
  const line = `${key}: ${value}`;
  const re = new RegExp(`(^|\\r?\\n)${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:\\s*.*(?=\\r?\\n|$)`, "m");
  if (re.test(frontmatter)) {
    return frontmatter.replace(re, (match, prefix = "") => `${prefix}${line}`);
  }
  const trimmed = frontmatter.replace(/\s*$/, "");
  return `${trimmed}${trimmed ? "\n" : ""}${line}`;
}

function rewriteSkillContentForGlobalPool(content, skillName) {
  const body = typeof content === "string" ? content : "";
  const match = body.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(\r?\n|$)([\s\S]*)$/);
  if (!match) {
    return [
      "---",
      `name: ${escapeYamlScalar(skillName)}`,
      "default-enabled: false",
      "---",
      "",
      body,
    ].join("\n");
  }

  let frontmatter = match[1] || "";
  frontmatter = upsertFrontmatterLine(frontmatter, "name", escapeYamlScalar(skillName));
  frontmatter = upsertFrontmatterLine(frontmatter, "default-enabled", "false");
  return `---\n${frontmatter}\n---${match[2] || "\n"}${match[3] || ""}`;
}

function skillFileContent(dirPath) {
  return fs.readFileSync(path.join(dirPath, "SKILL.md"), "utf-8");
}

function skillContentsEquivalent(a, b) {
  return String(a) === String(b);
}

function uniqueMigratedSkillName(skillsDir, preferredName, sourceContent, agentId) {
  const preferredPath = path.join(skillsDir, preferredName, "SKILL.md");
  if (!fs.existsSync(preferredPath)) {
    return { name: preferredName, copy: true };
  }
  const existingContent = fs.readFileSync(preferredPath, "utf-8");
  if (skillContentsEquivalent(existingContent, sourceContent)) {
    return { name: preferredName, copy: false };
  }

  const suffixBase = sanitizeMigrationSkillName(agentId, "agent");
  let index = 0;
  while (index < 1000) {
    const suffix = index === 0 ? suffixBase : `${suffixBase}-${index + 1}`;
    const stemMax = Math.max(1, 64 - suffix.length - 1);
    const stem = preferredName.slice(0, stemMax).replace(/[-_]+$/, "") || "skill";
    const candidate = sanitizeMigrationSkillName(`${stem}-${suffix}`, `${stem}-agent`);
    const candidatePath = path.join(skillsDir, candidate, "SKILL.md");
    const rewritten = rewriteSkillContentForGlobalPool(sourceContent, candidate);
    if (!fs.existsSync(candidatePath)) {
      return { name: candidate, copy: true };
    }
    const existing = fs.readFileSync(candidatePath, "utf-8");
    if (skillContentsEquivalent(existing, rewritten)) {
      return { name: candidate, copy: false };
    }
    index += 1;
  }

  throw new Error(`unable to find a free skill name for migrated skill "${preferredName}"`);
}

function copyMigratedSkillDir(srcDir, dstDir, skillName, content) {
  fs.mkdirSync(path.dirname(dstDir), { recursive: true });
  const tmpDir = `${dstDir}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.cpSync(srcDir, tmpDir, { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "SKILL.md"),
      rewriteSkillContentForGlobalPool(content, skillName),
      "utf-8",
    );
    fs.renameSync(tmpDir, dstDir);
  } catch (err) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    throw err;
  }
}

function enableSkillForAgentConfig(configPath, skillNames) {
  if (!fs.existsSync(configPath)) return false;
  const cfg = safeReadYAMLSync(configPath, null, YAML) || {};
  const current = Array.isArray(cfg.skills?.enabled) ? cfg.skills.enabled : [];
  const next = [...current];
  let changed = false;
  for (const name of skillNames) {
    if (!next.includes(name)) {
      next.push(name);
      changed = true;
    }
  }
  if (!changed) return false;
  saveConfig(configPath, { skills: { enabled: next } });
  return true;
}

/**
 * #31 — learned-skills 收敛到全局 skill pool
 *
 * 旧结构把 Agent 自学技能放在 `agents/<id>/learned-skills/`，这会让“经验”、
 * “反省”和“技能安装”混在一起，也让列表刷新出现多条来源链。新结构只有一个
 * 全局 skill pool：迁移时复制旧技能到 `{LUC_HOME}/skills`，并只把复制后的
 * skill name 写入来源 Agent 的 enabled 列表。为避免未来新 Agent 默认打开这些
 * 个性化技能，迁移出的 SKILL.md 会显式写入 `default-enabled: false`。
 */
function migrateLearnedSkillsToGlobalSkillPool(ctx) {
  const { lucHome, agentsDir, log } = ctx;
  const skillsDir = path.join(lucHome, "skills");
  fs.mkdirSync(skillsDir, { recursive: true });

  let migrated = 0;
  let reused = 0;
  let renamed = 0;
  let agentsPatched = 0;

  let agentDirs;
  try {
    agentDirs = readDirectoryLikeDirentsSync(agentsDir);
  } catch {
    return;
  }

  for (const agentEntry of agentDirs) {
    const agentId = agentEntry.name;
    const agentDir = path.join(agentsDir, agentId);
    const learnedDir = path.join(agentDir, "learned-skills");
    if (!fs.existsSync(learnedDir)) continue;

    const enableNames = [];
    const skillEntries = fs.readdirSync(learnedDir, { withFileTypes: true }).filter(d => d.isDirectory());
    for (const skillEntry of skillEntries) {
      const srcDir = path.join(learnedDir, skillEntry.name);
      const skillFile = path.join(srcDir, "SKILL.md");
      if (!fs.existsSync(skillFile)) continue;

      const sourceContent = skillFileContent(srcDir);
      const meta = parseSkillMetadata(sourceContent, skillEntry.name);
      const baseName = sanitizeMigrationSkillName(meta.name || skillEntry.name, skillEntry.name);
      const target = uniqueMigratedSkillName(skillsDir, baseName, sourceContent, agentId);
      const dstDir = path.join(skillsDir, target.name);

      if (target.copy) {
        copyMigratedSkillDir(srcDir, dstDir, target.name, sourceContent);
        migrated += 1;
        if (target.name !== baseName) renamed += 1;
      } else {
        reused += 1;
      }
      enableNames.push(target.name);
    }

    if (enableNames.length > 0) {
      const configPath = path.join(agentDir, "config.yaml");
      if (enableSkillForAgentConfig(configPath, enableNames)) {
        agentsPatched += 1;
      }
    }

    fs.rmSync(learnedDir, { recursive: true, force: true });
  }

  log?.(`[migrations] #31: learned skills migrated to global pool (copied=${migrated}, reused=${reused}, renamed=${renamed}, agents=${agentsPatched})`);
}

const AGENT_PHONE_RUNTIME_KEYS = new Set([
  "phoneSessionFile",
  "lastPhoneSessionUsedAt",
  "phoneSessionStartedAt",
  "promptSnapshot",
]);

const AGENT_PHONE_PROJECTION_RUNTIME_KEYS = new Set([
  ...AGENT_PHONE_RUNTIME_KEYS,
  "toolNames",
  "lastRefreshedDate",
]);

/**
 * #32 — Agent Phone runtime 状态从 projection 迁入 sidecar
 *
 * projection 是每个 Agent 的手机视图记录，不应该决定下一次 session 如何恢复。
 * 老版本把 session file、prompt snapshot、toolNames 等运行时字段写进 projection，
 * 会让旧工具面和旧 prompt 反过来污染新一轮执行。迁移把可复用 session 所需字段
 * 搬到 `phone/session-runtime/*.json`，并从 projection 删除 runtime 残留。
 */
function migrateAgentPhoneRuntimeOutOfProjection(ctx) {
  const { agentsDir, log } = ctx;
  let moved = 0;
  let cleaned = 0;

  let agentEntries;
  try {
    agentEntries = readDirectoryLikeDirentsSync(agentsDir);
  } catch {
    log?.("[migrations] #32: no agents dir");
    return;
  }

  for (const agentEntry of agentEntries) {
    const agentDir = path.join(agentsDir, agentEntry.name);
    const conversationsDir = path.join(agentDir, "phone", "conversations");
    let projectionEntries;
    try {
      projectionEntries = fs.readdirSync(conversationsDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".md"));
    } catch {
      continue;
    }

    for (const projectionEntry of projectionEntries) {
      const projectionPath = path.join(conversationsDir, projectionEntry.name);
      let raw;
      try {
        raw = fs.readFileSync(projectionPath, "utf-8");
      } catch {
        continue;
      }
      const frontmatter = parseAgentPhoneProjectionFrontmatter(raw);
      if (!frontmatter) continue;

      const runtimePatch = agentPhoneRuntimePatchFromMeta(frontmatter.meta);
      const nextProjection = removeFrontmatterKeys(raw, AGENT_PHONE_PROJECTION_RUNTIME_KEYS);
      if (nextProjection !== raw) {
        atomicWriteSync(projectionPath, nextProjection);
        cleaned += 1;
      }

      if (!Object.keys(runtimePatch).length) continue;
      const conversationId = frontmatter.meta.get("conversationId");
      if (!conversationId || typeof conversationId !== "string") continue;

      const runtimeDir = path.join(agentDir, "phone", "session-runtime");
      const runtimePath = path.join(runtimeDir, `${safeConversationStem(conversationId)}.json`);
      fs.mkdirSync(runtimeDir, { recursive: true });

      let existing: any = {};
      try {
        const parsed = fs.existsSync(runtimePath)
          ? JSON.parse(fs.readFileSync(runtimePath, "utf-8"))
          : {};
        existing = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
      } catch {
        existing = {};
      }

      const nextRuntime = {
        ...existing,
        agentId: frontmatter.meta.get("agentId") || existing.agentId || agentEntry.name,
        conversationId,
        conversationType: frontmatter.meta.get("conversationType")
          || existing.conversationType
          || (conversationId.startsWith("dm:") ? "dm" : "channel"),
        ...runtimePatch,
        updatedAt: existing.updatedAt || new Date().toISOString(),
      };
      delete (nextRuntime as any).toolNames;
      atomicWriteSync(runtimePath, JSON.stringify(nextRuntime, null, 2) + "\n");
      moved += 1;
    }
  }

  log?.(`[migrations] #32: agent phone runtime moved (runtime=${moved}, projections=${cleaned})`);
}

/**
 * #10 — 清除 summarizer / compiler 残留字段
 *
 * 这两个角色在 v0.55 架构重构时被列入 schema，但业务路径从未接通过任何调用，
 * 此次连同 ROLE_TO_PREF_KEY / SHARED_MODEL_KEYS / config.example.yaml 一起清理。
 * 用户机器上可能有以下残留，全部 delete key（不是写 null）：
 *   - preferences.json 的 summarizer_model / compiler_model
 *   - 每个 agent config.yaml 的 models.summarizer / models.compiler
 *
 * 幂等：缺失字段直接跳过；不抛错，避免拦住启动。
 */
function cleanupSummarizerCompilerRemnants(ctx) {
  const { agentsDir, prefs, log } = ctx;

  // ── preferences ──
  const preferences = prefs.getPreferences();
  let prefsChanged = false;
  for (const key of ["summarizer_model", "compiler_model"]) {
    if (Object.prototype.hasOwnProperty.call(preferences, key)) {
      delete preferences[key];
      prefsChanged = true;
      log(`[migrations] #10: removed preferences.${key}`);
    }
  }
  if (prefsChanged) prefs.savePreferences(preferences);

  // ── agent config.yaml ──
  let agentDirs;
  try {
    agentDirs = readDirectoryLikeDirentsSync(agentsDir);
  } catch {
    agentDirs = [];
  }

  for (const dir of agentDirs) {
    const cfgPath = path.join(agentsDir, dir.name, "config.yaml");
    const config = safeReadYAMLSync(cfgPath, null, YAML);
    if (!config?.models || typeof config.models !== "object") continue;

    let changed = false;
    for (const role of ["summarizer", "compiler"]) {
      if (Object.prototype.hasOwnProperty.call(config.models, role)) {
        delete config.models[role];
        changed = true;
        log(`[migrations] #10 ${dir.name}: removed models.${role}`);
      }
    }

    if (changed) {
      writeSecretFileSync(
        cfgPath,
        YAML.dump(config, { indent: 2, lineWidth: -1, sortKeys: false, quotingType: "\"" }),
      );
    }
  }
}

/**
 * #12 — 老 session 文件引用补齐到 sidecar
 *
 * 这次 StageFile 收口后，历史消息恢复需要能从 sidecar 查询文件生命周期。
 * 老 JSONL 里可能只有 toolResult.details.files / artifactFile / inline screenshot，
 * 因此迁移只做两件事：
 *   1. 扫描历史消息里的本地文件路径，注册到对应 session 的 .files.json；
 *   2. 把旧 browser inline screenshot 物化成 session-files 缓存图片并注册。
 *
 * 迁移不重写 JSONL。恢复时由 sessions route 按 fileId / filePath / deterministic screenshot
 * path 回填 block 的生命周期字段。
 */
function backfillLegacySessionFiles(ctx) {
  const { lucHome, agentsDir, log } = ctx;
  if (!lucHome || !agentsDir) return;

  const registry = new SessionFileRegistry({
    managedCacheRoot: path.join(lucHome, "session-files"),
  });
  const sessionPaths = collectLegacySessionJsonlPaths(agentsDir);
  let registered = 0;
  let materialized = 0;
  let skipped = 0;

  for (const sessionPath of sessionPaths) {
    const sessionId = sessionIdFromFilename(path.basename(sessionPath));
    let lines;
    try {
      lines = fs.readFileSync(sessionPath, "utf-8").split("\n").filter(Boolean);
    } catch (err) {
      skipped++;
      log(`[migrations] #12: skipped unreadable session ${sessionPath} (${err.message})`);
      continue;
    }

    for (const line of lines) {
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        skipped++;
        continue;
      }
      const msg = entry?.message;
      if (entry?.type !== "message" || msg?.role !== "toolResult") continue;

      for (const ref of legacySessionFileRefs(msg)) {
        const ok = registerLegacySessionFile({ registry, sessionId, sessionPath, ref, lucHome, log });
        if (ok) registered++;
        else skipped++;
      }

      const screenshot = legacyBrowserScreenshot(msg);
      if (screenshot?.base64) {
        try {
          persistBrowserScreenshotFileSync({
            lucHome,
            sessionId,
            sessionPath,
            base64: screenshot.base64,
            mimeType: screenshot.mimeType || "image/png",
            registerSessionFile: (record) => registry.registerFile(record),
          });
          materialized++;
        } catch (err) {
          skipped++;
          log(`[migrations] #12: skipped browser screenshot in ${sessionPath} (${err.message})`);
        }
      }
    }
  }

  log(`[migrations] #12: session file sidecars backfilled (files=${registered}, screenshots=${materialized}, skipped=${skipped})`);
}

/**
 * #13 — 最近兼容状态显式化
 *
 * v0.142.x 连续收紧了两个运行时契约：
 *   1. 官方 DeepSeek provider 不能把 provider id "deepseek" 当作模型 id；
 *   2. v0.142.x 时新建 agent 的 memory.enabled 曾改为默认关闭。
 *
 * 老数据里这两处都可能靠“隐式旧语义”存活：DeepSeek 旧列表可能含非法 id；
 * 老 agent 缺 memory.enabled 时，旧运行时一直按开启处理。迁移只修磁盘真相源，
 * 不把兼容判断散落到同步模型、Agent 初始化或前端读配置路径里。
 * 当前版本的新写入路径重新默认开启，迁移仍不覆盖已有显式用户选择。
 */
function normalizeRecentLegacyCompatibilityState(ctx) {
  const deepseekPatched = repairLegacyDeepSeekProviderModelIds(ctx);
  const memoryPatched = normalizeLegacyMemoryMasterDefaults(ctx);
  ctx.log?.(`[migrations] #13: recent compatibility normalized (deepseek=${deepseekPatched}, memory=${memoryPatched})`);
}

const GEMINI_NATIVE_API = "google-generative-ai";
const GEMINI_OPENAI_COMPAT_API = "openai-completions";
const GEMINI_NATIVE_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

function classifyOfficialGeminiBaseUrl(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.hostname.toLowerCase() !== "generativelanguage.googleapis.com") return null;
    const pathname = url.pathname.replace(/\/+$/, "");
    if (pathname === "/v1beta/openai") return "openai";
    if (pathname === "/v1beta") return "native";
  } catch {
    return null;
  }
  return null;
}

function migrateGeminiOpenAICompatToNative(ctx) {
  const { lucHome, log } = ctx;
  const ymlPath = path.join(lucHome, "added-models.yaml");
  const raw = safeReadYAMLSync(ymlPath, null, YAML);
  if (!raw?.providers || typeof raw.providers !== "object") {
    log?.("[migrations] #14: Gemini native API migration skipped (no providers)");
    return;
  }

  let patched = 0;
  for (const [providerId, provider] of Object.entries(raw.providers) as [string, any][]) {
    if (!provider || typeof provider !== "object") continue;

    const baseKind = classifyOfficialGeminiBaseUrl(provider.base_url);
    const api = typeof provider.api === "string" ? provider.api : "";
    const apiIsOpenAIOrMissing = !api || api === GEMINI_OPENAI_COMPAT_API;
    const apiIsNative = api === GEMINI_NATIVE_API;
    const hasBaseUrl = typeof provider.base_url === "string" && provider.base_url.trim().length > 0;

    let changed = false;

    if (baseKind === "openai" && (apiIsOpenAIOrMissing || apiIsNative)) {
      if (provider.base_url !== GEMINI_NATIVE_BASE_URL) {
        provider.base_url = GEMINI_NATIVE_BASE_URL;
        changed = true;
      }
      if (provider.api !== GEMINI_NATIVE_API) {
        provider.api = GEMINI_NATIVE_API;
        changed = true;
      }
    } else if (baseKind === "native" && apiIsOpenAIOrMissing) {
      if (provider.base_url !== GEMINI_NATIVE_BASE_URL) {
        provider.base_url = GEMINI_NATIVE_BASE_URL;
        changed = true;
      }
      if (provider.api !== GEMINI_NATIVE_API) {
        provider.api = GEMINI_NATIVE_API;
        changed = true;
      }
    } else if (providerId === "gemini" && !hasBaseUrl && apiIsOpenAIOrMissing) {
      provider.base_url = GEMINI_NATIVE_BASE_URL;
      provider.api = GEMINI_NATIVE_API;
      changed = true;
    }

    if (changed) patched++;
  }

  if (patched > 0) {
    const header =
      "# LucCode 供应商配置（全局，跨 agent 共享）\n" +
      "# 由设置页面管理\n\n";
    const yamlStr = header + YAML.dump(raw, {
      indent: 2,
      lineWidth: -1,
      sortKeys: false,
      quotingType: "\"",
      forceQuotes: false,
    });
    writeSecretFileSync(ymlPath, yamlStr);
    if (ctx.providerRegistry) {
      ctx.providerRegistry._addedModelsCache = null;
      ctx.providerRegistry._addedModelsMtime = 0;
    }
  }

  log?.(`[migrations] #14: Gemini OpenAI compatibility configs migrated to native API (${patched})`);
}

function repairLegacySessionSidecarThinkingLevels(ctx) {
  const metaPaths = collectAgentSessionMetaPaths(ctx.agentsDir);
  let filesPatched = 0;
  let entriesPatched = 0;

  for (const metaPath of metaPaths) {
    const patched = repairSessionMetaThinkingLevels(metaPath, ctx.log);
    if (patched > 0) {
      filesPatched++;
      entriesPatched += patched;
    }
  }

  ctx.log?.(`[migrations] #15: legacy session sidecars repaired (files=${filesPatched}, entries=${entriesPatched})`);
}

/**
 * #16 — 视频输入能力投影的老数据修补
 *
 * 覆盖两类旧状态：
 *   1. models.json 是投影文件，老版本里已存在的已知视频模型可能只有 ["text","image"]；
 *   2. 少量手写 agent config.models.overrides 可能已经带 video，需要提升到 added-models.yaml。
 *
 * 幂等：视频能力写入 Luc compat，Pi-facing input 只保留 text/image；运行期模型对象不保留 video 字段。
 */
function migrateVideoCapabilityProjection(ctx) {
  const modelsPatched = repairModelsJsonPiInputSchema(ctx);
  const overridesPatched = promoteAgentVideoOverrides(ctx);
  ctx.log?.(`[migrations] #16: video capability projected (models=${modelsPatched}, overrides=${overridesPatched})`);
}

/**
 * #20 — 修复已运行过 #16 或新版本投影留下的非法 Pi input 模态
 *
 * Pi SDK models.json 的 input 是外部契约，只允许 text/image。Luc 自己的
 * video 能力必须放在 compat.lucVideoInput，避免 ModelRegistry 因单个非法
 * 模型把整张模型表判空。
 */
function migratePiInputSchemaVideoCompat(ctx) {
  const patched = repairModelsJsonPiInputSchema(ctx);
  ctx.log?.(`[migrations] #20: Pi input schema sanitized (patched=${patched})`);
}

/**
 * #21 — 视频传输能力抽象落地后的投影刷新
 *
 * 这次变更把"模型会看视频"与"provider 协议能直传视频"拆开。新增的已知
 * 视频模型仍复用 compat.lucVideoInput 表示语义能力，传输能力由运行时根据
 * provider/api/baseUrl 推导。老用户已存在的 models.json 需要重跑一次投影修补，
 * 否则新增的 Kimi 等模型不会拿到 Luc 视频能力字段。
 */
function refreshVideoCapabilityProjection(ctx) {
  const patched = repairModelsJsonPiInputSchema(ctx);
  ctx.log?.(`[migrations] #21: video capability projection refreshed (patched=${patched})`);
}

/**
 * #17 — bridge sessionKey 补齐 agent 维度
 *
 * 旧格式：wx_dm_user / tg_dm_user
 * 新格式：wx_dm_user@luc / tg_dm_user@luc
 *
 * index 文件本身已经位于 per-agent 目录下，因此 agentId 的权威来源是目录名。
 * 微信 userId 可能自带 @（例如 openim），不能用 "包含 @" 判断是否已迁移，
 * 只能判断 key 是否以当前 owner agent 的 @agentId 结尾。
 */
function migrateBridgeSessionKeysToAgentScoped(ctx) {
  const { agentsDir, log } = ctx;
  let agentDirs;
  try {
    agentDirs = readDirectoryLikeDirentsSync(agentsDir);
  } catch {
    return;
  }

  let migrated = 0;
  let merged = 0;
  let collisions = 0;

  for (const dir of agentDirs) {
    const agentId = dir.name;
    const cfgPath = path.join(agentsDir, agentId, "config.yaml");
    if (!fs.existsSync(cfgPath)) continue;

    const indexPath = path.join(agentsDir, agentId, "sessions", "bridge", "bridge-sessions.json");
    const result = migrateOneBridgeSessionIndex(indexPath, agentId, log);
    migrated += result.migrated;
    merged += result.merged;
    collisions += result.collisions;
  }

  log?.(`[migrations] #17: bridge session keys scoped (migrated=${migrated}, merged=${merged}, collisions=${collisions})`);
}

function migrateOneBridgeSessionIndex(indexPath, agentId, log) {
  let raw;
  try {
    raw = fs.readFileSync(indexPath, "utf-8");
  } catch {
    return { migrated: 0, merged: 0, collisions: 0 };
  }

  let index;
  try {
    index = JSON.parse(raw);
  } catch (err) {
    log?.(`[migrations] #17: skipped unreadable bridge index ${indexPath}: ${err.message}`);
    return { migrated: 0, merged: 0, collisions: 0 };
  }
  if (!index || typeof index !== "object" || Array.isArray(index)) {
    return { migrated: 0, merged: 0, collisions: 0 };
  }

  let changed = false;
  let migrated = 0;
  let merged = 0;
  let collisions = 0;

  for (const oldKey of Object.keys(index)) {
    const newKey = scopedBridgeSessionKey(oldKey, agentId);
    if (!newKey || newKey === oldKey) continue;

    const oldRaw = index[oldKey];
    const targetRaw = index[newKey];
    if (targetRaw === undefined) {
      index[newKey] = oldRaw;
      delete index[oldKey];
      migrated++;
      changed = true;
      continue;
    }

    const oldEntry = normalizeBridgeIndexEntryForMigration(oldRaw);
    const targetEntry = normalizeBridgeIndexEntryForMigration(targetRaw);
    if (oldEntry.file && targetEntry.file) {
      collisions++;
      continue;
    }

    index[newKey] = serializeBridgeIndexEntryForMigration(targetRaw, {
      ...oldEntry,
      ...targetEntry,
      file: targetEntry.file || oldEntry.file,
    });
    delete index[oldKey];
    merged++;
    changed = true;
  }

  if (changed) {
    const tmp = indexPath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(index, null, 2) + "\n", "utf-8");
    fs.renameSync(tmp, indexPath);
  }

  return { migrated, merged, collisions };
}

function scopedBridgeSessionKey(key, agentId) {
  if (!key || !agentId || String(key).endsWith(`@${agentId}`)) return null;
  if (!SESSION_PREFIX_MAP.some(([prefix]) => String(key).startsWith(prefix))) return null;
  return `${key}@${agentId}`;
}

function normalizeBridgeIndexEntryForMigration(raw) {
  if (!raw) return {};
  return typeof raw === "string" ? { file: raw } : { ...raw };
}

function serializeBridgeIndexEntryForMigration(previousRaw, entry) {
  if (typeof previousRaw === "string" && Object.keys(entry).length === 1 && typeof entry.file === "string") {
    return entry.file;
  }
  return entry;
}

function repairModelsJsonPiInputSchema(ctx) {
  const modelsJsonPath = path.join(ctx.luccodeHome, "models.json");
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
  } catch {
    return 0;
  }
  if (!raw?.providers || typeof raw.providers !== "object") return 0;

  let patched = 0;
  for (const [providerId, provider] of Object.entries(raw.providers) as [string, any][]) {
    if (!provider || typeof provider !== "object") continue;
    if (Array.isArray(provider.models)) {
      for (const model of provider.models) {
        patched += repairPiModelInputRecord(providerId, model, model?.id);
      }
    }
    if (provider.modelOverrides && typeof provider.modelOverrides === "object" && !Array.isArray(provider.modelOverrides)) {
      for (const [modelId, override] of Object.entries(provider.modelOverrides)) {
        patched += repairPiModelInputRecord(providerId, override, modelId);
      }
    }
  }

  if (patched > 0) {
    writeSecretFileSync(modelsJsonPath, JSON.stringify(raw, null, 4) + "\n");
  }
  return patched;
}

function repairPiModelInputRecord(providerId, record, fallbackModelId) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return 0;

  let patched = 0;
  const hadRuntimeVideoField = Object.prototype.hasOwnProperty.call(record, "video");
  const hadInputVideo = migrationInputIncludes(record.input, "video");
  const shouldEnableVideo = migrationModelHasVideoCapability(providerId, record, fallbackModelId, hadInputVideo);
  const sanitizedInput = sanitizePiInputModalities(record.input);
  if (sanitizedInput.changed) {
    record.input = sanitizedInput.input;
    patched++;
  }
  if (shouldEnableVideo && ensureLucVideoInputCompat(record)) patched++;
  if (hadRuntimeVideoField) {
    delete record.video;
    patched++;
  }
  return patched;
}

function migrationModelHasVideoCapability(providerId, model, fallbackModelId, hadInputVideo = false) {
  if (model?.video === true) return true;
  if (model?.video === false) return false;
  if (hadInputVideo) return true;
  const known = lookupKnown(providerId, model?.id || fallbackModelId);
  return known?.video === true;
}

function migrationInputIncludes(input, modality) {
  return Array.isArray(input) && input.includes(modality);
}

function sanitizePiInputModalities(input) {
  if (input === undefined) return { input, changed: false };

  const source = Array.isArray(input) ? input : [];
  const next = ["text"];
  if (source.includes("image")) next.push("image");

  return {
    input: next,
    changed: !Array.isArray(input)
      || input.length !== next.length
      || input.some((item, index) => item !== next[index]),
  };
}

function ensureLucVideoInputCompat(record) {
  const compat = record.compat && typeof record.compat === "object" && !Array.isArray(record.compat)
    ? record.compat
    : {};
  if (compat.lucVideoInput === true && record.compat === compat) return false;
  record.compat = {
    ...compat,
    lucVideoInput: true,
  };
  return true;
}

function promoteAgentVideoOverrides(ctx) {
  const { lucHome, agentsDir } = ctx;
  const ymlPath = path.join(lucHome, "added-models.yaml");
  const raw = safeReadYAMLSync(ymlPath, null, YAML);
  if (!raw?.providers || typeof raw.providers !== "object") return 0;

  let agentDirs;
  try {
    agentDirs = readDirectoryLikeDirentsSync(agentsDir);
  } catch {
    return 0;
  }

  let patched = 0;
  let addedModelsChanged = false;
  for (const dir of agentDirs) {
    const cfgPath = path.join(agentsDir, dir.name, "config.yaml");
    const cfg = safeReadYAMLSync(cfgPath, null, YAML);
    if (!cfg?.models?.overrides || typeof cfg.models.overrides !== "object") continue;

    let cfgChanged = false;
    for (const [modelId, override] of Object.entries(cfg.models.overrides) as [string, any][]) {
      if (!override || typeof override !== "object") continue;
      if (!Object.prototype.hasOwnProperty.call(override, "video")) continue;

      const promoted = promoteVideoOverrideIntoAddedModels(raw.providers, modelId, override.video);
      if (promoted) {
        delete override.video;
        patched++;
        cfgChanged = true;
        addedModelsChanged = true;
      }
    }

    if (cfgChanged) {
      for (const [modelId, override] of Object.entries(cfg.models.overrides)) {
        if (override && typeof override === "object" && Object.keys(override).length === 0) {
          delete cfg.models.overrides[modelId];
        }
      }
      if (Object.keys(cfg.models.overrides).length === 0) {
        delete cfg.models.overrides;
      }
      writeSecretFileSync(
        cfgPath,
        YAML.dump(cfg, { indent: 2, lineWidth: -1, sortKeys: false, quotingType: "\"" }),
      );
    }
  }

  if (addedModelsChanged) {
    const header =
      "# LucCode 供应商配置（全局，跨 agent 共享）\n" +
      "# 由设置页面管理\n\n";
    writeSecretFileSync(
      ymlPath,
      header + YAML.dump(raw, {
        indent: 2,
        lineWidth: -1,
        sortKeys: false,
        quotingType: "\"",
        forceQuotes: false,
      }),
    );
  }

  return patched;
}

function promoteVideoOverrideIntoAddedModels(providers, modelId, video) {
  for (const provider of Object.values(providers) as any[]) {
    if (!provider || !Array.isArray(provider.models)) continue;
    const idx = provider.models.findIndex((entry) => {
      if (typeof entry === "string") return entry === modelId;
      return entry && typeof entry === "object" && entry.id === modelId;
    });
    if (idx < 0) continue;

    const existing = typeof provider.models[idx] === "object"
      ? provider.models[idx]
      : { id: modelId };
    provider.models[idx] = { ...existing, video };
    return true;
  }
  return false;
}

function collectAgentSessionMetaPaths(agentsDir) {
  let agentDirs;
  try {
    agentDirs = readDirectoryLikeDirentsSync(agentsDir);
  } catch {
    return [];
  }

  const out = [];
  for (const dir of agentDirs) {
    const metaPath = path.join(agentsDir, dir.name, "sessions", "session-meta.json");
    try {
      if (fs.statSync(metaPath).isFile()) out.push(metaPath);
    } catch {
      // Most agents will not have a sidecar before their first persisted session.
    }
  }
  return out;
}

function migrateSessionPermissionModeSidecars(ctx) {
  const { agentsDir, log } = ctx;
  const metaPaths = collectAgentSessionMetaPaths(agentsDir);
  let patched = 0;
  for (const metaPath of metaPaths) {
    patched += repairSessionMetaPermissionModes(metaPath, log);
  }
  log?.(`[migrations] #40: session permission sidecars canonicalized (${patched})`);
}

function repairSessionMetaPermissionModes(metaPath, log) {
  let raw;
  try {
    raw = fs.readFileSync(metaPath, "utf-8");
  } catch {
    return 0;
  }

  let meta;
  try {
    meta = JSON.parse(raw);
  } catch (err) {
    log?.(`[migrations] #40: skipped unreadable session-meta ${metaPath}: ${err.message}`);
    return 0;
  }
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return 0;

  let patched = 0;
  for (const [sessionFile, entry] of Object.entries(meta) as [string, any][]) {
    if (!shouldCanonicalizeSessionPermissionMode(entry)) continue;
    const permissionMode = normalizeSessionPermissionMode(entry);
    const accessMode = legacyAccessModeFromPermissionMode(permissionMode);
    const planMode = permissionMode === SESSION_PERMISSION_MODES.READ_ONLY;
    if (
      entry.permissionMode === permissionMode
      && entry.accessMode === accessMode
      && entry.planMode === planMode
    ) {
      continue;
    }
    meta[sessionFile] = {
      ...entry,
      permissionMode,
      accessMode,
      planMode,
    };
    patched++;
  }

  if (patched === 0) return 0;
  backupSessionMetaBeforeV40(metaPath, raw, log);
  const tmp = metaPath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(meta, null, 2) + "\n", "utf-8");
  fs.renameSync(tmp, metaPath);
  return patched;
}

function shouldCanonicalizeSessionPermissionMode(entry) {
  return entry
    && typeof entry === "object"
    && !Array.isArray(entry)
    && (
      typeof entry.permissionMode === "string"
      || typeof entry.accessMode === "string"
      || typeof entry.planMode === "boolean"
    );
}

function backupSessionMetaBeforeV40(metaPath, raw, log) {
  const backupPath = `${metaPath}.pre-v40.bak`;
  try {
    fs.writeFileSync(backupPath, raw, { encoding: "utf-8", flag: "wx" });
  } catch (err) {
    if (err.code === "EEXIST") return;
    log?.(`[migrations] #40: failed to write session-meta backup ${backupPath}: ${err.message}`);
    throw err;
  }
}

function migrateIdentityUserNamePlaceholders(ctx) {
  const { agentsDir, log } = ctx;
  const identityPaths = collectAgentIdentityPaths(agentsDir);
  let patched = 0;
  for (const identityPath of identityPaths) {
    patched += repairIdentityUserNamePlaceholder(identityPath, log);
  }
  log?.(`[migrations] #41: identity userName placeholders repaired (${patched})`);
}

function collectAgentIdentityPaths(agentsDir) {
  let agentDirs;
  try {
    agentDirs = readDirectoryLikeDirentsSync(agentsDir);
  } catch {
    return [];
  }

  const out = [];
  for (const dir of agentDirs) {
    const identityPath = path.join(agentsDir, dir.name, "identity.md");
    try {
      if (fs.statSync(identityPath).isFile()) out.push(identityPath);
    } catch {
      // Imported or partially-created agents may not have identity.md yet.
    }
  }
  return out;
}

function repairIdentityUserNamePlaceholder(identityPath, log) {
  let raw;
  try {
    raw = fs.readFileSync(identityPath, "utf-8");
  } catch {
    return 0;
  }

  const repaired = restoreBlankUserNameIdentityTemplate(raw);
  if (repaired === raw) return 0;

  backupIdentityBeforeV41(identityPath, raw, log);
  atomicWriteSync(identityPath, repaired);
  return 1;
}

function restoreBlankUserNameIdentityTemplate(raw) {
  if (typeof raw !== "string" || raw.includes("{{userName}}")) return raw;
  return raw
    .replace(/(^|\r?\n)([ \t]*)的个人助手/g, "$1$2{{userName}}的个人助手")
    .replace(/(^|\r?\n)([ \t]*)'s personal assistant/g, "$1$2{{userName}}'s personal assistant");
}

function backupIdentityBeforeV41(identityPath, raw, log) {
  const backupPath = `${identityPath}.pre-v41.bak`;
  try {
    fs.writeFileSync(backupPath, raw, { encoding: "utf-8", flag: "wx" });
  } catch (err) {
    if (err.code === "EEXIST") return;
    log?.(`[migrations] #41: failed to write identity backup ${backupPath}: ${err.message}`);
    throw err;
  }
}

function repairSessionMetaThinkingLevels(metaPath, log) {
  let raw;
  try {
    raw = fs.readFileSync(metaPath, "utf-8");
  } catch {
    return 0;
  }

  let meta;
  try {
    meta = JSON.parse(raw);
  } catch (err) {
    log?.(`[migrations] #15: skipped unreadable session-meta ${metaPath}: ${err.message}`);
    return 0;
  }
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return 0;

  let patched = 0;
  for (const [sessionFile, entry] of Object.entries(meta) as [string, any][]) {
    if (!shouldRepairLegacyPromptSnapshotThinkingLevel(entry)) continue;
    const nextThinkingLevel = normalizeThinkingLevelForModel(entry.thinkingLevel, legacySessionMetaModelRef(entry));
    if (nextThinkingLevel === entry.thinkingLevel) continue;
    meta[sessionFile] = {
      ...entry,
      thinkingLevel: nextThinkingLevel,
    };
    patched++;
  }

  if (patched === 0) return 0;

  backupSessionMetaBeforeV15(metaPath, raw, log);
  const tmp = metaPath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(meta, null, 2) + "\n", "utf-8");
  fs.renameSync(tmp, metaPath);
  return patched;
}

function shouldRepairLegacyPromptSnapshotThinkingLevel(entry) {
  return entry
    && typeof entry === "object"
    && !Array.isArray(entry)
    && entry.thinkingLevel === "xhigh"
    && entry.promptSnapshot
    && typeof entry.promptSnapshot === "object"
    && !Array.isArray(entry.promptSnapshot);
}

function legacySessionMetaModelRef(entry) {
  const legacyModel = entry?.model;
  if (legacyModel && typeof legacyModel === "object" && !Array.isArray(legacyModel)) {
    const id = typeof legacyModel.id === "string" ? legacyModel.id : "";
    if (id) {
      return {
        id,
        provider: typeof legacyModel.provider === "string" ? legacyModel.provider : undefined,
        xhigh: legacyModel.xhigh === true,
      };
    }
  }
  if (typeof legacyModel === "string" && legacyModel.trim()) {
    const raw = legacyModel.trim();
    const slash = raw.indexOf("/");
    if (slash > 0 && slash < raw.length - 1) {
      return { provider: raw.slice(0, slash), id: raw.slice(slash + 1) };
    }
    return { id: raw };
  }

  const id = typeof entry?.modelId === "string" ? entry.modelId : "";
  if (!id) return null;
  return {
    id,
    provider: typeof entry.modelProvider === "string" ? entry.modelProvider : undefined,
  };
}

function backupSessionMetaBeforeV15(metaPath, raw, log) {
  const backupPath = `${metaPath}.pre-v15.bak`;
  try {
    fs.writeFileSync(backupPath, raw, { encoding: "utf-8", flag: "wx" });
  } catch (err) {
    if (err.code === "EEXIST") return;
    log?.(`[migrations] #15: failed to write session-meta backup ${backupPath}: ${err.message}`);
    throw err;
  }
}

function modelIdOfMigrationEntry(entry) {
  if (typeof entry === "object" && entry !== null) return typeof entry.id === "string" ? entry.id : "";
  return typeof entry === "string" ? entry : "";
}

function defaultDeepSeekModelsForMigration(ctx, providerId) {
  const direct = ctx.providerRegistry?.getDefaultModels?.(providerId);
  if (Array.isArray(direct) && direct.length > 0) return [...direct];
  const official = ctx.providerRegistry?.getDefaultModels?.("deepseek");
  if (Array.isArray(official) && official.length > 0) return [...official];
  return ["deepseek-v4-pro", "deepseek-v4-flash"];
}

function repairLegacyDeepSeekProviderModelIds(ctx) {
  const { lucHome, log } = ctx;
  const ymlPath = path.join(lucHome, "added-models.yaml");
  const raw = safeReadYAMLSync(ymlPath, null, YAML);
  if (!raw?.providers || typeof raw.providers !== "object") return 0;

  let patched = 0;
  for (const [providerId, provider] of Object.entries(raw.providers) as [string, any][]) {
    if (!provider || !Array.isArray(provider.models)) continue;

    const invalid = new Set(
      getInvalidProviderModelIds(providerId, provider.models, { baseUrl: provider.base_url })
        .map((id) => String(id).trim().toLowerCase()),
    );
    if (invalid.size === 0) continue;

    const nextModels = provider.models.filter((entry) => {
      const id = modelIdOfMigrationEntry(entry).trim().toLowerCase();
      return id && !invalid.has(id);
    });

    // TODO(remove after 1.0): 兼容早期版本可能把
    // DeepSeek provider id "deepseek" 误写进 models[] 的旧数据。
    provider.models = nextModels.length > 0
      ? nextModels
      : defaultDeepSeekModelsForMigration(ctx, providerId);
    patched++;
    log?.(`[migrations] #13 ${providerId}: removed reserved DeepSeek model id(s) ${[...invalid].join(", ")}`);
  }

  if (patched > 0) {
    const header =
      "# LucCode 供应商配置（全局，跨 agent 共享）\n" +
      "# 由设置页面管理\n\n";
    writeSecretFileSync(
      ymlPath,
      header + YAML.dump(raw, {
        indent: 2,
        lineWidth: -1,
        sortKeys: false,
        quotingType: "\"",
        forceQuotes: false,
      }),
    );
  }

  return patched;
}

function normalizeLegacyMemoryMasterDefaults(ctx) {
  const { agentsDir, log } = ctx;
  let agentDirs;
  try {
    agentDirs = readDirectoryLikeDirentsSync(agentsDir);
  } catch {
    return 0;
  }

  let patched = 0;
  for (const dir of agentDirs) {
    const cfgPath = path.join(agentsDir, dir.name, "config.yaml");
    const cfg = safeReadYAMLSync(cfgPath, null, YAML);
    if (!cfg || typeof cfg !== "object") continue;

    const memoryIsObject = cfg.memory && typeof cfg.memory === "object" && !Array.isArray(cfg.memory);
    if (memoryIsObject && Object.prototype.hasOwnProperty.call(cfg.memory, "enabled")) continue;

    // TODO(remove after 1.0): 兼容早期版本的老 agent。
    // 当时缺 memory.enabled 的运行时语义是开启，这里把隐式旧语义写成显式值。
    cfg.memory = memoryIsObject
      ? { ...cfg.memory, enabled: true }
      : { enabled: true };

    writeSecretFileSync(
      cfgPath,
      YAML.dump(cfg, { indent: 2, lineWidth: -1, sortKeys: false, quotingType: "\"" }),
    );
    patched++;
    log?.(`[migrations] #13 ${dir.name}: memory.enabled set to true for legacy implicit default`);
  }

  return patched;
}

function collectLegacySessionJsonlPaths(agentsDir) {
  let agents = [];
  try {
    agents = readDirectoryLikeDirentsSync(agentsDir);
  } catch {
    return [];
  }

  const out = [];
  for (const agent of agents) {
    const agentDir = path.join(agentsDir, agent.name);
    collectJsonlRecursive(path.join(agentDir, "sessions"), out);
    collectJsonlRecursive(path.join(agentDir, "subagent-sessions"), out);
  }
  return out;
}

function collectAgentParentSessionJsonlPaths(agentsDir) {
  let agents = [];
  try {
    agents = readDirectoryLikeDirentsSync(agentsDir);
  } catch {
    return [];
  }

  const out = [];
  for (const agent of agents) {
    collectJsonlRecursive(path.join(agentsDir, agent.name, "sessions"), out);
  }
  return out;
}

function mapSubagentRunStatus(streamStatus) {
  if (streamStatus === "done") return "resolved";
  if (streamStatus === "failed") return "failed";
  if (streamStatus === "aborted") return "aborted";
  return "pending";
}

function mapDeferredSubagentRunStatus(status) {
  if (status === "resolved") return "resolved";
  if (status === "failed") return "failed";
  if (status === "aborted") return "aborted";
  return "pending";
}

function summarizeDeferredSubagentTask(task) {
  if (typeof task?.result === "string" && task.result) return task.result;
  if (typeof task?.reason === "string" && task.reason) return task.reason;
  if (typeof task?.meta?.summary === "string" && task.meta.summary) return task.meta.summary;
  return null;
}

function collectJsonlRecursive(dir, out, seen = new Set()) {
  const dirKey = filesystemIdentityKeySync(dir);
  if (seen.has(dirKey)) return;
  seen.add(dirKey);

  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (isDirectoryLikeDirentSync(dir, entry)) {
      collectJsonlRecursive(fullPath, out, seen);
    } else if (isSessionJsonlFilename(entry.name) && isFileLikeDirentSync(dir, entry)) {
      out.push(fullPath);
    }
  }
}

function legacySessionFileRefs(msg) {
  const details = msg?.details;
  if (!details || typeof details !== "object") return [];

  const refs = [];
  const toolName = msg.toolName;

  if (toolName === "stage_files" || toolName === "present_files") {
    if (Array.isArray(details.files)) {
      for (const file of details.files) {
        pushLegacyFileRef(refs, file, {
          origin: file?.origin || "stage_files",
          storageKind: file?.storageKind || "external",
        });
      }
    }
    pushLegacyFileRef(refs, details, {
      origin: details.origin || "stage_files",
      storageKind: details.storageKind || "external",
    });
  }

  if (toolName === "create_artifact") {
    const artifactFile = details.artifactFile || details.sessionFile || details.file;
    pushLegacyFileRef(refs, artifactFile, {
      origin: artifactFile?.origin || "agent_artifact",
      storageKind: artifactFile?.storageKind || "external",
      label: details.title,
    });
  }

  if (toolName === "install_skill") {
    pushLegacyFileRef(refs, details.installedFile || details.sourceFile || details, {
      origin: "skill_install_source",
      storageKind: "install_source",
      label: details.skillName,
    });
  }

  if (toolName === "install_plugin" || toolName === "plugin_install") {
    pushLegacyFileRef(refs, details.installedFile || details.sourceFile || details, {
      origin: "plugin_install_source",
      storageKind: "install_source",
      label: details.pluginName || details.name,
    });
  }

  if (details.card?.file || details.card?.sessionFile || details.card?.sourceFile) {
    pushLegacyFileRef(refs, details.card.file || details.card.sessionFile || details.card.sourceFile, {
      origin: "plugin_output",
      storageKind: "plugin_data",
      label: details.card.title,
    });
  }

  if (Array.isArray(details.media?.items)) {
    for (const item of details.media.items) {
      pushLegacyFileRef(refs, item, {
        origin: item.origin || "agent_output",
        storageKind: item.storageKind || "external",
      });
    }
  }

  return refs;
}

function pushLegacyFileRef(refs, candidate, defaults: any = {}) {
  if (!candidate || typeof candidate !== "object") return;
  const filePath = candidate.filePath || candidate.path || candidate.realPath || candidate.localPath;
  if (!filePath) return;
  refs.push({
    filePath,
    label: candidate.label || candidate.displayName || candidate.filename || candidate.name || defaults.label,
    origin: candidate.origin || defaults.origin || "unknown",
    storageKind: candidate.storageKind || defaults.storageKind || "external",
  });
}

function registerLegacySessionFile({ registry, sessionId = null, sessionPath, ref, lucHome, log }) {
  if (!ref?.filePath || !path.isAbsolute(ref.filePath)) return false;
  if (!fs.existsSync(ref.filePath)) return false;

  try {
    registry.registerFile({
      ...(sessionId ? { sessionId } : {}),
      sessionPath,
      filePath: ref.filePath,
      label: ref.label || path.basename(ref.filePath),
      origin: ref.origin || "unknown",
      storageKind: normalizeLegacyStorageKind(ref, lucHome),
    });
    return true;
  } catch (err) {
    log(`[migrations] #12: skipped file ${ref.filePath} in ${sessionPath} (${err.message})`);
    return false;
  }
}

function normalizeLegacyStorageKind(ref, lucHome) {
  const storageKind = ref.storageKind || "external";
  if (storageKind !== "managed_cache") return storageKind;

  const managedRoot = path.join(lucHome, "session-files");
  // 纯比较，两侧都走共享身份键。
  const resolved = filesystemIdentityKeySync(ref.filePath);
  const root = filesystemIdentityKeySync(managedRoot);
  const rel = path.relative(root, resolved);
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel))
    ? "managed_cache"
    : "external";
}

function legacyBrowserScreenshot(msg) {
  if (msg?.toolName !== "browser" || msg?.details?.action !== "screenshot") return null;
  if (msg.details?.screenshotFile || msg.details?.fileId || msg.details?.id) return null;

  const image = Array.isArray(msg.content)
    ? msg.content.find((block) => block?.type === "image" && block?.data)
    : null;
  const base64 = image?.data || msg.details?.thumbnail || msg.details?.base64;
  if (!base64) return null;
  return {
    base64,
    mimeType: image?.mimeType || msg.details?.mimeType || "image/png",
  };
}

function migrateLocalIdentityRegistries(ctx) {
  const { lucHome, log } = ctx;
  const { created, migratedFromLegacySpaces } = ensureLocalIdentityRegistries(lucHome);
  log?.(`[migrations] #18: local identity registries ready${created.length ? ` (created=${created.join(",")})` : ""}`);
  if (migratedFromLegacySpaces) log?.("[migrations] #18: legacy spaces.json mapped to studios.json");
}

function migrateStudioIdentityRegistries(ctx) {
  const { lucHome, log } = ctx;
  const { created, migratedFromLegacySpaces } = ensureLocalIdentityRegistries(lucHome);
  log?.(`[migrations] #26: studio identity registries ready${created.length ? ` (created=${created.join(",")})` : ""}`);
  if (migratedFromLegacySpaces) log?.("[migrations] #26: legacy spaces.json mapped to studios.json");
}

function migrateRemoteAccessFoundationRegistries(ctx) {
  const { lucHome, log } = ctx;
  const { created } = ensureRemoteAccessFoundationRegistries(lucHome);
  log?.(`[migrations] #27: remote access foundation registries ready${created.length ? ` (created=${created.join(",")})` : ""}`);
}

function migrateDurableSubagentRunRegistry(ctx) {
  const { lucHome, agentsDir, log } = ctx;
  const store = new SubagentRunStore(path.join(lucHome, "subagent-runs.json"));
  let imported = 0;

  for (const sessionPath of collectAgentParentSessionJsonlPaths(agentsDir)) {
    let raw = "";
    try {
      raw = fs.readFileSync(sessionPath, "utf-8");
    } catch {
      continue;
    }

    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const msg = entry?.message;
      if (entry?.type !== "message" || msg?.role !== "toolResult" || msg?.toolName !== "subagent") continue;
      const details = msg.details || {};
      const taskId = typeof details.taskId === "string" ? details.taskId : null;
      const childSessionPath = typeof details.sessionPath === "string" && details.sessionPath ? details.sessionPath : null;
      if (!taskId || !childSessionPath) continue;

      store.upsert(taskId, {
        parentSessionPath: sessionPath,
        childSessionPath,
        status: mapSubagentRunStatus(details.streamStatus),
        summary: typeof details.summary === "string" && details.summary
          ? details.summary
          : (typeof details.taskTitle === "string" && details.taskTitle ? details.taskTitle : null),
        requestedAgentId: details.requestedAgentId || null,
        requestedAgentNameSnapshot: details.requestedAgentNameSnapshot || details.requestedAgentName || null,
        executorAgentId: details.executorAgentId || details.agentId || null,
        executorAgentNameSnapshot: details.executorAgentNameSnapshot || details.agentName || null,
        executorMetaVersion: details.executorMetaVersion || null,
      });
      imported++;
    }
  }

  const deferredTasksPath = path.join(lucHome, ".ephemeral", "deferred-tasks.json");
  try {
    if (fs.existsSync(deferredTasksPath)) {
      const deferredTasks = JSON.parse(fs.readFileSync(deferredTasksPath, "utf-8"));
      for (const [taskId, task] of Object.entries(deferredTasks || {}) as [string, any][]) {
        if (task?.meta?.type !== "subagent") continue;
        const childSessionPath = typeof task.meta.sessionPath === "string" && task.meta.sessionPath
          ? task.meta.sessionPath
          : null;
        if (!childSessionPath) continue;

        store.upsert(taskId, {
          parentSessionPath: typeof task.sessionPath === "string" ? task.sessionPath : null,
          childSessionPath,
          status: mapDeferredSubagentRunStatus(task.status),
          summary: summarizeDeferredSubagentTask(task),
          reason: typeof task.reason === "string" ? task.reason : null,
          requestedAgentId: task.meta.requestedAgentId || null,
          requestedAgentNameSnapshot: task.meta.requestedAgentNameSnapshot || null,
          executorAgentId: task.meta.executorAgentId || null,
          executorAgentNameSnapshot: task.meta.executorAgentNameSnapshot || null,
          executorMetaVersion: task.meta.executorMetaVersion || null,
          createdAt: task.deferredAt ? new Date(task.deferredAt).toISOString() : null,
        });
        imported++;
      }
    }
  } catch (err) {
    log?.(`[migrations] #28: deferred subagent run import skipped (${err.message})`);
  }

  log?.(`[migrations] #28: durable subagent run registry backfilled (${imported})`);
}

function readJsonForMigration(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

function normalizeMigratedRunStatus(status) {
  if (status === "resolved" || status === "failed" || status === "aborted") return status;
  return "failed";
}

function migrateSubagentThreadRegistry(ctx) {
  const { lucHome, log } = ctx;
  const threadStore = new SubagentThreadStore(path.join(lucHome, "subagent-threads.json"));
  const runStore = new SubagentRunStore(path.join(lucHome, "subagent-runs.json"));
  let importedRuns = 0;
  let importedReusable = 0;

  for (const run of runStore.list()) {
    if (!run?.taskId || !String(run.taskId).startsWith("subagent-")) continue;
    if (!run.childSessionPath) continue;
    const threadId = run.threadId || run.taskId;
    const status = normalizeMigratedRunStatus(run.status);
    threadStore.beginRun(threadId, {
      kind: "direct",
      parentSessionPath: run.parentSessionPath || null,
      agentId: run.executorAgentId || run.requestedAgentId || null,
      agentName: run.executorAgentNameSnapshot || run.requestedAgentNameSnapshot || null,
      summary: run.summary || null,
    });
    threadStore.attachSession(threadId, run.childSessionPath, {
      parentSessionPath: run.parentSessionPath || null,
      agentId: run.executorAgentId || run.requestedAgentId || null,
      agentName: run.executorAgentNameSnapshot || run.requestedAgentNameSnapshot || null,
    });
    threadStore.finishRun(threadId, {
      status,
      summary: run.summary || run.reason || null,
      close: true,
    });
    runStore.upsert(run.taskId, { threadId, threadKind: "direct" });
    importedRuns += 1;
  }

  const reusableRaw = readJsonForMigration(path.join(lucHome, "reusable-subagents.json"));
  const instances = reusableRaw?.instances && typeof reusableRaw.instances === "object"
    ? reusableRaw.instances
    : {};
  for (const [reuseKey, rec] of Object.entries(instances) as [string, any][]) {
    if (!reuseKey || !rec || typeof rec !== "object") continue;
    const threadId = `reusable::${reuseKey}`;
    threadStore.upsert(threadId, {
      kind: "direct",
      status: "open",
      lastRunStatus: normalizeMigratedRunStatus(rec.lastStatus),
      parentSessionPath: rec.parentSessionPath || null,
      agentId: rec.agentId || null,
      childSessionPath: rec.childSessionPath || null,
      label: rec.taskSuffix || null,
      summary: rec.summary || null,
      runCount: rec.runCount || 0,
      createdAt: rec.createdAt || null,
      lastRunAt: rec.lastRunAt || null,
    });
    importedReusable += 1;
  }

  log?.(`[migrations] #36: subagent thread registry backfilled (runs=${importedRuns}, reusable=${importedReusable})`);
}

function pickLegacySubagentLabel(rec) {
  if (typeof rec?.label === "string" && rec.label.trim()) return rec.label.trim();
  if (typeof rec?.instance === "string" && rec.instance.trim()) return rec.instance.trim();
  if (typeof rec?.taskSuffix === "string" && rec.taskSuffix.trim()) return rec.taskSuffix.trim();
  if (typeof rec?.reuseKey === "string" && rec.reuseKey.trim()) {
    const parts = rec.reuseKey.split("::").map((part) => part.trim()).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : null;
  }
  return null;
}

function migrateSubagentDirectThreadSemantics(ctx) {
  const { lucHome, log } = ctx;
  const threadsPath = path.join(lucHome, "subagent-threads.json");
  const runsPath = path.join(lucHome, "subagent-runs.json");
  let threadCount = 0;
  let runCount = 0;

  const rawThreads = readJsonForMigration(threadsPath);
  const threads = rawThreads?.threads && typeof rawThreads.threads === "object" ? rawThreads.threads : null;
  if (threads) {
    for (const rec of Object.values(threads) as any[]) {
      if (!rec || typeof rec !== "object") continue;
      if (rec.kind === "ephemeral" || rec.kind === "reusable") {
        rec.kind = "direct";
        threadCount += 1;
      }
      const label = pickLegacySubagentLabel(rec);
      if (label && !(typeof rec.label === "string" && rec.label.trim())) {
        rec.label = label;
        threadCount += 1;
      }
      for (const key of ["instance", "reuseKey", "taskSuffix"]) {
        if (Object.prototype.hasOwnProperty.call(rec, key)) {
          delete rec[key];
          threadCount += 1;
        }
      }
    }
    if (threadCount > 0) {
      atomicWriteSync(threadsPath, JSON.stringify(rawThreads, null, 2) + "\n");
    }
  }

  const rawRuns = readJsonForMigration(runsPath);
  const runs = rawRuns?.runs && typeof rawRuns.runs === "object" ? rawRuns.runs : null;
  if (runs) {
    for (const rec of Object.values(runs) as any[]) {
      if (!rec || typeof rec !== "object") continue;
      if (rec.threadKind === "ephemeral" || rec.threadKind === "reusable") {
        rec.threadKind = "direct";
        runCount += 1;
      }
    }
    if (runCount > 0) {
      atomicWriteSync(runsPath, JSON.stringify(rawRuns, null, 2) + "\n");
    }
  }

  log?.(`[migrations] #37: subagent direct semantics normalized (threads=${threadCount}, runs=${runCount})`);
}

function migrateLegacyApiKeyAuthEntriesToProviders(ctx) {
  const result = migrateLegacyApiKeyAuthToProviders(ctx);
  ctx.log?.(`[migrations] #19: legacy API-key auth migrated (${result.providers.join(", ") || "none"})`);
}

function migrateChannelPhoneSettingsDefaults(ctx) {
  const { lucHome, log } = ctx;
  const channelsDir = path.join(lucHome, "channels");
  if (!fs.existsSync(channelsDir)) {
    log?.("[migrations] #22: no channels dir");
    return;
  }

  let patched = 0;
  for (const entry of fs.readdirSync(channelsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const filePath = path.join(channelsDir, entry.name);
    const raw = fs.readFileSync(filePath, "utf-8");
    const next = patchChannelPhoneSettingsFrontmatter(raw);
    if (next === raw) continue;
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, next, "utf-8");
    fs.renameSync(tmp, filePath);
    patched++;
  }

  log?.(`[migrations] #22: channel phone settings defaults patched (${patched})`);
}

function removeAgentPhoneReplyInstructions(ctx) {
  const { lucHome, agentsDir, log } = ctx;
  let channelPatched = 0;
  let projectionPatched = 0;

  const patchFile = (filePath, keys) => {
    const raw = fs.readFileSync(filePath, "utf-8");
    const next = removeFrontmatterKeys(raw, keys);
    if (next === raw) return false;
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, next, "utf-8");
    fs.renameSync(tmp, filePath);
    return true;
  };

  const channelsDir = path.join(lucHome, "channels");
  if (fs.existsSync(channelsDir)) {
    for (const entry of fs.readdirSync(channelsDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      if (patchFile(path.join(channelsDir, entry.name), new Set(["agentPhoneReplyInstructions"]))) {
        channelPatched++;
      }
    }
  }

  if (fs.existsSync(agentsDir)) {
    for (const agentEntry of readDirectoryLikeDirentsSync(agentsDir)) {
      const conversationsDir = path.join(agentsDir, agentEntry.name, "phone", "conversations");
      if (!fs.existsSync(conversationsDir)) continue;
      for (const entry of fs.readdirSync(conversationsDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
        if (patchFile(path.join(conversationsDir, entry.name), new Set(["replyInstructions"]))) {
          projectionPatched++;
        }
      }
    }
  }

  log?.(`[migrations] #23: deprecated reply-scope settings removed (channels=${channelPatched}, projections=${projectionPatched})`);
}

function migrateChannelPhoneGuardLimitDefaults(ctx) {
  const { lucHome, log } = ctx;
  const channelsDir = path.join(lucHome, "channels");
  if (!fs.existsSync(channelsDir)) {
    log?.("[migrations] #24: no channels dir");
    return;
  }

  let patched = 0;
  for (const entry of fs.readdirSync(channelsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const filePath = path.join(channelsDir, entry.name);
    const raw = fs.readFileSync(filePath, "utf-8");
    const next = patchChannelGuardLimitFrontmatter(raw);
    if (next === raw) continue;
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, next, "utf-8");
    fs.renameSync(tmp, filePath);
    patched++;
  }

  log?.(`[migrations] #24: channel phone guard limits patched (${patched})`);
}

function migrateChannelPhoneProactiveDefaults(ctx) {
  const { lucHome, log } = ctx;
  const channelsDir = path.join(lucHome, "channels");
  if (!fs.existsSync(channelsDir)) {
    log?.("[migrations] #25: no channels dir");
    return;
  }

  let patched = 0;
  for (const entry of fs.readdirSync(channelsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const filePath = path.join(channelsDir, entry.name);
    const raw = fs.readFileSync(filePath, "utf-8");
    const next = patchChannelProactiveFrontmatter(raw);
    if (next === raw) continue;
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, next, "utf-8");
    fs.renameSync(tmp, filePath);
    patched++;
  }

  log?.(`[migrations] #25: channel phone proactive defaults patched (${patched})`);
}

function removeFrontmatterKeys(raw, keys) {
  const lines = raw.split("\n");
  if (lines[0]?.trim() !== "---") return raw;
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      end = i;
      break;
    }
  }
  if (end < 0) return raw;

  let changed = false;
  const nextFm = [];
  for (const line of lines.slice(1, end)) {
    const idx = line.indexOf(":");
    const key = idx >= 0 ? line.slice(0, idx).trim() : "";
    if (key && keys.has(key)) {
      changed = true;
      continue;
    }
    nextFm.push(line);
  }
  if (!changed) return raw;
  return ["---", ...nextFm, "---", ...lines.slice(end + 1)].join("\n");
}

function parseAgentPhoneProjectionFrontmatter(raw) {
  const lines = raw.split("\n");
  if (lines[0]?.trim() !== "---") return null;
  const meta = new Map();
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === "---") return { meta };
    const idx = lines[i].indexOf(":");
    if (idx < 0) continue;
    meta.set(lines[i].slice(0, idx).trim(), lines[i].slice(idx + 1).trim());
  }
  return null;
}

function agentPhoneRuntimePatchFromMeta(meta) {
  const patch: any = {};
  for (const key of AGENT_PHONE_RUNTIME_KEYS) {
    if (!meta.has(key)) continue;
    const value = meta.get(key);
    if (key === "promptSnapshot") {
      const parsed = parseEncodedFrontmatterJson(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        patch.promptSnapshot = parsed;
      }
      continue;
    }
    if (typeof value === "string" && value.trim()) {
      patch[key] = value.trim();
    }
  }
  return patch;
}

function parseEncodedFrontmatterJson(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const candidates = [value.trim()];
  try {
    const decoded = decodeURIComponent(value.trim());
    if (decoded !== value.trim()) candidates.unshift(decoded);
  } catch {
    // Raw JSON remains a valid candidate.
  }
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next representation.
    }
  }
  return null;
}

function patchChannelGuardLimitFrontmatter(raw) {
  const lines = raw.split("\n");
  if (lines[0]?.trim() !== "---") return raw;
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      end = i;
      break;
    }
  }
  if (end < 0) return raw;

  const fmLines = lines.slice(1, end);
  const meta = new Map();
  for (const line of fmLines) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    meta.set(line.slice(0, idx).trim(), line.slice(idx + 1).trim());
  }

  const current = Number(meta.get("agentPhoneGuardLimit"));
  if (Number.isFinite(current) && current > 0) return raw;

  const memberCount = parseFrontmatterMemberCount(meta.get("members"));
  meta.set("agentPhoneGuardLimit", String(memberCount * 12));

  const originalKeys = [];
  for (const line of fmLines) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    originalKeys.push(line.slice(0, idx).trim());
  }
  const orderedKeys = [
    ...originalKeys,
    ...[...meta.keys()].filter((key) => !originalKeys.includes(key)),
  ];
  const nextFm = orderedKeys.map((key) => `${key}: ${meta.get(key)}`);
  return ["---", ...nextFm, "---", ...lines.slice(end + 1)].join("\n");
}

function patchChannelProactiveFrontmatter(raw) {
  const lines = raw.split("\n");
  if (lines[0]?.trim() !== "---") return raw;
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      end = i;
      break;
    }
  }
  if (end < 0) return raw;

  const fmLines = lines.slice(1, end);
  const meta = new Map();
  for (const line of fmLines) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    meta.set(line.slice(0, idx).trim(), line.slice(idx + 1).trim());
  }

  const current = meta.get("agentPhoneProactiveEnabled");
  if (current === "true" || current === "false") return raw;
  meta.set("agentPhoneProactiveEnabled", "true");

  const originalKeys = [];
  for (const line of fmLines) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    originalKeys.push(line.slice(0, idx).trim());
  }
  const orderedKeys = [
    ...originalKeys,
    ...[...meta.keys()].filter((key) => !originalKeys.includes(key)),
  ];
  const nextFm = orderedKeys.map((key) => `${key}: ${meta.get(key)}`);
  return ["---", ...nextFm, "---", ...lines.slice(end + 1)].join("\n");
}

function parseFrontmatterMemberCount(value) {
  if (typeof value !== "string") return 3;
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return 3;
  const count = trimmed
    .slice(1, -1)
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .length;
  return count > 0 ? count : 3;
}

function patchChannelPhoneSettingsFrontmatter(raw) {
  const lines = raw.split("\n");
  if (lines[0]?.trim() !== "---") return raw;
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      end = i;
      break;
    }
  }
  if (end < 0) return raw;

  const fmLines = lines.slice(1, end);
  const meta = new Map();
  for (const line of fmLines) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    meta.set(line.slice(0, idx).trim(), line.slice(idx + 1).trim());
  }

  let changed = false;
  const setKey = (key, value) => {
    const str = String(value);
    if (meta.get(key) === str) return;
    meta.set(key, str);
    changed = true;
  };

  const interval = Number(meta.get("agentPhoneReminderIntervalMinutes"));
  if (!Number.isFinite(interval) || interval <= 0) {
    setKey("agentPhoneReminderIntervalMinutes", "31");
  }
  if (!["true", "false"].includes(meta.get("agentPhoneProactiveEnabled"))) {
    setKey("agentPhoneProactiveEnabled", "true");
  }

  const overrideEnabled = meta.get("agentPhoneModelOverrideEnabled") === "true";
  const overrideId = meta.get("agentPhoneModelOverrideId") || "";
  const overrideProvider = meta.get("agentPhoneModelOverrideProvider") || "";
  if (!meta.has("agentPhoneModelOverrideEnabled")) {
    setKey("agentPhoneModelOverrideEnabled", "false");
  }
  if (overrideEnabled && (!overrideId || !overrideProvider)) {
    setKey("agentPhoneModelOverrideEnabled", "false");
    setKey("agentPhoneModelOverrideId", "");
    setKey("agentPhoneModelOverrideProvider", "");
  }

  if (!changed) return raw;

  const originalKeys = [];
  for (const line of fmLines) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    originalKeys.push(line.slice(0, idx).trim());
  }
  const orderedKeys = [
    ...originalKeys,
    ...[...meta.keys()].filter((key) => !originalKeys.includes(key)),
  ];
  const nextFm = orderedKeys.map((key) => `${key}: ${meta.get(key)}`);
  return ["---", ...nextFm, "---", ...lines.slice(end + 1)].join("\n");
}
