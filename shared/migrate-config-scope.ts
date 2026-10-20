// shared/migrate-config-scope.ts

import fs from "fs";
import path from "path";
import YAML from "js-yaml";
import { CONFIG_SCHEMA } from './config-schema.ts';
import { writeSecretFileSync } from "./secret-fs.ts";

/**
 * Suffix of the one-time backup this migration keeps beside each agent config.
 * Exported so the startup custody pass locates the same files this writes;
 * spelling it out in both places is how the two would drift apart.
 */
export const CONFIG_SCOPE_BACKUP_SUFFIX = ".pre-scope-migration";

/**
 * 一次性迁移：将 agent config.yaml 中的 global scope 字段
 * 向上迁移到 preferences.json，然后从 config.yaml 中删除。
 *
 * 策略：migrate up, then clean。
 * - 如果 preferences 中已有非默认值，以 preferences 为准
 * - 如果 preferences 中无值，从 primary agent 的 config.yaml 取
 * - 迁移前对每个 agent 的 config.yaml 做 .pre-scope-migration 备份
 *
 * @param {object} opts
 * @param {string} opts.agentsDir - agents 根目录
 * @param {object} opts.prefs - PreferencesManager 实例
 * @param {string|null} opts.primaryAgentId - 主 agent ID
 * @param {(msg: string) => void} [opts.log] - 日志回调
 */
export function migrateConfigScope({ agentsDir, prefs, primaryAgentId, log = () => {} }: { agentsDir: string; prefs: any; primaryAgentId: string | null; log?: (msg: string) => void }) {
  const preferences = prefs.getPreferences();

  // 已迁移过则跳过
  if (preferences._configScopeMigrated) return;

  log("[migrate] config scope 迁移开始...");

  // 收集所有 agent 的 config.yaml
  const agentConfigs = [];
  const sourceErrors: string[] = [];
  try {
    const entries = fs.readdirSync(agentsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const cfgPath = path.join(agentsDir, entry.name, "config.yaml");
      if (!fs.existsSync(cfgPath)) continue;
      try {
        const content = fs.readFileSync(cfgPath, "utf-8");
        const config = YAML.load(content) || {};
        if (typeof config !== "object" || Array.isArray(config)) {
          throw new Error("config root must be an object");
        }
        agentConfigs.push({ id: entry.name, path: cfgPath, config, content });
      } catch (err) {
        sourceErrors.push(`${entry.name}: ${err.message}`);
      }
    }
  } catch (err) {
    if (err?.code === "ENOENT") return;
    throw new Error(`Cannot inspect agent configs for scope migration: ${err.message}`, { cause: err });
  }

  if (agentConfigs.length === 0) {
    if (sourceErrors.length > 0) {
      throw new Error(`Unreadable agent config prevents migration receipt: ${sourceErrors.join("; ")}`);
    }
    preferences._configScopeMigrated = true;
    prefs.savePreferences(preferences);
    return;
  }

  // 按优先级排序：primary agent 在前
  agentConfigs.sort((a, b) => {
    if (a.id === primaryAgentId) return -1;
    if (b.id === primaryAgentId) return 1;
    return 0;
  });

  const readPath = (obj, parts) => {
    let cur = obj;
    for (const part of parts) {
      if (cur == null || typeof cur !== 'object') return undefined;
      cur = cur[part];
    }
    return cur;
  };

  const writePath = (obj, parts, value) => {
    if (parts.length === 1) {
      obj[parts[0]] = value;
      return;
    }
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (!cur[part] || typeof cur[part] !== 'object') cur[part] = {};
      cur = cur[part];
    }
    cur[parts[parts.length - 1]] = value;
  };

  // Phase 1: migrate up — 将 agent config 中的全局值提升到 preferences
  for (const [schemaPath, def] of Object.entries(CONFIG_SCHEMA) as [string, { scope: string; setter?: string; getter?: string; prefsPath?: string; defaultValue?: unknown }][]) {
    if (def.scope !== 'global') continue;

    const parts = schemaPath.split('.');
    const prefsParts = (def.prefsPath || schemaPath).split('.');
    const prefsValue = readPath(preferences, prefsParts);

    // 判断 preferences 是否已有非默认值
    const defaultVal = def.defaultValue;
    const prefsHasValue = prefsValue !== undefined && prefsValue !== defaultVal;
    if (prefsHasValue) continue; // preferences 已有值，不覆盖

    // 从 agent configs 中找第一个有值的（已按 primary 优先排序）
    for (const ac of agentConfigs) {
      const agentValue = readPath(ac.config, parts);

      if (agentValue !== undefined && agentValue !== defaultVal) {
        writePath(preferences, prefsParts, agentValue);
        log(`[migrate] ${schemaPath}: "${JSON.stringify(agentValue)}" migrated from agent "${ac.id}" to preferences`);
        break;
      }
    }
  }

  // Persist the destination before cleaning any source. If this write fails,
  // every agent config remains untouched and the migration can retry later.
  // The completion marker is deliberately written only after cleanup.
  prefs.savePreferences(preferences);

  // Phase 2: clean — 从所有 agent config.yaml 中删除 global scope 字段
  for (const ac of agentConfigs) {
    let changed = false;
    for (const schemaPath of Object.keys(CONFIG_SCHEMA)) {
      const parts = schemaPath.split('.');
      if (parts.length === 1 && parts[0] in ac.config) {
        delete ac.config[parts[0]];
        changed = true;
      } else if (parts.length === 2) {
        if (ac.config[parts[0]]?.[parts[1]] !== undefined) {
          delete ac.config[parts[0]][parts[1]];
          if (Object.keys(ac.config[parts[0]]).length === 0) {
            delete ac.config[parts[0]];
          }
          changed = true;
        }
      }
    }

    if (changed) {
      // 备份
      const backupPath = ac.path + CONFIG_SCOPE_BACKUP_SUFFIX;
      if (!fs.existsSync(backupPath)) {
        // 备份的是 agent 配置原文，带凭证，权限与源文件一致
        writeSecretFileSync(backupPath, ac.content);
      }
      // 写回清理后的 config
      writeSecretFileSync(ac.path, YAML.dump(ac.config, { lineWidth: -1 }));
      log(`[migrate] cleaned global fields from ${ac.id}/config.yaml`);
    }
  }

  if (sourceErrors.length > 0) {
    throw new Error(`Unreadable agent config prevents migration receipt: ${sourceErrors.join("; ")}`);
  }

  // Mark complete only after every readable source has been cleaned and no
  // source was skipped. A failed marker write is safe: the destination is
  // already durable and a retry is idempotent.
  const completedPreferences = prefs.getPreferences();
  completedPreferences._configScopeMigrated = true;
  prefs.savePreferences(completedPreferences);

  log("[migrate] config scope 迁移完成");
}
