// 行级 diff：jsdiff 的封装，输出逐行 DiffLine。输入超限返回 null，
// 调用方降级为全文展示（不做假 diff，保护渲染）。
import { diffLines as jsdiffLines } from 'diff';

export type DiffLine = { kind: 'same' | 'added' | 'removed'; text: string };

const MAX_INPUT_CHARS = 2_000_000;

function pushLines(result: DiffLine[], kind: DiffLine['kind'], chunkValue: string): void {
  const lines = chunkValue.split('\n');
  // 内容以换行结尾时 split 会多出一个空尾项，去掉它；
  // 但整段就是空串时保留那一项，它代表"一行空行"而不是"没有行"
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  for (const text of lines) result.push({ kind, text });
}

export function diffLines(oldText: string, newText: string): DiffLine[] | null {
  if (oldText.length > MAX_INPUT_CHARS || newText.length > MAX_INPUT_CHARS) return null;

  // jsdiff 把空文本当成"没有任何行"，空的那一侧会在结果里彻底消失，
  // 于是新增/清空整个文件时只剩单侧变更，两侧行号对不上。
  // 这里显式把空文本当作一行空行，保证空侧也占一行。
  if (oldText === '' || newText === '') {
    if (oldText === newText) return [{ kind: 'same', text: '' }];
    const result: DiffLine[] = [];
    pushLines(result, 'removed', oldText);
    pushLines(result, 'added', newText);
    return result;
  }

  const result: DiffLine[] = [];
  // ignoreNewlineAtEof：末行缺尾换行时（'a' vs 'a\nb' 里的 'a'）默认不与带换行的同名行相等，
  // 会把没变过的末行报成一删一增。开这个选项按 jsdiff 自己的语义对齐，
  // 不改写入参，chunk 文本仍与源文本逐字一致。
  for (const chunk of jsdiffLines(oldText, newText, { ignoreNewlineAtEof: true })) {
    pushLines(result, chunk.added ? 'added' : chunk.removed ? 'removed' : 'same', chunk.value);
  }
  return result;
}
