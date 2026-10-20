/**
 * CodeMirror Markdown formatting commands.
 *
 * Every command derives one source-preserving edit from the current selection
 * and dispatches at most one transaction, so a batch operation is one undo.
 */

import { EditorSelection, Transaction, type EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

interface TextChange {
  readonly from: number;
  readonly to: number;
  readonly insert: string;
}

interface BlockLineTarget {
  readonly markerFrom: number;
  readonly markerTo: number;
  readonly marker: string;
}

interface InlineLineTarget {
  readonly from: number;
  readonly to: number;
  readonly text: string;
}

export interface MarkdownInlineCommandOptions {
  /** Format parser-owned block bodies line by line instead of wrapping a raw text selection. */
  readonly blockRange?: boolean;
}

const HEADING_MARKER_RE = /^#{1,6}(?:[ \t]+|$)/;
const LIST_MARKER_RE = /^(?:[-+*]|\d+[.)])[ \t]+/;
const TASK_MARKER_RE = /^\[[ xX]\][ \t]+/;
const THEMATIC_BREAK_RE = /^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/;
const SETEXT_UNDERLINE_RE = /^ {0,3}(?:=+|-+)[ \t]*$/;
const TABLE_ROW_RE = /^\s*\|.*\|\s*$/;
const LINK_DEFINITION_RE = /^ {0,3}\[[^\]]+\]:\s*\S/;
const HTML_BLOCK_LINE_RE = /^\s*<(?:!--|\/?[A-Za-z][A-Za-z0-9-]*(?:\s|>|\/))/;
const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

function selectedLineNumbers(state: EditorState): number[] {
  const { from, to } = state.selection.main;
  const start = state.doc.lineAt(from).number;
  const lineAtTo = state.doc.lineAt(to);
  const effectiveTo = to > from && lineAtTo.from === to ? to - 1 : to;
  const end = state.doc.lineAt(Math.max(from, effectiveTo)).number;
  return Array.from({ length: end - start + 1 }, (_, offset) => start + offset);
}

function consumeContainerPrefix(text: string): number {
  const indent = text.match(/^ {0,3}/)?.[0].length ?? 0;
  let offset = indent;
  while (text.slice(offset).startsWith('>')) {
    offset += 1;
    if (text[offset] === ' ') offset += 1;
  }
  return offset;
}

function parseBlockLine(lineFrom: number, text: string): BlockLineTarget | null {
  if (text.trim() === '') return null;
  const markerOffset = consumeContainerPrefix(text);
  const rest = text.slice(markerOffset);
  const marker = rest.match(HEADING_MARKER_RE)?.[0]
    ?? rest.match(LIST_MARKER_RE)?.[0]
    ?? '';
  return {
    markerFrom: lineFrom + markerOffset,
    markerTo: lineFrom + markerOffset + marker.length,
    marker,
  };
}

function dispatchChanges(view: EditorView, changes: readonly TextChange[]): void {
  if (changes.length === 0) return;
  view.dispatch({
    changes,
    annotations: Transaction.userEvent.of('input'),
  });
}

function wrapSelection(view: EditorView, marker: string): void {
  const { state } = view;
  const { from, to } = state.selection.main;
  const selected = state.sliceDoc(from, to);

  if (
    selected.length >= marker.length * 2
    && selected.startsWith(marker)
    && selected.endsWith(marker)
  ) {
    const inner = selected.slice(marker.length, selected.length - marker.length);
    view.dispatch({
      changes: { from, to, insert: inner },
      selection: EditorSelection.cursor(from + inner.length),
      annotations: Transaction.userEvent.of('input'),
    });
    return;
  }

  const before = state.sliceDoc(Math.max(0, from - marker.length), from);
  const after = state.sliceDoc(to, Math.min(state.doc.length, to + marker.length));
  if (before === marker && after === marker) {
    view.dispatch({
      changes: [
        { from: from - marker.length, to: from, insert: '' },
        { from: to, to: to + marker.length, insert: '' },
      ],
      selection: EditorSelection.single(from - marker.length, to - marker.length),
      annotations: Transaction.userEvent.of('input'),
    });
    return;
  }

  const wrapped = `${marker}${selected}${marker}`;
  view.dispatch({
    changes: { from, to, insert: wrapped },
    selection: selected.length > 0
      ? EditorSelection.single(from + marker.length, from + marker.length + selected.length)
      : EditorSelection.cursor(from + marker.length),
    annotations: Transaction.userEvent.of('input'),
  });
}

