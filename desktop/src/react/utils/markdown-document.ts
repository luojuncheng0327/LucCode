import { load as loadYaml } from 'js-yaml';

export interface MarkdownFrontMatter {
  raw: string;
  body: string;
  attributes: Record<string, unknown>;
  error?: string;
}

export interface MarkdownHeading {
  id: string;
  level: number;
  text: string;
  line: number;
  offset: number;
}

export interface MarkdownDocumentLink {
  kind: 'markdown' | 'image' | 'wiki';
  raw: string;
  href: string;
  label: string;
  line: number;
}

const FRONT_MATTER_RE = /^---(\r?\n)([\s\S]*?)(?:\r?\n)(?:---|\.\.\.)(?:\r?\n|$)/;
const FENCE_RE = /^\s*(```+|~~~+)/;
const ATX_HEADING_RE = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;
const SETEXT_HEADING_RE = /^[ \t]*(=+|-+)[ \t]*$/;

export function splitMarkdownFrontMatter(markdown: string): { raw: string; body: string } {
  const match = markdown.match(FRONT_MATTER_RE);
  if (!match) return { raw: '', body: markdown };
  return {
    raw: match[2] || '',
    body: markdown.slice(match[0].length),
  };
}

export function findMarkdownFrontMatterRange(markdown: string): { from: number; to: number } | null {
  const match = markdown.match(FRONT_MATTER_RE);
  return match ? { from: 0, to: match[0].length } : null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function parseMarkdownFrontMatter(markdown: string): MarkdownFrontMatter | null {
  const parts = splitMarkdownFrontMatter(markdown);
  if (!parts.raw) return null;
  try {
    const parsed = loadYaml(parts.raw);
    return {
      raw: parts.raw,
      body: parts.body,
      attributes: isPlainRecord(parsed) ? parsed : {},
    };
  } catch (err) {
    return {
      raw: parts.raw,
      body: parts.body,
      attributes: {},
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function formatMarkdownPropertyValue(value: unknown): string {
  if (value == null) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (Array.isArray(value)) return value.map(formatMarkdownPropertyValue).filter(Boolean).join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export function hashMarkdownContent(markdown: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < markdown.length; i += 1) {
    hash ^= markdown.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

function cleanHeadingText(raw: string): string {
  return raw
    .replace(/\\([\\`*_[\]{}()#+\-.!|>])/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .trim();
}

export function slugifyMarkdownHeading(text: string): string {
  const slug = text
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{Letter}\p{Number}\s_-]/gu, '')
    .trim()
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'section';
}

export function uniqueMarkdownHeadingId(text: string, seen: Map<string, number>): string {
  const base = slugifyMarkdownHeading(text);
  const count = seen.get(base) ?? 0;
  seen.set(base, count + 1);
  return count === 0 ? base : `${base}-${count}`;
}

function lineStartOffsets(lines: string[]): number[] {
  const offsets: number[] = [];
  let cursor = 0;
  for (const line of lines) {
    offsets.push(cursor);
    cursor += line.length + 1;
  }
  return offsets;
}

function frontMatterEndLine(lines: string[]): number | null {
  if (!/^---\s*$/.test(lines[0] || '')) return null;
  for (let index = 1; index < lines.length; index += 1) {
    if (/^(---|\.\.\.)\s*$/.test(lines[index])) return index;
  }
  return null;
}

export function extractMarkdownHeadings(markdown: string, maxLevel = 3): MarkdownHeading[] {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const offsets = lineStartOffsets(lines);
  const frontMatterEnd = frontMatterEndLine(lines);
  const seen = new Map<string, number>();
  const headings: MarkdownHeading[] = [];
  let inFence = false;
  let previousTextLine: { text: string; line: number } | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (frontMatterEnd != null && index <= frontMatterEnd) {
      previousTextLine = null;
      continue;
    }
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      previousTextLine = null;
      continue;
    }
    if (inFence) continue;

    const atx = ATX_HEADING_RE.exec(line);
    if (atx) {
      const level = atx[1].length;
      const text = cleanHeadingText(atx[2]);
      if (level <= maxLevel && text) {
        headings.push({
          id: uniqueMarkdownHeadingId(text, seen),
          level,
          text,
          line: index,
          offset: offsets[index] ?? 0,
        });
      }
      previousTextLine = null;
      continue;
    }

    const setext = SETEXT_HEADING_RE.exec(line);
    if (setext && previousTextLine?.text.trim()) {
      const level = setext[1].startsWith('=') ? 1 : 2;
      const text = cleanHeadingText(previousTextLine.text);
      if (level <= maxLevel && text) {
        headings.push({
          id: uniqueMarkdownHeadingId(text, seen),
          level,
          text,
          line: previousTextLine.line,
          offset: offsets[previousTextLine.line] ?? 0,
        });
      }
      previousTextLine = null;
      continue;
    }

    previousTextLine = line.trim() ? { text: line, line: index } : null;
  }

  return headings;
}

export function findCurrentHeading(headings: MarkdownHeading[], line: number): MarkdownHeading | null {
  let current: MarkdownHeading | null = null;
  for (const heading of headings) {
    if (heading.line > line) break;
    current = heading;
  }
  return current;
}

export function extractMarkdownLinks(markdown: string): MarkdownDocumentLink[] {
  const links: MarkdownDocumentLink[] = [];
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  let inFence = false;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const markdownLinkRe = /(!)?\[([^\]\n]+)\]\(([^)\n]+)\)/g;
    let match: RegExpExecArray | null;
    while ((match = markdownLinkRe.exec(line))) {
      links.push({
        kind: match[1] ? 'image' : 'markdown',
        raw: match[0],
        href: match[3].trim(),
        label: match[2].trim(),
        line: lineIndex,
      });
    }

    const wikiLinkRe = /\[\[([^\]\n|]+)(?:\|([^\]\n]+))?\]\]/g;
    while ((match = wikiLinkRe.exec(line))) {
      const target = match[1].trim();
      links.push({
        kind: 'wiki',
        raw: match[0],
        href: target,
        label: (match[2] || target).trim(),
        line: lineIndex,
      });
    }
  }

  return links;
}
