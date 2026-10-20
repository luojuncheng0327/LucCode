/**
 * first-run.js — 首次运行播种
 *
 * 在 server/engine 启动之前调用，确保 ~/.luccode/ 结构存在。
 * 如果是全新安装（agents/ 为空），自动创建默认 agent。
 */

import fs from "fs";
import path from "path";
import YAML from "js-yaml";
import { safeCopyDir } from '../shared/safe-fs.ts';
import { writeSecretFileSync } from '../shared/secret-fs.ts';
import { AppError } from '../shared/errors.ts';
import { errorBus } from '../shared/error-bus.ts';
import {
  DEFAULT_HEARTBEAT_INTERVAL_MINUTES,
  ensureDefaultWorkspace,
} from "../shared/default-workspace.ts";
import { createModuleLogger } from "../lib/debug-log.ts";
import { USER_PROFILE_FILENAME } from "../lib/user-profile-store.ts";
import { isValidAgentId } from "../shared/agent-id.ts";
import { PUBLIC_PERSONA_FILE_NAME, PUBLIC_PERSONA_TEMPLATE_DIR } from "./persona-source.ts";

const log = createModuleLogger("first-run");

const DEFAULT_AGENT_ID = "luc";

export interface InvalidAgentDirReport {
  id: string;
  reason: "invalid_id" | "config_missing" | "config_unreadable";
}

export interface FirstRunReport {
  /** 缺失/损坏 config.yaml 而被跳过的非默认 agent 目录（用户数据原样保留） */
  invalidAgentDirs: InvalidAgentDirReport[];
  /** 本次是否播种/修复了默认 agent */
  repairedDefaultAgent: boolean;
  /** 默认 agent config 损坏时的备份文件路径 */
  defaultConfigBackupPath: string | null;
}

/**
 * 确保 ~/.luccode/ 数据目录就绪
 *
 * 对 agent 目录采用"分类处置"而不是 fail-fast：
 * - 默认 agent（luc）缺 config → 播种修复；config 损坏 → 先备份再播种
 * - 非默认目录缺/坏 config → 跳过并记入诊断报告，不阻断启动、不动用户数据
 * 历史上脏目录有多个来源（旧版物理删除残留、phone projection 复活、半截创建），
 * 启动链路必须容忍它们，运行时扫描（AgentManager）本来就会跳过这类目录。
 *
 * @param {string} lucHome - ~/.luccode 绝对路径
 * @param {string} productDir - 产品模板目录（lib/）
 */
