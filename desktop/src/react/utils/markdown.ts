/**
 * Markdown 渲染器
 *
 * 通过 npm import 使用 markdown-it，不依赖全局 window.markdownit。
 */

import markdownit from 'markdown-it';
import type StateCore from 'markdown-it/lib/rules_core/state_core.mjs';
import type StateBlock from 'markdown-it/lib/rules_block/state_block.mjs';
import type StateInline from 'markdown-it/lib/rules_inline/state_inline.mjs';
import type Token from 'markdown-it/lib/token.mjs';
import mk from '@traptitech/markdown-it-katex';
import taskLists from 'markdown-it-task-lists';
import 'katex/dist/katex.min.css';
import { sanitizeMarkdownPreviewHtml } from './markdown-html-sanitizer';
import { EXT_TO_KIND, extOfName, isImageOrSvgExt } from './file-kind';
import { uniqueMarkdownHeadingId } from './markdown-document';

type MarkdownItInstance = ReturnType<typeof markdownit>;
type MarkdownRenderEnv = {
  markdownImage?: MarkdownImageContext;
  footnoteIdPrefix?: string;
  footnotes?: FootnoteState;
};

export interface MarkdownPreviewOptions {
  filePath?: string | null;
  getFileUrl?: ((filePath: string) => string | undefined) | null;
}

export interface MarkdownImageContext {
  filePath?: string | null;
  getFileUrl?: ((filePath: string) => string | undefined) | null;
}

export interface ImageDimensions {
  width?: string;
  height?: string;
}

export interface ImageLabel {
  alt: string;
  dimensions: ImageDimensions | null;
}

export interface ParsedMarkdownImage {
  src: string;
  alt: string;
  dimensions: ImageDimensions | null;
}

interface FootnoteDefinition {
  label: string;
  content: string;
}

interface FootnoteReference {
  label: string;
  number: number;
  footnoteId: string;
  refIds: string[];
}

interface FootnoteState {
  prefix: string;
  definitions: Map<string, FootnoteDefinition>;
  references: FootnoteReference[];
  referenceByLabel: Map<string, FootnoteReference>;
  renderingDefinitions: boolean;
}

let _md: MarkdownItInstance | null = null;
let _previewMd: MarkdownItInstance | null = null;

