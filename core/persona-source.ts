/**
 * persona-source.ts — identity.md / AGENTS.md 的统一回落链（惰性材料化）
 *
 * 每个 agent 的人格文件叫 AGENTS.md，对外变体叫 AGENTS.public.md。这套命名
 * 跟随业界的 AGENTS.md 约定：人格文件是跟着 agent 走的全局层，工作区目录里
 * 的 AGENTS.md 是项目层，两层各注入一次是预期常态而不是重复。
 *
 * 人格模板不再在创建 agent 时落盘：agentDir 里没有 identity.md / AGENTS.md
 * 时，运行时按当前 locale 现选 lib 模板；用户在设置页编辑保存后才真正落盘
 * （落盘 = 用户显式定制）。这份回落链必须是全仓唯一实现——runtime system
 * prompt 组装（core/agent.ts）、GET 路由（server/routes/agents.ts、
 * server/routes/config.ts）、花名册摘要（core/agent-manager.ts）、角色卡导出
 * （lib/character-cards/service.ts）、设置快照（server/routes/settings-snapshot.ts）
 * 全部消费这一份实现，禁止各自复制回落顺序，否则多份拷贝会在未来某次模板
 * 改名/加语言时悄悄漂移。
 *
 * 回落顺序：
 *   1. agentDir 下的落盘文件（用户定制内容）
 *   2. 该 yuan 的语言专属模板（identity-templates/en/xxx.md 等）
 *   3. 该 yuan 的通用模板（不分语言）
 *   4. 通用 example 兜底（identity.example.md / agents.example.md）
 */

import path from "path";
import { safeReadFile } from "../shared/safe-fs.ts";

export type PersonaKind = "identity" | "agents";

export interface PersonaSourceResult {
  content: string;
  /** true = 内容来自模板回落（agentDir 没有落盘文件）；false = 用户已定制落盘 */
  fromTemplate: boolean;
}

export interface ResolvePersonaSourceArgs {
  agentDir: string;
  productDir: string;
  yuanType: string;
  locale: string;
  kind: PersonaKind;
}

const KIND_CONFIG: Record<PersonaKind, { fileName: string; templateDir: string; exampleFile: string }> = {
  identity: {
    fileName: "identity.md",
    templateDir: "identity-templates",
    exampleFile: "identity.example.md",
  },
  agents: {
    fileName: "AGENTS.md",
    templateDir: "agents-templates",
    exampleFile: "agents.example.md",
  },
};

/** 对外人格文件名。它有自己的回落链（core/agent.ts），不走 KIND_CONFIG。 */
export const PUBLIC_PERSONA_FILE_NAME = "AGENTS.public.md";
export const PUBLIC_PERSONA_TEMPLATE_DIR = "agents-public-templates";

/**
 * agent 自己的人格文件绝对路径。会话工作目录落在 agent 目录里时，工作区注入
 * 要靠这份清单把人格文件排除掉，否则同一份内容会被注入两次。文件名只在这个
 * 模块里定义一次，调用方不许自己拼。
 */
export function agentPersonaFilePaths(agentDir: string): string[] {
  return [
    path.join(agentDir, KIND_CONFIG.agents.fileName),
    path.join(agentDir, PUBLIC_PERSONA_FILE_NAME),
  ];
}

export function resolvePersonaSource({
  agentDir,
  productDir,
  yuanType,
  locale,
  kind,
}: ResolvePersonaSourceArgs): PersonaSourceResult {
  const { fileName, templateDir, exampleFile } = KIND_CONFIG[kind];
  const isZh = String(locale).startsWith("zh");
  const langDir = isZh ? "" : "en/";
  const readFile = (p: string) => safeReadFile(p, "");

  const own = readFile(path.join(agentDir, fileName));
  if (own) return { content: own, fromTemplate: false };

  const langTemplate = readFile(path.join(productDir, templateDir, `${langDir}${yuanType}.md`));
  if (langTemplate) return { content: langTemplate, fromTemplate: true };

  const genericTemplate = readFile(path.join(productDir, templateDir, `${yuanType}.md`));
  if (genericTemplate) return { content: genericTemplate, fromTemplate: true };

  const example = readFile(path.join(productDir, exampleFile));
  return { content: example, fromTemplate: true };
}

/**
 * 没有 Agent 实例时（花名册扫描、导出、快照等场景，agent 可能尚未加载进
 * engine 内存）解析 locale：与 Agent.resolveLocale() 同一条链——agent 自身
 * config.yaml 的 locale 显式值优先，缺失时落全局 prefs 的 locale，两级都缺
 * 落 "en"。
 */
export function resolvePersonaLocale(configLocale: unknown, globalLocale: unknown): string {
  const explicit = typeof configLocale === "string" ? configLocale.trim() : "";
  if (explicit) return explicit;
  const global_ = typeof globalLocale === "string" ? globalLocale.trim() : "";
  if (global_) return global_;
  return "en";
}
