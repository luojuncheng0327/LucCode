/**
 * message-parser.ts — 消息解析工具函数
 *
 * 从 app-messages-shim.ts 和 chat-render-shim.ts 提取，
 * 供 React 组件和 history-builder 共用。
 */

import { QUOTE_ORIGINAL_END, QUOTE_ORIGINAL_START } from './quoted-selection';
import { moodLabelForYuan } from '../../../../shared/yuan-visuals.ts';
import { parseLeadingInternalMoodBlock } from '../../../../shared/internal-mood-block.ts';

// ── Mood 解析 ──

const TAG_TO_YUAN: Record<string, string> = { mood: 'luc', pulse: 'butter', reflect: 'ming' };
// 当前块头是静态的；`at <时间戳>` 是历史 JSONL 里的旧块头，剥离端必须继续认
const SESSION_REMINDER_HEADER_RE = /^\[luc_reminder(?: at \d{4}-\d{2}-\d{2} \d{2}:\d{2})?\]\r?\n/;
const SESSION_REMINDER_END = '[/luc_reminder]';

function stripLeadingSessionReminder(content: string): string {
  const header = content.match(SESSION_REMINDER_HEADER_RE);
  if (!header) return content;
  const closingLine = `\n${SESSION_REMINDER_END}`;
  const closingIndex = content.indexOf(closingLine, header[0].length);
  if (closingIndex < 0) return content;
  const blockEnd = closingIndex + closingLine.length;
  const nextChar = content[blockEnd];
  if (nextChar !== undefined && nextChar !== '\n' && nextChar !== '\r') return content;
  return content.slice(blockEnd).replace(/^(?:\r?\n){0,2}/, '');
}

export function moodLabel(yuan: string): string {
  return moodLabelForYuan(yuan);
}

export function cleanMoodText(raw: string): string {
  return raw
    .replace(/^```\w*\n?/, '')
    .replace(/\n?```\s*$/, '')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '');
}

export function parseMoodFromContent(content: string): { mood: string | null; yuan: string | null; text: string } {
  if (!content) return { mood: null, yuan: null, text: '' };
  const block = parseLeadingInternalMoodBlock(content);
  if (!block) return { mood: null, yuan: null, text: content };
  const yuan = TAG_TO_YUAN[block.tag] || 'luc';
  const mood = cleanMoodText(block.content.trim());
  const text = block.rest.replace(/^\n+/, '').trim();
  return { mood, yuan, text };
}

// ── 用户附件解析 ──

export interface ParsedAttachments {
  text: string;
  files: Array<{ path: string; name: string; isDirectory: boolean }>;
  attachedImages: Array<{ path: string; name: string }>;
  attachedVideos: Array<{ path: string; name: string }>;
  attachedAudios: Array<{ path: string; name: string }>;
  sessionFileRefs: Array<{ fileId: string; sessionPath?: string; label: string; kind: string }>;
  deskContext: { dir: string; fileCount: number } | null;
  quotedText: string | null;
}

function baseName(p: string): string {
  const normalized = p.replace(/\\/g, '/');
  return normalized.split('/').pop() || p;
}

function parseSessionFileMarker(line: string): { fileId: string; sessionPath?: string; label: string; kind: string } | null {
  const match = line.match(/^\[SessionFile\]\s+(\{[\s\S]*\})\s*$/);
  if (!match) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1]);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const fileId = typeof record.fileId === 'string' ? record.fileId.trim() : '';
  if (!fileId) return null;
  const sessionPath = typeof record.sessionPath === 'string' && record.sessionPath.trim()
    ? record.sessionPath
    : undefined;
  const label = typeof record.label === 'string' && record.label.trim()
    ? record.label
    : fileId;
  const kind = typeof record.kind === 'string' && record.kind.trim()
    ? record.kind
    : 'attachment';
  return {
    fileId,
    ...(sessionPath ? { sessionPath } : {}),
    label,
    kind,
  };
}