const HEX_COLOR_RE = /^#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?(?:[0-9a-fA-F]{2})?$/;
const RGB_COLOR_RE = /^rgba?\(\s*(?:\d{1,3}\s*,\s*){2}\d{1,3}(?:\s*,\s*(?:0|1|0?\.\d+))?\s*\)$/i;
const BG_SPAN_RE = /^<span\s+style=(["'])\s*background(?:-color)?\s*:\s*([^;"']+)\s*;?\s*\1>([\s\S]*?)<\/span>/i;
const INLINE_MATH_OPEN = '\\(';
const INLINE_MATH_CLOSE = '\\)';
const BLOCK_MATH_OPEN = '\\[';
const BLOCK_MATH_CLOSE = '\\]';
const CALLOUT_MARKER_RE = /^\s*\[!([A-Za-z][A-Za-z0-9_-]*)\]([+-])?(?:[ \t]+(.+?))?\s*$/;
const ABSOLUTE_WINDOWS_PATH_RE = /^[A-Za-z]:[\\/]/;
const EXPLICIT_PROTOCOL_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const SAFE_IMAGE_URL_PROTOCOLS = new Set(['http:', 'https:', 'file:']);
const IMAGE_SIZE_RE = /^([1-9]\d{0,4})(?:x([1-9]\d{0,4}))?$/i;
const FOOTNOTE_DEF_MARKER_RE = /^\[\^([^\]\n]+)\]:[ \t]*/;
const AUTO_LINK_SUFFIX_BOUNDARY_CHARS = new Set([
  '\u200b', '\u200c', '\u200d', '\ufeff',
  '。', '、', '，', '；', '：', '！', '？',
  '）', '】', '］', '｝', '》', '〉', '」', '』', '〕', '〗',
]);

function hashStringBase36(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

function footnoteIdPrefixForSource(src: string): string {
  return `luc-fn-${hashStringBase36(src)}`;
}

function normalizeFootnoteLabel(label: string): string {
  return label.trim().replace(/\s+/g, ' ').toLowerCase();
}

function ensureFootnoteState(env: MarkdownRenderEnv, src: string): FootnoteState {
  if (!env.footnotes) {
    env.footnotes = {
      prefix: env.footnoteIdPrefix || footnoteIdPrefixForSource(src),
      definitions: new Map(),
      references: [],
      referenceByLabel: new Map(),
      renderingDefinitions: false,
    };
  }
  return env.footnotes;
}

const CALLOUT_ALIASES: Record<string, string> = {
  note: 'note',
  abstract: 'abstract',
  summary: 'abstract',
  tldr: 'abstract',
  info: 'info',
  todo: 'todo',
  tip: 'tip',
  hint: 'tip',
  important: 'tip',
  success: 'success',
  check: 'success',
  done: 'success',
  question: 'question',
  help: 'question',
  faq: 'question',
  warning: 'warning',
  caution: 'warning',
  attention: 'warning',
  failure: 'failure',
  fail: 'failure',
  missing: 'failure',
  danger: 'danger',
  error: 'danger',
  bug: 'bug',
  example: 'example',
  quote: 'quote',
  cite: 'quote',
};

function normalizePathSeparators(value: string): string {
  return value.replace(/\\/g, '/');
}

function dirnamePortable(filePath: string): string | null {
  const normalized = normalizePathSeparators(filePath);
  const slash = normalized.lastIndexOf('/');
  if (slash < 0) return null;
  if (slash === 0) return '/';
  return normalized.slice(0, slash);
}

function isAbsoluteLocalPath(value: string): boolean {
  return value.startsWith('/') || ABSOLUTE_WINDOWS_PATH_RE.test(value) || value.startsWith('\\\\') || value.startsWith('//');
}

function normalizeJoinedPath(pathname: string): string {
  const normalized = normalizePathSeparators(pathname);
  const prefixMatch = normalized.match(/^(?:[A-Za-z]:|\/\/[^/]+\/[^/]+|\/)?/);
  const prefix = prefixMatch?.[0] ?? '';
  const rest = normalized.slice(prefix.length);
  const parts: string[] = [];

  for (const part of rest.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (parts.length > 0 && parts[parts.length - 1] !== '..') {
        parts.pop();
      } else if (!prefix) {
        parts.push(part);
      }
      continue;
    }
    parts.push(part);
  }

  if (!prefix) return parts.join('/');
  if (prefix.endsWith('/')) return `${prefix}${parts.join('/')}`;
  return parts.length ? `${prefix}/${parts.join('/')}` : prefix;
}

function decodeMarkdownPath(rawPath: string): string {
  try {
    return decodeURI(rawPath);
  } catch {
    return rawPath;
  }
}

function splitResourceSuffix(raw: string): { pathname: string; suffix: string } {
  const hash = raw.indexOf('#');
  const query = raw.indexOf('?');
  const indexes = [hash, query].filter(index => index >= 0);
  const splitAt = indexes.length ? Math.min(...indexes) : -1;
  if (splitAt < 0) return { pathname: raw, suffix: '' };
  return {
    pathname: raw.slice(0, splitAt),
    suffix: raw.slice(splitAt),
  };
}

function sanitizeImageUrl(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  if (!EXPLICIT_PROTOCOL_RE.test(value)) return null;

  try {
    const parsed = new URL(value);
    return SAFE_IMAGE_URL_PROTOCOLS.has(parsed.protocol) ? value : null;
  } catch {
    return null;
  }
}

function resolveLocalImagePath(rawPath: string, currentFilePath: string): string | null {
  const decodedPath = decodeMarkdownPath(rawPath.trim());
  if (!decodedPath) return null;
  if (isAbsoluteLocalPath(decodedPath)) return normalizeJoinedPath(decodedPath);

  const baseDir = dirnamePortable(currentFilePath);
  if (!baseDir) return null;
  return normalizeJoinedPath(`${baseDir}/${decodedPath}`);
}

export function resolveMarkdownImageSrc(src: string, context: MarkdownImageContext | undefined): string {
  const trimmed = src.trim();
  if (!trimmed) return src;

  const safeUrl = sanitizeImageUrl(trimmed);
  if (safeUrl) return safeUrl;
  if (EXPLICIT_PROTOCOL_RE.test(trimmed)) return trimmed;

  if (!context?.filePath || typeof context.getFileUrl !== 'function') return src;

  const { pathname, suffix } = splitResourceSuffix(trimmed);
  const resolvedPath = resolveLocalImagePath(pathname, context.filePath);
  if (!resolvedPath) return src;

  const fileUrl = context.getFileUrl(resolvedPath);
  return fileUrl ? `${fileUrl}${suffix}` : src;
}

export function parseImageDimensions(raw: string): ImageDimensions | null {
  const match = IMAGE_SIZE_RE.exec(raw.trim());
  if (!match) return null;
  return {
    width: match[1],
    ...(match[2] ? { height: match[2] } : {}),
  };
}

function splitUnescapedPipe(value: string): [string, string] | null {
  for (let i = value.length - 1; i >= 0; i -= 1) {
    if (value[i] === '|' && !isEscaped(value, i)) {
      return [value.slice(0, i), value.slice(i + 1)];
    }
  }
  return null;
}

export function parseImageLabel(raw: string): ImageLabel {
  const trimmed = raw.trim();
  const pureSize = parseImageDimensions(trimmed);
  if (pureSize) return { alt: '', dimensions: pureSize };

  const split = splitUnescapedPipe(raw);
  if (!split) return { alt: raw, dimensions: null };

  const [alt, maybeSize] = split;
  const dimensions = parseImageDimensions(maybeSize);
  if (!dimensions) return { alt: raw, dimensions: null };
  return { alt: alt.trim(), dimensions };
}

function basenamePortable(value: string): string {
  const normalized = normalizePathSeparators(value);
  const slash = normalized.lastIndexOf('/');
  return slash >= 0 ? normalized.slice(slash + 1) : normalized;
}

function splitObsidianEmbedTarget(raw: string): { target: string; label: string | null } {
  const split = splitUnescapedPipe(raw);
  if (!split) return { target: raw.trim(), label: null };
  return { target: split[0].trim(), label: split[1].trim() };
}

function stripObsidianFragment(raw: string): string {
  const hash = raw.indexOf('#');
  return (hash >= 0 ? raw.slice(0, hash) : raw).trim();
}

function isImageEmbedTarget(target: string): boolean {
  const pathname = splitResourceSuffix(stripObsidianFragment(target)).pathname;
  const ext = extOfName(pathname);
  return isImageOrSvgExt(ext);
}

export function parseObsidianImageEmbed(rawInner: string): ParsedMarkdownImage | null {
  const { target, label } = splitObsidianEmbedTarget(rawInner);
  const imageTarget = stripObsidianFragment(target);
  if (!imageTarget || !isImageEmbedTarget(imageTarget)) return null;

  const dimensions = label ? parseImageDimensions(label) : null;
  return {
    src: imageTarget,
    alt: dimensions ? basenamePortable(imageTarget) : (label || basenamePortable(imageTarget)),
    dimensions,
  };
}

function obsidianImageEmbeds(md: MarkdownItInstance): void {
  md.inline.ruler.before('image', 'obsidian_image_embed', (state: StateInline, silent: boolean) => {
    const start = state.pos;
    if (state.src.slice(start, start + 3) !== '![[') return false;

    const close = findUnescapedDelimiter(state.src, ']]', start + 3, state.posMax);
    if (close < 0) return false;

    const parsed = parseObsidianImageEmbed(state.src.slice(start + 3, close));
    if (!parsed) return false;

    if (!silent) {
      const token = state.push('image', 'img', 0);
      token.attrs = [['src', parsed.src]];
      token.content = parsed.alt;
      if (parsed.dimensions?.width) token.attrSet('width', parsed.dimensions.width);
      if (parsed.dimensions?.height) token.attrSet('height', parsed.dimensions.height);
      token.markup = '![[]]';
    }

    state.pos = close + 2;
    return true;
  });
}

function normalizeCalloutType(type: string): string {
  return CALLOUT_ALIASES[type.toLowerCase()] || 'note';
}

function titleCaseCalloutType(type: string): string {
  return type
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, char => char.toUpperCase());
}

