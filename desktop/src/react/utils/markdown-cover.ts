export interface MarkdownCover {
  image: string;
  actualRatio?: string;
  pixelWidth?: number;
  pixelHeight?: number;
  displayWidth?: number;
  displayHeight?: number;
  positionX?: number;
  positionY?: number;
}

export interface MarkdownCoverLayoutPatch {
  displayWidth?: number;
  displayHeight?: number;
  positionX?: number;
  positionY?: number;
}

interface FrontMatterParts {
  hasFrontMatter: boolean;
  frontMatter: string;
  body: string;
  newline: '\n' | '\r\n';
}

const FRONT_MATTER_RE = /^---(\r?\n)([\s\S]*?)(?:\r?\n)---(?:\r?\n|$)/;
const EXPLICIT_PROTOCOL_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const DEPRECATED_COVER_FIELDS = new Set(['prompt', 'promptPreset', 'preferredRatio', 'generatedAt', 'generator']);

function splitFrontMatter(markdown: string): FrontMatterParts {
  const match = markdown.match(FRONT_MATTER_RE);
  if (!match) {
    return { hasFrontMatter: false, frontMatter: '', body: markdown, newline: '\n' };
  }
  const full = match[0];
  const newline = match[1] === '\r\n' ? '\r\n' : '\n';
  return {
    hasFrontMatter: true,
    frontMatter: match[2] || '',
    body: markdown.slice(full.length),
    newline,
  };
}

function unquoteScalar(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseScalar(value: string): string | number | undefined {
  const raw = unquoteScalar(value);
  if (!raw) return undefined;
  if (/^-?\d+(?:\.\d+)?$/.test(raw)) {
    const num = Number(raw);
    if (Number.isFinite(num)) return num;
  }
  return raw;
}

function coverBlockRange(lines: string[]): { start: number; end: number } | null {
  const start = lines.findIndex(line => /^cover:\s*$/.test(line));
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end];
    if (line.trim() && !/^\s/.test(line)) break;
    end += 1;
  }
  return { start, end };
}

function frontMatterLines(frontMatter: string): string[] {
  return frontMatter.trim() ? frontMatter.split(/\r?\n/) : [];
}

function frontMatterLineRanges(frontMatter: string, baseOffset: number): Array<{ text: string; from: number; to: number }> {
  const ranges: Array<{ text: string; from: number; to: number }> = [];
  const re = /(.*?)(\r?\n|$)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(frontMatter))) {
    if (match[0] === '') break;
    ranges.push({
      text: match[1],
      from: baseOffset + match.index,
      to: baseOffset + match.index + match[0].length,
    });
  }
  return ranges;
}

function extractCoverBlockLines(markdown: string): string[] | null {
  const parts = splitFrontMatter(markdown);
  if (!parts.hasFrontMatter) return null;
  const lines = frontMatterLines(parts.frontMatter);
  const range = coverBlockRange(lines);
  if (!range) return null;
  return lines.slice(range.start, range.end);
}

export function findMarkdownCoverRenderRange(markdown: string): { from: number; to: number } | null {
  if (!parseMarkdownCover(markdown)) return null;
  const match = markdown.match(FRONT_MATTER_RE);
  if (!match) return null;

  const openingLength = 3 + match[1].length;
  const frontMatter = match[2] || '';
  const lines = frontMatterLines(frontMatter);
  const range = coverBlockRange(lines);
  if (!range) return null;

  const hasOtherFrontMatter = lines.some((line, index) => (
    (index < range.start || index >= range.end) && !!line.trim()
  ));
  if (!hasOtherFrontMatter) {
    return { from: 0, to: match[0].length };
  }

  const lineRanges = frontMatterLineRanges(frontMatter, openingLength);
  const first = lineRanges[range.start];
  const last = lineRanges[range.end - 1];
  if (!first || !last) return null;
  return { from: first.from, to: last.to };
}

export function parseMarkdownCover(markdown: string): MarkdownCover | null {
  const parts = splitFrontMatter(markdown);
  if (!parts.hasFrontMatter) return null;
  const lines = parts.frontMatter.split(/\r?\n/);
  const range = coverBlockRange(lines);
  if (!range) return null;

  const rawCover: Record<string, string | number | undefined> = {};
  for (const line of lines.slice(range.start + 1, range.end)) {
    const match = line.match(/^\s{2}([A-Za-z][A-Za-z0-9_]*):\s*(.*?)\s*$/);
    if (!match) continue;
    rawCover[match[1]] = parseScalar(match[2]);
  }

  if (typeof rawCover.image !== 'string' || !rawCover.image.trim()) return null;
  const cover: MarkdownCover = { image: rawCover.image.trim() };
  for (const key of ['actualRatio'] as const) {
    if (typeof rawCover[key] === 'string') cover[key] = rawCover[key];
  }
  for (const key of ['pixelWidth', 'pixelHeight', 'displayWidth', 'displayHeight', 'positionX', 'positionY'] as const) {
    if (typeof rawCover[key] === 'number' && Number.isFinite(rawCover[key])) cover[key] = rawCover[key];
  }
  return cover;
}

export function stripMarkdownFrontMatterForPreview(markdown: string): string {
  return splitFrontMatter(markdown).body;
}

function scalarLine(key: string, value: number): string {
  return `  ${key}: ${Math.round(value)}`;
}