export function parseUserAttachments(content: string): ParsedAttachments {
  if (!content) return { text: '', files: [], attachedImages: [], attachedVideos: [], attachedAudios: [], sessionFileRefs: [], deskContext: null, quotedText: null };
  content = stripLeadingSessionReminder(content);
  const lines = content.split('\n');
  const textLines: string[] = [];
  const files: Array<{ path: string; name: string; isDirectory: boolean }> = [];
  const attachedImages: Array<{ path: string; name: string }> = [];
  const attachedVideos: Array<{ path: string; name: string }> = [];
  const attachedAudios: Array<{ path: string; name: string }> = [];
  const sessionFileRefs: Array<{ fileId: string; sessionPath?: string; label: string; kind: string }> = [];
  const attachRe = /^\[(附件|目录|参考文档)\]\s+(.+)$/;
  const attachedImageRe = /^\[attached_image:\s*(.+?)\]\s*$/;
  const attachedVideoRe = /^\[attached_video:\s*(.+?)\]\s*$/;
  const attachedAudioRe = /^\[attached_audio:\s*(.+?)\]\s*$/;
  let deskContext: { dir: string; fileCount: number } | null = null;
  let quotedText: string | null = null;
  let inDeskBlock = false;
  let pendingQuoteOriginal = false;
  let inQuoteOriginal = false;
  let quoteOriginalLines: string[] = [];

  for (const line of lines) {
    if (inQuoteOriginal) {
      if (line === QUOTE_ORIGINAL_END) {
        quotedText = quoteOriginalLines.join('\n').trim();
        quoteOriginalLines = [];
        inQuoteOriginal = false;
        pendingQuoteOriginal = false;
      } else {
        quoteOriginalLines.push(line);
      }
      continue;
    }

    if (pendingQuoteOriginal && line === QUOTE_ORIGINAL_START) {
      inQuoteOriginal = true;
      quoteOriginalLines = [];
      continue;
    }

    const sessionFileRef = parseSessionFileMarker(line);
    if (sessionFileRef) {
      pendingQuoteOriginal = false;
      sessionFileRefs.push(sessionFileRef);
      continue;
    }

    const deskMatch = line.match(/^\[当前书桌目录\]\s+(.+)$/);
    if (deskMatch) {
      inDeskBlock = true;
      pendingQuoteOriginal = false;
      deskContext = { dir: deskMatch[1].trim(), fileCount: 0 };
      continue;
    }
    if (inDeskBlock) {
      if (line.startsWith('  ') || line.startsWith('...')) {
        if (line.startsWith('  ')) deskContext!.fileCount++;
        continue;
      }
      inDeskBlock = false;
    }

    const quoteMatch = line.match(/^\[引用片段\]\s+(.+)$/);
    if (quoteMatch) {
      const raw = quoteMatch[1];
      const titleMatch = raw.match(/^(.+?)（第\d/);
      quotedText = titleMatch ? titleMatch[1].trim() : raw.trim();
      pendingQuoteOriginal = true;
      continue;
    }

    const attachedImageMatch = line.match(attachedImageRe);
    if (attachedImageMatch) {
      pendingQuoteOriginal = false;
      const p = attachedImageMatch[1].trim();
      attachedImages.push({ path: p, name: baseName(p) });
      continue;
    }

    const attachedVideoMatch = line.match(attachedVideoRe);
    if (attachedVideoMatch) {
      pendingQuoteOriginal = false;
      const p = attachedVideoMatch[1].trim();
      attachedVideos.push({ path: p, name: baseName(p) });
      continue;
    }

    const attachedAudioMatch = line.match(attachedAudioRe);
    if (attachedAudioMatch) {
      pendingQuoteOriginal = false;
      const p = attachedAudioMatch[1].trim();
      attachedAudios.push({ path: p, name: baseName(p) });
      continue;
    }

    const m = line.match(attachRe);
    if (m) {
      const isDir = m[1] === '目录';
      const p = m[2].trim();
      const name = baseName(p);
      pendingQuoteOriginal = false;
      files.push({ path: p, name, isDirectory: isDir });
    } else {
      pendingQuoteOriginal = false;
      textLines.push(line);
    }
  }
  const text = textLines.join('\n').replace(/\n+$/, '').trim();
  return { text, files, attachedImages, attachedVideos, attachedAudios, sessionFileRefs, deskContext, quotedText };
}

// ── 工具详情提取 ──

export function truncatePath(p: string): string {
  if (!p || p.length <= 35) return p;
  return '…' + p.slice(-34);
}

export function extractHostname(u: string): string {
  if (!u) return '';
  try { return new URL(u).hostname; } catch { return u; }
}