function findMatchingBlockquoteClose(tokens: Token[], openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < tokens.length; i += 1) {
    if (tokens[i].type === 'blockquote_open') depth += 1;
    if (tokens[i].type === 'blockquote_close') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function findFirstDirectParagraph(tokens: Token[], openIndex: number, closeIndex: number): number {
  const parentLevel = tokens[openIndex].level;
  for (let i = openIndex + 1; i < closeIndex; i += 1) {
    const token = tokens[i];
    if (token.level !== parentLevel + 1) continue;
    if (token.type === 'paragraph_open') return i;
    if (!token.hidden) return -1;
  }
  return -1;
}

function makeCalloutTitleTokens(state: StateCore, title: string, foldable: boolean, level: number): Token[] {
  const open = new state.Token(
    foldable ? 'callout_summary_open' : 'callout_title_open',
    foldable ? 'summary' : 'div',
    1,
  );
  open.attrSet('class', 'markdown-callout-title');
  open.level = level;

  const inline = new state.Token('inline', '', 0);
  inline.content = title;
  inline.children = [];
  inline.level = level + 1;

  const close = new state.Token(
    foldable ? 'callout_summary_close' : 'callout_title_close',
    foldable ? 'summary' : 'div',
    -1,
  );
  close.level = level;

  return [open, inline, close];
}

function obsidianCallouts(md: MarkdownItInstance): void {
  md.core.ruler.after('block', 'obsidian_callouts', (state: StateCore) => {
    const tokens = state.tokens;

    for (let i = 0; i < tokens.length; i += 1) {
      const open = tokens[i];
      if (open.type !== 'blockquote_open') continue;

      const closeIndex = findMatchingBlockquoteClose(tokens, i);
      if (closeIndex < 0) continue;

      const paragraphIndex = findFirstDirectParagraph(tokens, i, closeIndex);
      const inlineIndex = paragraphIndex + 1;
      if (
        paragraphIndex < 0 ||
        tokens[paragraphIndex]?.type !== 'paragraph_open' ||
        tokens[inlineIndex]?.type !== 'inline' ||
        tokens[paragraphIndex + 2]?.type !== 'paragraph_close'
      ) {
        continue;
      }

      const inline = tokens[inlineIndex];
      const lineEnd = inline.content.indexOf('\n');
      const firstLine = lineEnd >= 0 ? inline.content.slice(0, lineEnd) : inline.content;
      const match = CALLOUT_MARKER_RE.exec(firstLine);
      if (!match) continue;

      const sourceType = match[1];
      const canonicalType = normalizeCalloutType(sourceType);
      const foldMarker = match[2] || '';
      const foldable = foldMarker === '+' || foldMarker === '-';
      const title = (match[3]?.trim() || titleCaseCalloutType(sourceType));

      open.tag = foldable ? 'details' : 'div';
      open.attrSet('class', `markdown-callout markdown-callout-${canonicalType}`);
      if (foldable && foldMarker === '+') open.attrSet('open', 'open');

      const close = tokens[closeIndex];
      close.tag = foldable ? 'details' : 'div';

      tokens.splice(i + 1, 0, ...makeCalloutTitleTokens(state, title, foldable, open.level + 1));

      if (lineEnd >= 0) {
        inline.content = inline.content.slice(lineEnd + 1);
      } else {
        tokens.splice(paragraphIndex + 3, 3);
      }
    }
  });
}

function splitAutoLinkSuffix(text: string): { linkText: string; suffix: string } | null {
  for (let index = 0; index < text.length; index += 1) {
    if (!AUTO_LINK_SUFFIX_BOUNDARY_CHARS.has(text[index])) continue;
    return {
      linkText: text.slice(0, index),
      suffix: text.slice(index),
    };
  }
  return null;
}

function stripHrefSuffix(href: string, suffix: string): string {
  for (const candidate of [encodeURI(suffix), encodeURIComponent(suffix), suffix]) {
    if (!candidate) continue;
    if (href.toLowerCase().endsWith(candidate.toLowerCase())) {
      return href.slice(0, href.length - candidate.length);
    }
  }
  return href;
}

function isAutoLinkifyToken(token: Token | undefined, type: 'link_open' | 'link_close'): boolean {
  return token?.type === type && token.markup === 'linkify' && token.info === 'auto';
}

const WINDOWS_ABSOLUTE_PATH_RE = /^[A-Za-z]:[\\/]/;
const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;

function isKnownLocalFileExtension(text: string): boolean {
  const ext = extOfName(text);
  return Boolean(ext && EXT_TO_KIND[ext]);
}

function isLikelyLocalFileAutolink(text: string): boolean {
  const value = text.trim();
  if (!value) return false;
  if (value.includes('@')) return false;
  if (SCHEME_RE.test(value) && !WINDOWS_ABSOLUTE_PATH_RE.test(value)) return false;
  return isKnownLocalFileExtension(value);
}

function trimAutoLinkifiedSuffixes(md: MarkdownItInstance): void {
  md.core.ruler.after('linkify', 'trim_auto_linkified_suffixes', (state: StateCore) => {
    for (const blockToken of state.tokens) {
      const children = blockToken.children;
      if (!children?.length) continue;

      for (let index = 0; index < children.length - 2; index += 1) {
        const open = children[index];
        const text = children[index + 1];
        const close = children[index + 2];
        if (!isAutoLinkifyToken(open, 'link_open') || text?.type !== 'text' || !isAutoLinkifyToken(close, 'link_close')) {
          continue;
        }

        const split = splitAutoLinkSuffix(text.content);
        if (!split || !split.linkText) continue;

        text.content = split.linkText;
        const href = open.attrGet('href');
        if (href) open.attrSet('href', stripHrefSuffix(href, split.suffix));

        const next = children[index + 3];
        if (next?.type === 'text') {
          next.content = `${split.suffix}${next.content}`;
        } else {
          const suffixToken = new state.Token('text', '', 0);
          suffixToken.content = split.suffix;
          children.splice(index + 3, 0, suffixToken);
        }
        index += 2;
      }
    }
  });
}

function unwrapLocalFileAutoLinks(md: MarkdownItInstance): void {
  md.core.ruler.after('trim_auto_linkified_suffixes', 'unwrap_local_file_auto_links', (state: StateCore) => {
    for (const blockToken of state.tokens) {
      const children = blockToken.children;
      if (!children?.length) continue;

      for (let index = 0; index < children.length - 2; index += 1) {
        const open = children[index];
        const text = children[index + 1];
        const close = children[index + 2];
        if (!isAutoLinkifyToken(open, 'link_open') || text?.type !== 'text' || !isAutoLinkifyToken(close, 'link_close')) {
          continue;
        }
        if (!isLikelyLocalFileAutolink(text.content)) continue;

        children.splice(index, 3, text);
      }
    }
  });
}

function normalizeSafeBackgroundColor(raw: string): string | null {
  const color = raw.trim();
  if (HEX_COLOR_RE.test(color)) return color;
  if (RGB_COLOR_RE.test(color)) return color;
  return null;
}

function tokenizeInner(state: StateInline, from: number, to: number): void {
  const oldPos = state.pos;
  const oldMax = state.posMax;
  state.pos = from;
  state.posMax = to;
  state.md.inline.tokenize(state);
  state.pos = oldPos;
  state.posMax = oldMax;
}

function obsidianHighlights(md: MarkdownItInstance): void {
  md.inline.ruler.before('emphasis', 'obsidian_mark', (state, silent) => {
    const start = state.pos;
    if (state.src.slice(start, start + 2) !== '==') return false;
    const end = state.src.indexOf('==', start + 2);
    if (end < 0 || end === start + 2) return false;

    if (!silent) {
      state.push('mark_open', 'mark', 1);
      tokenizeInner(state, start + 2, end);
      state.push('mark_close', 'mark', -1);
    }
    state.pos = end + 2;
    return true;
  });

  md.inline.ruler.before('text', 'obsidian_background_span', (state, silent) => {
    const start = state.pos;
    if (state.src.charCodeAt(start) !== 0x3C) return false; // <
    const match = BG_SPAN_RE.exec(state.src.slice(start));
    if (!match) return false;
    const color = normalizeSafeBackgroundColor(match[2]);
    if (!color) return false;

    if (!silent) {
      const open = state.push('mark_open', 'mark', 1);
      open.attrSet('style', `background-color:${color}`);
      const innerStart = start + match[0].indexOf('>') + 1;
      const innerEnd = start + match[0].length - '</span>'.length;
      tokenizeInner(state, innerStart, innerEnd);
      state.push('mark_close', 'mark', -1);
    }
    state.pos = start + match[0].length;
    return true;
  });
}

function isEscaped(src: string, pos: number): boolean {
  let count = 0;
  for (let i = pos - 1; i >= 0 && src.charCodeAt(i) === 0x5C; i -= 1) {
    count += 1;
  }
  return count % 2 === 1;
}

function findUnescapedDelimiter(src: string, delimiter: string, from: number, to: number): number {
  let pos = src.indexOf(delimiter, from);
  while (pos >= 0 && pos < to) {
    if (!isEscaped(src, pos)) return pos;
    pos = src.indexOf(delimiter, pos + delimiter.length);
  }
  return -1;
}

function findLineEndingDelimiter(line: string, delimiter: string): number {
  let from = 0;
  while (from < line.length) {
    const pos = findUnescapedDelimiter(line, delimiter, from, line.length);
    if (pos < 0) return -1;
    if (line.slice(pos + delimiter.length).trim() === '') return pos;
    from = pos + delimiter.length;
  }
  return -1;
}

function firstNonSpaceLineContent(state: StateBlock, line: number): string {
  const start = state.bMarks[line] + state.tShift[line];
  const max = state.eMarks[line];
  return state.src.slice(start, max);
}

function isFootnoteContinuationLine(state: StateBlock, line: number): boolean {
  return state.sCount[line] - state.blkIndent >= 4;
}

function collectFootnoteDefinitionContent(
  state: StateBlock,
  startLine: number,
  firstLineContent: string,
): { content: string; nextLine: number } {
  const lines = [firstLineContent];
  let nextLine = startLine + 1;

  while (nextLine < state.lineMax) {
    if (state.isEmpty(nextLine)) {
      const followingLine = state.skipEmptyLines(nextLine);
      if (followingLine < state.lineMax && isFootnoteContinuationLine(state, followingLine)) {
        lines.push('');
        nextLine += 1;
        continue;
      }
      break;
    }

    if (!isFootnoteContinuationLine(state, nextLine)) break;

    lines.push(state.getLines(nextLine, nextLine + 1, state.blkIndent + 4, false).replace(/\n$/, ''));
    nextLine += 1;
  }

  return {
    content: lines.join('\n').trimEnd(),
    nextLine,
  };
}

function footnoteDefinitions(md: MarkdownItInstance): void {
  md.block.ruler.before('reference', 'luc_footnote_definitions', (
    state: StateBlock,
    startLine: number,
    _endLine: number,
    silent: boolean,
  ) => {
    if (state.sCount[startLine] - state.blkIndent >= 4) return false;

    const line = firstNonSpaceLineContent(state, startLine);
    const match = FOOTNOTE_DEF_MARKER_RE.exec(line);
    if (!match) return false;

    const label = normalizeFootnoteLabel(match[1]);
    if (!label) return false;
    if (silent) return true;

    const markdownEnv = state.env as MarkdownRenderEnv;
    const footnotes = ensureFootnoteState(markdownEnv, state.src);
    const { content, nextLine } = collectFootnoteDefinitionContent(
      state,
      startLine,
      line.slice(match[0].length),
    );

    if (!footnotes.definitions.has(label)) {
      footnotes.definitions.set(label, {
        label,
        content,
      });
    }

    state.line = nextLine;
    return true;
  }, {
    alt: ['paragraph', 'reference'],
  });
}

function recordFootnoteReference(footnotes: FootnoteState, label: string): {
  number: number;
  footnoteId: string;
  refId: string;
} {
  let reference = footnotes.referenceByLabel.get(label);
  if (!reference) {
    const number = footnotes.references.length + 1;
    reference = {
      label,
      number,
      footnoteId: `fn-${footnotes.prefix}-${number}`,
      refIds: [],
    };
    footnotes.referenceByLabel.set(label, reference);
    footnotes.references.push(reference);
  }

  const refNumber = reference.refIds.length + 1;
  const refId = refNumber === 1
    ? `fnref-${footnotes.prefix}-${reference.number}`
    : `fnref-${footnotes.prefix}-${reference.number}-${refNumber}`;
  reference.refIds.push(refId);

  return {
    number: reference.number,
    footnoteId: reference.footnoteId,
    refId,
  };
}

function footnoteReferences(md: MarkdownItInstance): void {
  md.inline.ruler.before('link', 'luc_footnote_refs', (state: StateInline, silent: boolean) => {
    const start = state.pos;
    if (state.src.slice(start, start + 2) !== '[^') return false;

    const close = findUnescapedDelimiter(state.src, ']', start + 2, state.posMax);
    if (close < 0) return false;

    const label = normalizeFootnoteLabel(state.src.slice(start + 2, close));
    if (!label) return false;

    const markdownEnv = state.env as MarkdownRenderEnv;
    const footnotes = ensureFootnoteState(markdownEnv, state.src);
    if (footnotes.renderingDefinitions || !footnotes.definitions.has(label)) return false;
    if (silent) return true;

    const ref = recordFootnoteReference(footnotes, label);
    const token = state.push('footnote_ref', '', 0);
    token.meta = ref;
    state.pos = close + 1;
    return true;
  });
}

function textToken(state: StateCore, content: string): Token {
  const token = new state.Token('text', '', 0);
  token.content = content;
  return token;
}

function backrefToken(state: StateCore, refId: string, index: number): Token {
  const token = new state.Token('footnote_backref', '', 0);
  token.meta = {
    refId,
    index,
  };
  return token;
}

function appendFootnoteBackrefs(state: StateCore, inlineToken: Token, refIds: string[]): void {
  if (!inlineToken.children) inlineToken.children = [];
  if (inlineToken.children.length > 0) {
    inlineToken.children.push(textToken(state, ' '));
  }

  refIds.forEach((refId, index) => {
    if (index > 0) inlineToken.children?.push(textToken(state, ' '));
    inlineToken.children?.push(backrefToken(state, refId, index + 1));
  });
}

function appendFootnoteList(md: MarkdownItInstance): void {
  md.core.ruler.after('inline', 'luc_footnote_tail', (state: StateCore) => {
    const markdownEnv = state.env as MarkdownRenderEnv;
    const footnotes = markdownEnv.footnotes;
    if (!footnotes || footnotes.references.length === 0) return;

    const makeToken = (type: string, tag: string, nesting: -1 | 0 | 1, level: number): Token => {
      const token = new state.Token(type, tag, nesting);
      token.block = true;
      token.level = level;
      return token;
    };

    const sectionOpen = makeToken('footnote_block_open', 'section', 1, 0);
    sectionOpen.attrSet('class', 'footnotes');
    sectionOpen.attrSet('role', 'doc-endnotes');
    state.tokens.push(sectionOpen);

    state.tokens.push(makeToken('hr', 'hr', 0, 1));
    state.tokens.push(makeToken('ordered_list_open', 'ol', 1, 1));

    const references = footnotes.references.slice();
    for (const reference of references) {
      const definition = footnotes.definitions.get(reference.label);
      if (!definition) continue;

      const itemOpen = makeToken('list_item_open', 'li', 1, 2);
      itemOpen.attrSet('id', reference.footnoteId);
      state.tokens.push(itemOpen);

      const inline = makeToken('inline', '', 0, 3);
      inline.content = definition.content;
      inline.children = [];
      footnotes.renderingDefinitions = true;
      try {
        state.md.inline.parse(inline.content, state.md, state.env, inline.children);
      } finally {
        footnotes.renderingDefinitions = false;
      }
      appendFootnoteBackrefs(state, inline, reference.refIds);
      state.tokens.push(inline);

      state.tokens.push(makeToken('list_item_close', 'li', -1, 2));
    }

    state.tokens.push(makeToken('ordered_list_close', 'ol', -1, 1));
    state.tokens.push(makeToken('footnote_block_close', 'section', -1, 0));
  });
}

function footnoteRenderers(md: MarkdownItInstance): void {
  md.renderer.rules.footnote_ref = (tokens, idx) => {
    const meta = tokens[idx].meta as { number: number; footnoteId: string; refId: string };
    const footnoteId = md.utils.escapeHtml(meta.footnoteId);
    const refId = md.utils.escapeHtml(meta.refId);
    return `<sup class="footnote-ref"><a href="#${footnoteId}" id="${refId}" role="doc-noteref">${meta.number}</a></sup>`;
  };

  md.renderer.rules.footnote_backref = (tokens, idx) => {
    const meta = tokens[idx].meta as { refId: string; index: number };
    const refId = md.utils.escapeHtml(meta.refId);
    const label = meta.index > 1 ? `&#8617;${meta.index}` : '&#8617;';
    return `<a href="#${refId}" class="footnote-backref" role="doc-backlink" title="Jump back to reference">${label}</a>`;
  };
}

function footnotes(md: MarkdownItInstance): void {
  footnoteDefinitions(md);
  footnoteReferences(md);
  appendFootnoteList(md);
  footnoteRenderers(md);
}

function texBracketMath(md: MarkdownItInstance): void {
  md.inline.ruler.before('escape', 'tex_parenthesis_math', (state: StateInline, silent: boolean) => {
    const start = state.pos;
    if (state.src.slice(start, start + INLINE_MATH_OPEN.length) !== INLINE_MATH_OPEN) return false;

    const contentStart = start + INLINE_MATH_OPEN.length;
    const close = findUnescapedDelimiter(state.src, INLINE_MATH_CLOSE, contentStart, state.posMax);
    if (close < 0 || close === contentStart) return false;

    if (!silent) {
      const token = state.push('math_inline', 'math', 0);
      token.markup = INLINE_MATH_OPEN;
      token.content = state.src.slice(contentStart, close);
    }
    state.pos = close + INLINE_MATH_CLOSE.length;
    return true;
  });

  md.block.ruler.before('paragraph', 'tex_bracket_math_block', (
    state: StateBlock,
    startLine: number,
    endLine: number,
    silent: boolean,
  ) => {
    const start = state.bMarks[startLine] + state.tShift[startLine];
    const max = state.eMarks[startLine];
    if (start + BLOCK_MATH_OPEN.length > max) return false;
    if (state.src.slice(start, start + BLOCK_MATH_OPEN.length) !== BLOCK_MATH_OPEN) return false;

    let nextLine = startLine;
    const firstLine = state.src.slice(start + BLOCK_MATH_OPEN.length, max);
    const firstLineClose = findLineEndingDelimiter(firstLine, BLOCK_MATH_CLOSE);
    let content = '';

    if (firstLineClose >= 0) {
      content = firstLine.slice(0, firstLineClose);
    } else {
      let found = false;
      let lastLine = '';
      for (nextLine = startLine + 1; nextLine < endLine; nextLine += 1) {
        const lineStart = state.bMarks[nextLine] + state.tShift[nextLine];
        const lineMax = state.eMarks[nextLine];
        if (lineStart < lineMax && state.tShift[nextLine] < state.blkIndent) break;

        const line = state.src.slice(lineStart, lineMax);
        const close = findLineEndingDelimiter(line, BLOCK_MATH_CLOSE);
        if (close >= 0) {
          lastLine = line.slice(0, close);
          found = true;
          break;
        }
      }

      if (!found) return false;
      content = (firstLine.trim() ? `${firstLine}\n` : '')
        + state.getLines(startLine + 1, nextLine, state.tShift[startLine], true)
        + (lastLine.trim() ? lastLine : '');
    }

    if (!content.trim()) return false;
    if (silent) return true;

    state.line = nextLine + 1;
    const token = state.push('math_block', 'math', 0);
    token.block = true;
    token.content = content;
    token.map = [startLine, state.line];
    token.markup = `${BLOCK_MATH_OPEN}${BLOCK_MATH_CLOSE}`;
    return true;
  }, {
    alt: ['paragraph', 'reference', 'blockquote', 'list'],
  });
}

function applyMarkdownPlugins(md: MarkdownItInstance): void {
  md.use(mk, { throwOnError: false, strict: false });
  md.use(texBracketMath);
  md.use(taskLists, { enabled: false, label: true });
  md.use(obsidianImageEmbeds);
  md.use(obsidianHighlights);
  md.use(obsidianCallouts);
  md.use(footnotes);
  md.use(markdownHeadingAnchors);
  md.use(trimAutoLinkifiedSuffixes);
  md.use(unwrapLocalFileAutoLinks);
  md.use(mermaidFences);
  md.use(markdownImageRenderer);
  md.use(markdownTableScrollWrapper);
}

function markdownHeadingAnchors(md: MarkdownItInstance): void {
  md.core.ruler.push('luc_heading_anchors', (state: StateCore) => {
    const seen = new Map<string, number>();
    for (let i = 0; i < state.tokens.length; i += 1) {
      const token = state.tokens[i];
      if (token.type !== 'heading_open') continue;
      const inline = state.tokens[i + 1];
      if (!inline || inline.type !== 'inline') continue;
      const text = inline.content.trim();
      if (!text) continue;
      token.attrSet('id', uniqueMarkdownHeadingId(text, seen));
    }
  });
}

function fenceLanguage(info: string): string {
  return info.trim().split(/\s+/)[0]?.toLowerCase() || '';
}

function mermaidFences(md: MarkdownItInstance): void {
  const defaultFence = md.renderer.rules.fence
    ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));

  md.renderer.rules.fence = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    if (fenceLanguage(token.info) !== 'mermaid') {
      return defaultFence(tokens, idx, options, env, self);
    }

    const source = md.utils.escapeHtml(token.content);
    return [
      '<div class="mermaid-diagram">',
      `<pre class="mermaid-source"><code>${source}</code></pre>`,
      '<div class="mermaid-rendered"></div>',
      '</div>\n',
    ].join('');
  };
}

