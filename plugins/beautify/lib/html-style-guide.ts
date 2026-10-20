import { t } from "../../../lib/i18n.ts";

export const HTML_STYLE_GUIDE_VERSION = "2026-06-10";

// section 名 → i18n key 片段（仅 anti-patterns 需要驼峰映射）。
// 该 Map 是章节唯一源：HTML_STYLE_GUIDE_SECTIONS 由它派生，新增章节只改这里。
const SECTION_I18N_KEY = new Map([
  ["color", "color"],
  ["typography", "typography"],
  ["layout", "layout"],
  ["components", "components"],
  ["imagery", "imagery"],
  ["motion", "motion"],
  ["anti-patterns", "antiPatterns"],
]);

export const HTML_STYLE_GUIDE_SECTIONS = [...SECTION_I18N_KEY.keys()];

export const REQUIRED_SECTIONS = ["color", "typography"];

// 已读章节状态：keyed by sessionId when available; legacy sessionPath remains a compatibility key.
// 防懒辅助状态，进程内存即可；Map 迭代序 = 插入序，超容量时逐出最旧 session。
const MAX_TRACKED_SESSIONS = 200;
const readSectionsBySession = new Map<string, Set<string>>();

export function sessionTrackingKey(ctx: any): string {
  const sessionId = ctx && typeof ctx.sessionId === "string" ? ctx.sessionId.trim() : "";
  if (sessionId) return `id:${sessionId}`;
  const sessionPath = ctx && typeof ctx.sessionPath === "string" ? ctx.sessionPath : "";
  return sessionPath || "__no_session__";
}

export function markSectionRead(trackingKey: string, section: string): void {
  let read = readSectionsBySession.get(trackingKey);
  if (!read) {
    if (readSectionsBySession.size >= MAX_TRACKED_SESSIONS) {
      const oldest = readSectionsBySession.keys().next().value;
      if (oldest !== undefined) {
        readSectionsBySession.delete(oldest);
      }
    }
    read = new Set<string>();
    readSectionsBySession.set(trackingKey, read);
  }
  read.add(section);
}

export function getReadSections(trackingKey: string): string[] {
  return [...(readSectionsBySession.get(trackingKey) ?? [])];
}

export function missingRequiredSections(trackingKey: string): string[] {
  const read = readSectionsBySession.get(trackingKey) ?? new Set<string>();
  return REQUIRED_SECTIONS.filter((section) => !read.has(section));
}

export function resetHtmlStyleGuideTracking(): void {
  readSectionsBySession.clear();
}

export function buildHtmlStyleGuideRouter(): string {
  return t("plugin.beautify.htmlStyleGuide.router");
}

export function buildHtmlStyleGuideSection(section: string): string | null {
  const key = SECTION_I18N_KEY.get(section);
  if (!key) return null;
  return t(`plugin.beautify.htmlStyleGuide.${key}`);
}