function toggleBlockMarker(view: EditorView, targetMarker: string): void {
  const fenced = fencedLineNumbers(view.state);
  const targets = selectedLineNumbers(view.state)
    .filter(lineNumber => !fenced.has(lineNumber))
    .map(lineNumber => {
      const line = view.state.doc.line(lineNumber);
      return parseBlockLine(line.from, line.text);
    })
    .filter((target): target is BlockLineTarget => target !== null);
  if (targets.length === 0) return;

  const removeTarget = targets.every(target => target.marker === targetMarker);
  const changes = targets.flatMap<TextChange>(target => {
    if (removeTarget) {
      return [{ from: target.markerFrom, to: target.markerTo, insert: '' }];
    }
    if (target.marker === targetMarker) return [];
    return [{ from: target.markerFrom, to: target.markerTo, insert: targetMarker }];
  });
  dispatchChanges(view, changes);
}

function quotedPrefixLength(text: string): number {
  return text.match(/^ {0,3}> ?/)?.[0].length ?? 0;
}

function toggleQuotedLines(view: EditorView): void {
  const lines = selectedLineNumbers(view.state).map(lineNumber => view.state.doc.line(lineNumber));
  const removeOuterQuote = lines.every(line => quotedPrefixLength(line.text) > 0);
  const changes = lines.map<TextChange>(line => {
    if (!removeOuterQuote) {
      return {
        from: line.from,
        to: line.from,
        insert: line.text === '' ? '>' : '> ',
      };
    }
    const fullPrefixLength = quotedPrefixLength(line.text);
    const indentLength = line.text.match(/^ {0,3}/)?.[0].length ?? 0;
    return {
      from: line.from + indentLength,
      to: line.from + fullPrefixLength,
      insert: '',
    };
  });
  dispatchChanges(view, changes);
}

function fencedLineNumbers(state: EditorState): Set<number> {
  const fenced = new Set<number>();
  let active: { character: '`' | '~'; length: number } | null = null;

  for (let lineNumber = 1; lineNumber <= state.doc.lines; lineNumber += 1) {
    const text = state.doc.line(lineNumber).text;
    if (!active) {
      const opening = text.match(FENCE_OPEN_RE);
      if (!opening) continue;
      const run = opening[1];
      active = { character: run[0] as '`' | '~', length: run.length };
      fenced.add(lineNumber);
      continue;
    }

    fenced.add(lineNumber);
    const escaped = active.character === '`' ? '`' : '~';
    const closing = new RegExp(`^ {0,3}${escaped}{${active.length},}[ \\t]*$`);
    if (closing.test(text)) active = null;
  }
  return fenced;
}

function inlineBodyTarget(lineFrom: number, text: string): InlineLineTarget | null {
  if (
    text.trim() === ''
    || THEMATIC_BREAK_RE.test(text)
    || SETEXT_UNDERLINE_RE.test(text)
    || TABLE_ROW_RE.test(text)
    || LINK_DEFINITION_RE.test(text)
    || HTML_BLOCK_LINE_RE.test(text)
    || /^(?: {4}|\t)/.test(text)
  ) return null;
  const prefixLength = consumeContainerPrefix(text);
  const rest = text.slice(prefixLength);
  const heading = rest.match(HEADING_MARKER_RE)?.[0];
  const list = rest.match(LIST_MARKER_RE)?.[0];
  const task = list ? rest.slice(list.length).match(TASK_MARKER_RE)?.[0] ?? '' : '';
  const structure = heading ?? `${list ?? ''}${task}`;
  const from = lineFrom + prefixLength + structure.length;
  const body = text.slice(prefixLength + structure.length);
  const trailingWhitespace = body.match(/[ \t]+$/)?.[0].length ?? 0;
  const to = lineFrom + text.length - trailingWhitespace;
  if (to <= from) return null;
  return { from, to, text: body.slice(0, body.length - trailingWhitespace) };
}

function toggleInlineMarker(
  view: EditorView,
  marker: string,
  options: MarkdownInlineCommandOptions,
): void {
  if (!options.blockRange) {
    wrapSelection(view, marker);
    return;
  }

  const fenced = fencedLineNumbers(view.state);
  const targets = selectedLineNumbers(view.state)
    .filter(lineNumber => !fenced.has(lineNumber))
    .map(lineNumber => {
      const line = view.state.doc.line(lineNumber);
      return inlineBodyTarget(line.from, line.text);
    })
    .filter((target): target is InlineLineTarget => target !== null);
  if (targets.length === 0) return;

  const isWrapped = (target: InlineLineTarget) => (
    target.text.length >= marker.length * 2
    && target.text.startsWith(marker)
    && target.text.endsWith(marker)
  );
  const removeMarker = targets.every(isWrapped);
  const changes = targets.flatMap<TextChange>(target => {
    if (removeMarker) {
      return [{
        from: target.from,
        to: target.to,
        insert: target.text.slice(marker.length, target.text.length - marker.length),
      }];
    }
    if (isWrapped(target)) return [];
    return [{ from: target.from, to: target.to, insert: `${marker}${target.text}${marker}` }];
  });
  dispatchChanges(view, changes);
}