function markdownImageRenderer(md: MarkdownItInstance): void {
  md.renderer.rules.image = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const markdownEnv = env as MarkdownRenderEnv;
    const src = token.attrGet('src');
    if (src) token.attrSet('src', resolveMarkdownImageSrc(src, markdownEnv.markdownImage));

    const rawAlt = token.children
      ? self.renderInlineAsText(token.children, options, env)
      : token.content;
    const parsedLabel = parseImageLabel(rawAlt);
    token.attrSet('alt', parsedLabel.alt);
    if (parsedLabel.dimensions?.width && !token.attrGet('width')) {
      token.attrSet('width', parsedLabel.dimensions.width);
    }
    if (parsedLabel.dimensions?.height && !token.attrGet('height')) {
      token.attrSet('height', parsedLabel.dimensions.height);
    }
    token.attrSet('loading', 'lazy');
    token.attrSet('decoding', 'async');

    return self.renderToken(tokens, idx, options);
  };
}

function markdownTableScrollWrapper(md: MarkdownItInstance): void {
  const defaultTableOpen = md.renderer.rules.table_open
    ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
  const defaultTableClose = md.renderer.rules.table_close
    ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));

  md.renderer.rules.table_open = (tokens, idx, options, env, self) => (
    `<div class="markdown-table-scroll">\n${defaultTableOpen(tokens, idx, options, env, self)}`
  );

  md.renderer.rules.table_close = (tokens, idx, options, env, self) => (
    `${defaultTableClose(tokens, idx, options, env, self)}</div>\n`
  );
}

