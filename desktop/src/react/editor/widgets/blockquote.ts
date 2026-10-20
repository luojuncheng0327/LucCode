import { EditorView, Decoration } from '@codemirror/view';
import type { DecoRange } from '../md-decorations';

const blockquoteLineDecos = {
  middle: Decoration.line({ class: 'cm-blockquote-line' }),
  first: Decoration.line({ class: 'cm-blockquote-line cm-blockquote-line-first' }),
  last: Decoration.line({ class: 'cm-blockquote-line cm-blockquote-line-last' }),
  only: Decoration.line({ class: 'cm-blockquote-line cm-blockquote-line-first cm-blockquote-line-last' }),
};

function blockquoteLineDeco(isFirst: boolean, isLast: boolean): Decoration {
  if (isFirst && isLast) return blockquoteLineDecos.only;
  if (isFirst) return blockquoteLineDecos.first;
  if (isLast) return blockquoteLineDecos.last;
  return blockquoteLineDecos.middle;
}

export function handleBlockquote(ctx: {
  view: EditorView;
  node: { name: string; from: number; to: number };
  ranges: DecoRange[];
}) {
  const { view, node, ranges } = ctx;
  const startLine = view.state.doc.lineAt(node.from);
  const endLine = view.state.doc.lineAt(node.to);
  for (let i = startLine.number; i <= endLine.number; i++) {
    const line = view.state.doc.line(i);
    ranges.push({
      from: line.from,
      to: line.from,
      deco: blockquoteLineDeco(i === startLine.number, i === endLine.number),
    });
  }
}