function completeOuterFenceInner(selected: string): string | null {
  const firstBreak = selected.indexOf('\n');
  const lastBreak = selected.lastIndexOf('\n');
  if (firstBreak < 0 || lastBreak <= firstBreak) return null;

  const openingLine = selected.slice(0, firstBreak);
  const opening = openingLine.match(/^(`{3,}|~{3,})(.*)$/);
  if (!opening) return null;
  const openingRun = opening[1];
  if (openingRun[0] === '`' && opening[2].includes('`')) return null;
  const closingLine = selected.slice(lastBreak + 1);
  const closingPattern = openingRun[0] === '`' ? /^(`{3,})[ \t]*$/ : /^(~{3,})[ \t]*$/;
  const closing = closingLine.match(closingPattern);
  if (!closing || closing[1].length < openingRun.length) return null;
  return selected.slice(firstBreak + 1, lastBreak);
}

function longestBacktickRun(text: string): number {
  let longest = 0;
  for (const match of text.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  return longest;
}

function insertBlockAtCursor(view: EditorView, block: string): void {
  const { state } = view;
  const { from } = state.selection.main;
  const line = state.doc.lineAt(from);
  const needsLeadingNewline = line.text.trim().length > 0;
  const insert = needsLeadingNewline ? `\n${block}\n` : `${block}\n`;
  const insertFrom = needsLeadingNewline ? line.to : line.from;

  view.dispatch({
    changes: { from: insertFrom, to: insertFrom, insert },
    selection: EditorSelection.cursor(insertFrom + insert.length),
    annotations: Transaction.userEvent.of('input'),
  });
}

export function toggleBold(view: EditorView, options: MarkdownInlineCommandOptions = {}): void {
  toggleInlineMarker(view, '**', options);
  view.focus();
}

export function toggleItalic(view: EditorView, options: MarkdownInlineCommandOptions = {}): void {
  toggleInlineMarker(view, '*', options);
  view.focus();
}

export function toggleStrikethrough(view: EditorView, options: MarkdownInlineCommandOptions = {}): void {
  toggleInlineMarker(view, '~~', options);
  view.focus();
}

export function toggleInlineCode(view: EditorView, options: MarkdownInlineCommandOptions = {}): void {
  toggleInlineMarker(view, '`', options);
  view.focus();
}

export function setHeading(view: EditorView, level: 1 | 2 | 3): void {
  toggleBlockMarker(view, `${'#'.repeat(level)} `);
  view.focus();
}

export function toggleBlockquote(view: EditorView): void {
  toggleQuotedLines(view);
  view.focus();
}

export function insertCodeBlock(view: EditorView): void {
  const { state } = view;
  const { from, to } = state.selection.main;
  const selected = state.sliceDoc(from, to);

  if (selected.length > 0) {
    const inner = completeOuterFenceInner(selected);
    const insert = inner ?? (() => {
      const fence = '`'.repeat(Math.max(3, longestBacktickRun(selected) + 1));
      return `${fence}\n${selected}\n${fence}`;
    })();
    view.dispatch({
      changes: { from, to, insert },
      selection: EditorSelection.cursor(from + insert.length),
      annotations: Transaction.userEvent.of('input'),
    });
  } else {
    const line = state.doc.lineAt(from);
    const needsLeadingNewline = line.text.trim().length > 0;
    const insertFrom = needsLeadingNewline ? line.to : line.from;
    const leading = needsLeadingNewline ? '\n' : '';
    const insert = `${leading}\`\`\`\n\n\`\`\`\n`;
    const cursor = insertFrom + leading.length + 4;
    view.dispatch({
      changes: { from: insertFrom, to: insertFrom, insert },
      selection: EditorSelection.cursor(cursor),
      annotations: Transaction.userEvent.of('input'),
    });
  }
  view.focus();
}

export function insertHorizontalRule(view: EditorView): void {
  insertBlockAtCursor(view, '---');
  view.focus();
}

export function toggleList(view: EditorView): void {
  toggleBlockMarker(view, '- ');
  view.focus();
}