function buildMarkdownEnv(src: string, options: MarkdownPreviewOptions = {}): MarkdownRenderEnv {
  return {
    footnoteIdPrefix: footnoteIdPrefixForSource(src),
    markdownImage: {
      filePath: options.filePath,
      getFileUrl: options.getFileUrl,
    },
  };
}

/** 获取默认 md 实例（html: false, katex 插件） */
export function getMd(): MarkdownItInstance {
  if (_md) return _md;
  _md = markdownit({
    html: false,
    breaks: true,
    linkify: true,
    typographer: true,
  });
  applyMarkdownPlugins(_md);
  return _md;
}

/** 获取文件预览专用 md 实例（html: true，渲染后必须 sanitizer） */
export function getPreviewMd(): MarkdownItInstance {
  if (_previewMd) return _previewMd;
  _previewMd = markdownit({
    html: true,
    breaks: true,
    linkify: true,
    typographer: true,
  });
  applyMarkdownPlugins(_previewMd);
  return _previewMd;
}

export function renderMarkdown(src: string): string {
  return getMd().render(src, buildMarkdownEnv(src));
}

export function renderMarkdownPreview(src: string, options: MarkdownPreviewOptions = {}): string {
  try {
    return sanitizeMarkdownPreviewHtml(getPreviewMd().render(src, buildMarkdownEnv(src, options)));
  } catch (err) {
    if (process.env.NODE_ENV !== 'production') {
      console.warn('[markdown] preview sanitizer failed:', err);
    }
    return renderMarkdown(src);
  }
}