function stripDeprecatedCoverFields(lines: string[], range: { start: number; end: number }): void {
  const cleaned: string[] = [];
  let index = range.start + 1;
  while (index < range.end) {
    const line = lines[index];
    const match = line.match(/^\s{2}([A-Za-z][A-Za-z0-9_]*):/);
    if (match && DEPRECATED_COVER_FIELDS.has(match[1])) {
      index += 1;
      while (index < range.end && /^\s{4,}/.test(lines[index])) index += 1;
      continue;
    }
    cleaned.push(line);
    index += 1;
  }

  lines.splice(range.start + 1, range.end - range.start - 1, ...cleaned);
  range.end = range.start + 1 + cleaned.length;
}

export function updateMarkdownCoverLayout(markdown: string, patch: MarkdownCoverLayoutPatch): string {
  const parts = splitFrontMatter(markdown);
  if (!parts.hasFrontMatter) return markdown;

  const lines = parts.frontMatter.split(/\r?\n/);
  let range = coverBlockRange(lines);
  if (!range) {
    lines.push('cover:');
    range = { start: lines.length - 1, end: lines.length };
  }

  const nextLines = [...lines];
  stripDeprecatedCoverFields(nextLines, range);
  const updates: Array<[keyof MarkdownCoverLayoutPatch, number]> = [];
  for (const key of ['displayWidth', 'displayHeight', 'positionX', 'positionY'] as const) {
    const value = patch[key];
    if (typeof value === 'number' && Number.isFinite(value)) updates.push([key, value]);
  }

  let insertAt = range.end;
  for (const [key, value] of updates) {
    const existing = nextLines.findIndex((line, index) => (
      index > range!.start
      && index < range!.end
      && new RegExp(`^\\s{2}${key}:`).test(line)
    ));
    if (existing >= 0) {
      nextLines[existing] = scalarLine(key, value);
    } else {
      nextLines.splice(insertAt, 0, scalarLine(key, value));
      insertAt += 1;
      range.end += 1;
    }
  }

  return `---${parts.newline}${nextLines.join(parts.newline)}${parts.newline}---${parts.newline}${parts.body}`;
}

export function removeMarkdownCover(markdown: string): string {
  const parts = splitFrontMatter(markdown);
  if (!parts.hasFrontMatter) return markdown;

  const lines = frontMatterLines(parts.frontMatter);
  const range = coverBlockRange(lines);
  if (!range) return markdown;

  const nextLines = [...lines];
  nextLines.splice(range.start, range.end - range.start);
  if (!nextLines.some(line => line.trim())) return parts.body;

  return `---${parts.newline}${nextLines.join(parts.newline)}${parts.newline}---${parts.newline}${parts.body}`;
}

export function isMarkdownCoverOnlyUpdate(previousMarkdown: string, nextMarkdown: string): boolean {
  const nextCover = parseMarkdownCover(nextMarkdown);
  if (!nextCover) return false;
  return stripMarkdownFrontMatterForPreview(previousMarkdown) === stripMarkdownFrontMatterForPreview(nextMarkdown);
}

export function mergeMarkdownCoverIntoDocument(targetMarkdown: string, sourceMarkdown: string): string | null {
  const coverLines = extractCoverBlockLines(sourceMarkdown);
  if (!coverLines) return null;

  const targetParts = splitFrontMatter(targetMarkdown);
  if (!targetParts.hasFrontMatter) {
    return `---${targetParts.newline}${coverLines.join(targetParts.newline)}${targetParts.newline}---${targetParts.newline}${targetParts.body}`;
  }

  const lines = frontMatterLines(targetParts.frontMatter);
  const existingRange = coverBlockRange(lines);
  const nextLines = [...lines];
  if (existingRange) {
    nextLines.splice(existingRange.start, existingRange.end - existingRange.start, ...coverLines);
  } else {
    nextLines.push(...coverLines);
  }
  return `---${targetParts.newline}${nextLines.join(targetParts.newline)}${targetParts.newline}---${targetParts.newline}${targetParts.body}`;
}

function normalizePathSegments(pathname: string): string {
  const normalized = pathname.replace(/\\/g, '/');
  const prefixMatch = normalized.match(/^(?:[A-Za-z]:|\/\/[^/]+\/[^/]+|\/)?/);
  const prefix = prefixMatch?.[0] || '';
  const rest = normalized.slice(prefix.length);
  const parts: string[] = [];
  for (const part of rest.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (parts.length > 0) parts.pop();
      continue;
    }
    parts.push(part);
  }
  if (!prefix) return parts.join('/');
  if (prefix.endsWith('/')) return `${prefix}${parts.join('/')}`;
  return parts.length ? `${prefix}/${parts.join('/')}` : prefix;
}

function dirnamePortable(filePath: string): string | null {
  const normalized = filePath.replace(/\\/g, '/');
  const slash = normalized.lastIndexOf('/');
  if (slash < 0) return null;
  if (slash === 0) return '/';
  return normalized.slice(0, slash);
}

function isAbsoluteLocalPath(value: string): boolean {
  return value.startsWith('/')
    || /^[A-Za-z]:[\\/]/.test(value)
    || value.startsWith('\\\\')
    || value.startsWith('//');
}

export function resolveMarkdownCoverImagePath(markdownFilePath: string | undefined, image: string): string | null {
  const trimmed = image.trim();
  if (!trimmed) return null;
  if (EXPLICIT_PROTOCOL_RE.test(trimmed)) return trimmed;
  if (isAbsoluteLocalPath(trimmed)) return normalizePathSegments(trimmed);
  if (!markdownFilePath) return trimmed;
  const baseDir = dirnamePortable(markdownFilePath);
  if (!baseDir) return trimmed;
  return normalizePathSegments(`${baseDir}/${trimmed}`);
}