export function ensureFirstRun(lucHome, productDir): FirstRunReport {
  // 1. 确保目录结构存在
  const userDir = path.join(lucHome, "user");
  fs.mkdirSync(path.join(lucHome, "agents"), { recursive: true });
  fs.mkdirSync(userDir, { recursive: true });

  // 2. 分类每个 agent 目录；没有任何可用 agent → 播种默认 agent
  const agentsDir = path.join(lucHome, "agents");
  const agentEntries = fs.readdirSync(agentsDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'));

  const invalidAgentDirs: InvalidAgentDirReport[] = [];
  const validAgentIds = new Set<string>();
  let defaultAgentState: "valid" | "invalid_id" | "config_missing" | "config_unreadable" | null = null;
  for (const entry of agentEntries) {
    const cls = classifyAgentDirectoryForStartup(agentsDir, entry.name);
    if (entry.name === DEFAULT_AGENT_ID) {
      defaultAgentState = cls.status === "valid" ? "valid" : cls.reason;
      if (cls.status === "valid") validAgentIds.add(entry.name);
      continue;
    }
    if (cls.status === "valid") {
      validAgentIds.add(entry.name);
      continue;
    }
    invalidAgentDirs.push({ id: entry.name, reason: cls.reason });
    log.warn(
      `invalid agent directory "${entry.name}": `
      + (cls.reason === "invalid_id"
        ? "ID must use ASCII letters, digits, underscores, or hyphens and include a letter or digit"
        : cls.reason === "config_missing"
          ? "config.yaml missing"
          : `config.yaml is not readable: ${cls.detail}`)
      + "（已跳过，不阻断启动；目录内容保留，请手动确认后清理）",
    );
  }

  const hasAgent = validAgentIds.size > 0;
  const needsDefaultAgentRepair = defaultAgentState === "config_missing" || defaultAgentState === "config_unreadable";

  let repairedDefaultAgent = false;
  let defaultConfigBackupPath: string | null = null;
  if (!hasAgent || needsDefaultAgentRepair) {
    if (defaultAgentState === "config_unreadable") {
      defaultConfigBackupPath = backupUnreadableDefaultConfig(agentsDir);
      log.warn(`默认助手 config.yaml 无法解析，已备份到 ${defaultConfigBackupPath}`);
    }
    log.log(needsDefaultAgentRepair ? "默认助手数据不完整，正在补齐..." : "首次启动，正在创建默认助手...");
    seedDefaultAgent(agentsDir, productDir, userDir);
    repairedDefaultAgent = true;
    validAgentIds.add(DEFAULT_AGENT_ID);
  }

  // 3. 同步 skills：从 skills2set/ 复制到 ~/.luccode/skills/
  const skillsSrc = path.join(productDir, "..", "skills2set");
  const skillsDst = path.join(lucHome, "skills");
  fs.mkdirSync(skillsDst, { recursive: true });
  if (fs.existsSync(skillsSrc)) {
    syncSkills(skillsSrc, skillsDst);
  }

  // 4. 确保可选文件存在（老用户升级 + 新 agent 都覆盖）。
  // 只补有效 agent 目录：往无效目录里写 pinned.md 会把垃圾目录越喂越像 agent 目录。
  const touchIfMissing = (p) => { if (!fs.existsSync(p)) fs.writeFileSync(p, '', 'utf-8'); };
  touchIfMissing(path.join(lucHome, 'user', USER_PROFILE_FILENAME));
  for (const agentId of validAgentIds) {
    touchIfMissing(path.join(agentsDir, agentId, 'pinned.md'));
  }

  // 5. 确保 user/preferences.json 存在
  const prefsPath = path.join(lucHome, "user", "preferences.json");
  if (!fs.existsSync(prefsPath)) {
    fs.writeFileSync(
      prefsPath,
      JSON.stringify({
        primaryAgent: "luc",
      }, null, 2) + "\n",
      "utf-8",
    );
  }

  return { invalidAgentDirs, repairedDefaultAgent, defaultConfigBackupPath };
}

type AgentDirClassification =
  | { status: "valid" }
  | { status: "invalid"; reason: "invalid_id" | "config_missing" | "config_unreadable"; detail?: string };

function classifyAgentDirectoryForStartup(agentsDir, agentId): AgentDirClassification {
  if (!isValidAgentId(agentId)) {
    return { status: "invalid", reason: "invalid_id" };
  }
  const cfgPath = path.join(agentsDir, agentId, "config.yaml");
  if (!fs.existsSync(cfgPath)) {
    return { status: "invalid", reason: "config_missing" };
  }
  try {
    void YAML.load(fs.readFileSync(cfgPath, "utf-8"));
    return { status: "valid" };
  } catch (err) {
    return { status: "invalid", reason: "config_unreadable", detail: err?.message || String(err) };
  }
}

/** 默认 agent 的 config 解析失败时，把原文件改名备份，让播种写出干净的新 config */
function backupUnreadableDefaultConfig(agentsDir): string {
  const cfgPath = path.join(agentsDir, DEFAULT_AGENT_ID, "config.yaml");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${cfgPath}.broken-${stamp}`;
  fs.renameSync(cfgPath, backupPath);
  return backupPath;
}

/**
 * 从模板播种默认 agent（与 engine.createAgent 相同逻辑，但纯同步、无依赖）
 */
function seedDefaultAgent(agentsDir, productDir, userDir) {
  const agentId = "luc";
  const agentDir = path.join(agentsDir, agentId);

  // 创建目录结构
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(path.join(agentDir, "memory"), { recursive: true });
  fs.mkdirSync(path.join(agentDir, "sessions"), { recursive: true });
  fs.mkdirSync(path.join(agentDir, "avatars"), { recursive: true });
  fs.mkdirSync(path.join(agentDir, "desk"), { recursive: true });

  // config.yaml（保持模板默认值：name=Luc, yuan=luc）
  const cfgDest = path.join(agentDir, "config.yaml");
  const configSrc = path.join(productDir, "config.example.yaml");
  if (!fs.existsSync(configSrc)) {
    throw new Error(`first-run template missing: ${configSrc}`);
  }
  fs.copyFileSync(configSrc, cfgDest);
  // 写入默认工作台（per-agent，不存全局）
  const raw = fs.existsSync(cfgDest) ? YAML.load(fs.readFileSync(cfgDest, "utf-8")) || {} : {};
  raw.desk = {
    ...(raw.desk || {}),
    home_folder: ensureDefaultWorkspace(),
    heartbeat_enabled: false,
    heartbeat_interval: DEFAULT_HEARTBEAT_INTERVAL_MINUTES,
  };
  raw.memory = {
    ...(raw.memory || {}),
    enabled: true,
  };
  writeSecretFileSync(cfgDest, YAML.dump(raw, { indent: 2, lineWidth: -1, sortKeys: false, quotingType: '"' }));


  // 与 createAgent 同策略：按 yuan（= agentId）+ locale 优先，通用 example 兜底。
  // 与 Agent.resolveLocale() 同一条链条：先读刚写入的 config.yaml 的 locale，
  // 缺失时落全局 prefs 的 locale（修复损坏默认 agent 时 preferences.json 往往
  // 已存在；全新安装时它还没被第 5 步创建，读不到属于正常情况），两级都缺才落
  // "en"。
  let locale = "";
  try {
    if (fs.existsSync(cfgDest)) {
      const raw = YAML.load(fs.readFileSync(cfgDest, "utf-8")) || {};
      locale = typeof raw.locale === "string" ? raw.locale : "";
    }
  } catch {}
  if (!locale) {
    try {
      const prefsPath = path.join(userDir, "preferences.json");
      if (fs.existsSync(prefsPath)) {
        const prefs = JSON.parse(fs.readFileSync(prefsPath, "utf-8"));
        locale = typeof prefs?.locale === "string" ? prefs.locale : "";
      }
    } catch {}
  }
  const isZh = String(locale || "en").startsWith("zh");
  const langDir = isZh ? "" : "en/";
  const firstExisting = (paths) => paths.find((p) => fs.existsSync(p));

  // identity.md / AGENTS.md 不再在首启播种时落盘（惰性材料化）：缺失时运行时
  // 按 agent.resolveLocale() 现选 lib 模板（core/persona-source.ts 的
  // resolvePersonaSource，与 core/agent.ts personality getter 同一条回落
  // 链），用户日后改语言，未定制人格自动跟着换。文件只在用户于设置页编辑
  // 保存时才落盘。yuan 由 buildSystemPrompt 实时从 lib/yuan/ 读取，同样无需
  // 复制。

  // AGENTS.public.md（对外人格模板）：消费侧 Agent._readPublicAgentsMd 本来就
  // 有独立回落链，不受此改动影响，这里继续按原策略播种。
  const publicAgentsSrc = firstExisting([
    path.join(productDir, PUBLIC_PERSONA_TEMPLATE_DIR, `${langDir}${agentId}.md`),
    path.join(productDir, PUBLIC_PERSONA_TEMPLATE_DIR, `${agentId}.md`),
  ]);
  if (publicAgentsSrc) {
    fs.copyFileSync(publicAgentsSrc, path.join(agentDir, PUBLIC_PERSONA_FILE_NAME));
  }

  log.log(`默认助手 "${agentId}" 已创建`);
}

/**
 * 同步 skills2set/ → ~/.luccode/skills/
 * 每次启动都跑，确保新增/更新的 skill 能同步到用户目录
 */
function syncSkills(srcDir, dstDir) {
  fs.mkdirSync(dstDir, { recursive: true });

  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;

    const skillSrc = path.join(srcDir, entry.name);
    const skillDst = path.join(dstDir, entry.name);

    // 只要源里有 SKILL.md 就同步整个目录
    if (!fs.existsSync(path.join(skillSrc, "SKILL.md"))) continue;

    try {
      safeCopyDir(skillSrc, skillDst);
    } catch (err) {
      errorBus.report(new AppError('SKILL_SYNC_FAILED', {
        cause: err instanceof Error ? err : new Error(String(err)),
        context: { skill: entry.name },
      }));
      // Continue with other skills, don't abort
    }
  }
}