export function truncateHead(s: string, max: number): string {
  if (!s || s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

export interface ToolDetail {
  text: string;
  /** 鼠标悬浮时展示的完整详情，通常用于被截断的安全敏感参数 */
  title?: string;
  /** 文件路径或 URL，存在时 ToolIndicator 渲染为可点击链接 */
  href?: string;
  /** 'file' 用 openFile，'url' 用 openExternal */
  hrefType?: 'file' | 'url';
}

export function extractToolDetail(name: string, args: Record<string, unknown> | undefined): ToolDetail {
  if (!args) return { text: '' };
  switch (name) {
    case 'read':
    case 'write':
    case 'edit':
    case 'edit-diff': {
      const p = (args.file_path || args.path || '') as string;
      return { text: truncatePath(p), href: p || undefined, hrefType: 'file' };
    }
    case 'bash':
    case 'exec_command': {
      const command = typeof args.command === 'string'
        ? args.command
        : typeof args.cmd === 'string'
          ? args.cmd
          : '';
      return { text: truncateHead(command, 40), title: command || undefined };
    }
    case 'terminal':
    case 'write_stdin': {
      const command = typeof args.command === 'string'
        ? args.command
        : typeof args.chars === 'string'
          ? args.chars
          : '';
      return { text: truncateHead(command, 40), title: command || undefined };
    }
    case 'glob':
    case 'find':
      return { text: (args.pattern || '') as string };
    case 'grep':
      return { text: truncateHead((args.pattern || '') as string, 30) +
        (args.path ? ` in ${truncatePath(args.path as string)}` : '') };
    case 'ls': {
      const p = (args.path || '') as string;
      return { text: truncatePath(p), href: p || undefined, hrefType: 'file' };
    }
    case 'web_fetch': {
      const url = (args.url || '') as string;
      return { text: extractHostname(url), href: url || undefined, hrefType: 'url' };
    }
    case 'web_search':
      return { text: truncateHead((args.query || '') as string, 40) };
    case 'browser': {
      const url = (args.url || '') as string;
      return { text: extractHostname(url), href: url || undefined, hrefType: 'url' };
    }
    case 'search_memory':
      return { text: truncateHead((args.query || '') as string, 40) };
    case 'subagent':
      return { text: truncateHead((args.task || '') as string, 30) };
    case 'dm':
      return { text: (args.to || '') as string };
    case 'channel':
      return { text: (args.channel || args.name || '') as string };
    case 'cron':
      return { text: truncateHead((args.label || args.prompt || '') as string, 30) };
    case 'notify':
      return { text: truncateHead((args.title || '') as string, 30) };
    case 'create_artifact':
      return { text: truncateHead((args.title || '') as string, 30) };
    case 'install_skill': {
      const sourceType = args.source && typeof args.source === 'object' && 'type' in args.source
        ? (args.source as { type?: unknown }).type
        : '';
      return { text: truncateHead((args.skill_name || args.github_url || args.local_path || args.fileId || sourceType || '') as string, 40) };
    }
    case 'update_settings':
      return { text: (args.key || args.setting || '') as string };
    case 'session': {
      // 目标会话名由渲染侧按 sessionId 查出来覆盖，这里只给查不到时的兜底
      if (args.action === 'create') return { text: (args.agent || '') as string };
      const sessionId = (args.sessionId || '') as string;
      return { text: sessionId ? `…${sessionId.slice(-4)}` : '' };
    }
    default: {
      // 插件工具：取第一个有意义的字符串参数作详情
      const first = Object.values(args).find(v => typeof v === 'string' && v.length > 0);
      return { text: first ? truncateHead(first as string, 30) : '' };
    }
  }
}

// ── Card 解析 ──

export interface ParsedCard {
  type: string;
  pluginId: string;
  route: string;
  title?: string;
  description: string;
}

export function parseCardFromContent(text: string | null | undefined): { cards: ParsedCard[]; text: string } {
  if (!text) return { cards: [], text: '' };
  const cards: ParsedCard[] = [];
  const fullRe = /<card((?:\s+[\w-]+="[^"]*")*)\s*>([\s\S]*?)<\/card>/g;
  let match;
  while ((match = fullRe.exec(text)) !== null) {
    const attrStr = match[1];
    const body = match[2].trim();
    const attrs: Record<string, string> = {};
    const attrRe = /([\w-]+)="([^"]*)"/g;
    let am;
    while ((am = attrRe.exec(attrStr)) !== null) {
      attrs[am[1]] = am[2];
    }
    cards.push({
      type: attrs.type || 'iframe',
      pluginId: attrs.plugin || '',
      route: attrs.route || '',
      title: attrs.title || undefined,
      description: body,
    });
  }

  const stripRe = /<card(?:\s+[\w-]+="[^"]*")*\s*>[\s\S]*?<\/card>/g;
  const remaining = text.replace(stripRe, '').replace(/^\n+/, '').trim();
  return { cards, text: remaining };
}
