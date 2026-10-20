import { syntaxTree } from '@codemirror/language';
import type { EditorState } from '@codemirror/state';
import { findMarkdownFrontMatterRange } from '../utils/markdown-document';

export interface MarkdownBlock {
  readonly from: number;
  readonly to: number;
  readonly type: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly source: string;
}

export type MarkdownBlockPlacement = 'before' | 'after';

export interface MarkdownBlockMove {
  readonly changes: {
    readonly from: number;
    readonly to: number;
    readonly insert: string;
  };
  readonly selectionAnchor: number;
  readonly movedRange: {
    readonly from: number;
    readonly to: number;
  };
}

/**
 * Collect the parser's top-level Markdown nodes without treating blank lines as blocks.
 */
export function collectMarkdownBlocks(state: EditorState): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  const protectedFrontMatter = findMarkdownFrontMatterRange(state.doc.toString());
  let node = syntaxTree(state).topNode.firstChild;

  while (node) {
    const overlapsFrontMatter = protectedFrontMatter
      ? node.from < protectedFrontMatter.to && node.to > protectedFrontMatter.from
      : false;
    if (node.to > node.from && !overlapsFrontMatter) {
      blocks.push({
        from: node.from,
        to: node.to,
        type: node.name,
        startLine: state.doc.lineAt(node.from).number,
        endLine: state.doc.lineAt(node.to - 1).number,
        source: state.doc.sliceString(node.from, node.to),
      });
    }
    node = node.nextSibling;
  }

  return blocks;
}

function blocksMatch(left: MarkdownBlock, right: MarkdownBlock): boolean {
  return left.from === right.from
    && left.to === right.to
    && left.type === right.type
    && left.startLine === right.startLine
    && left.endLine === right.endLine
    && left.source === right.source;
}

function findMatchingBlock(blocks: readonly MarkdownBlock[], candidate: MarkdownBlock): number {
  return blocks.findIndex(block => blocksMatch(block, candidate));
}

/**
 * Build a minimal source-preserving replacement for moving one top-level block.
 * Whitespace between blocks belongs to its original slot, so moving blocks never
 * normalizes blank lines or other inter-block source.
 */
export function buildMarkdownBlockMove(
  state: EditorState,
  sourceBlock: MarkdownBlock,
  targetBlock: MarkdownBlock,
  placement: MarkdownBlockPlacement,
): MarkdownBlockMove | null {
  return buildMarkdownBlockRangeMove(state, [sourceBlock], targetBlock, placement);
}

/**
 * Move a contiguous range of top-level blocks without changing their source.
 * The range is validated against the current parse so stale drag state cannot
 * rewrite a newer document.
 */
export function buildMarkdownBlockRangeMove(
  state: EditorState,
  sourceBlocks: readonly MarkdownBlock[],
  targetBlock: MarkdownBlock,
  placement: MarkdownBlockPlacement,
): MarkdownBlockMove | null {
  const blocks = collectMarkdownBlocks(state);
  if (sourceBlocks.length === 0) return null;
  const sourceIndices = sourceBlocks.map(block => findMatchingBlock(blocks, block));
  const targetIndex = findMatchingBlock(blocks, targetBlock);

  if (targetIndex < 0 || sourceIndices.some(index => index < 0)) return null;
  const sourceStart = sourceIndices[0];
  const sourceEnd = sourceIndices[sourceIndices.length - 1];
  if (sourceIndices.some((index, offset) => index !== sourceStart + offset)) return null;
  if (targetIndex >= sourceStart && targetIndex <= sourceEnd) return null;

  const reordered = [...blocks];
  const movedBlocks = reordered.splice(sourceStart, sourceBlocks.length);
  const remainingTargetIndex = reordered.findIndex(block => blocksMatch(block, targetBlock));
  if (movedBlocks.length !== sourceBlocks.length || remainingTargetIndex < 0) return null;

  const insertionIndex = remainingTargetIndex + (placement === 'after' ? 1 : 0);
  reordered.splice(insertionIndex, 0, ...movedBlocks);

  let firstChanged = 0;
  while (firstChanged < blocks.length
    && blocksMatch(blocks[firstChanged], reordered[firstChanged])) {
    firstChanged += 1;
  }
  if (firstChanged === blocks.length) return null;

  let lastChanged = blocks.length - 1;
  while (lastChanged > firstChanged
    && blocksMatch(blocks[lastChanged], reordered[lastChanged])) {
    lastChanged -= 1;
  }

  const gaps: string[] = [];
  for (let index = firstChanged; index < lastChanged; index += 1) {
    gaps.push(state.doc.sliceString(blocks[index].to, blocks[index + 1].from));
  }

  let insert = '';
  let selectionAnchor = blocks[firstChanged].from;
  let selectionHead = selectionAnchor;
  for (let index = firstChanged; index <= lastChanged; index += 1) {
    const block = reordered[index];
    if (block === movedBlocks[0]) selectionAnchor = blocks[firstChanged].from + insert.length;
    insert += block.source;
    if (block === movedBlocks[movedBlocks.length - 1]) {
      selectionHead = blocks[firstChanged].from + insert.length;
    }
    if (index < lastChanged) insert += gaps[index - firstChanged];
  }

  return {
    changes: {
      from: blocks[firstChanged].from,
      to: blocks[lastChanged].to,
      insert,
    },
    selectionAnchor,
    movedRange: {
      from: selectionAnchor,
      to: selectionHead,
    },
  };
}
