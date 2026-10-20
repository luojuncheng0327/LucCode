// 词级查找高亮：在已渲染 DOM 的文本节点上包 <mark>。
// preview 查找与聊天查找共用；调用方负责在合适的生命周期 clear。

export function clearFindMarks(root: HTMLElement | null, className: string): void {
  if (!root) return;
  const marks = Array.from(root.querySelectorAll(`mark.${className}`));
  for (const mark of marks) {
    const parent = mark.parentNode;
    if (!parent) continue;
    parent.replaceChild(document.createTextNode(mark.textContent || ''), mark);
    parent.normalize();
  }
}

export function applyFindMarks(
  root: HTMLElement | null,
  terms: string[],
  className: string,
  options?: {
    /** 只标注 closest(scopeSelector) 命中的文本节点；不传则全树标注（preview 现状） */
    scopeSelector?: string;
  },
): HTMLElement[] {
  if (!root) return [];
  clearFindMarks(root, className);
  const needles = [...new Set(terms.map((t) => t.toLowerCase()).filter(Boolean))]
    .sort((a, b) => b.length - a.length); // 长词优先，避免短词先占位拆碎长词
  if (needles.length === 0) return [];
  const scopeSelector = options?.scopeSelector;

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || parent.closest(`mark.${className}`)) return NodeFilter.FILTER_REJECT;
      if (scopeSelector && !parent.closest(scopeSelector)) return NodeFilter.FILTER_REJECT;
      const value = node.nodeValue?.toLowerCase();
      if (!value || !needles.some((n) => value.includes(n))) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);

  const marks: HTMLElement[] = [];
  for (const node of nodes) {
    const text = node.nodeValue || '';
    const lower = text.toLowerCase();
    const taken: Array<{ from: number; to: number }> = [];
    for (const needle of needles) {
      let index = lower.indexOf(needle);
      while (index >= 0) {
        const to = index + needle.length;
        if (!taken.some((r) => index < r.to && to > r.from)) taken.push({ from: index, to });
        index = lower.indexOf(needle, index + 1);
      }
    }
    if (taken.length === 0) continue;
    taken.sort((a, b) => a.from - b.from);

    const fragment = document.createDocumentFragment();
    let cursor = 0;
    for (const range of taken) {
      if (range.from > cursor) fragment.append(document.createTextNode(text.slice(cursor, range.from)));
      const mark = document.createElement('mark');
      mark.className = className;
      mark.textContent = text.slice(range.from, range.to);
      fragment.append(mark);
      marks.push(mark);
      cursor = range.to;
    }
    if (cursor < text.length) fragment.append(document.createTextNode(text.slice(cursor)));
    node.replaceWith(fragment);
  }
  return marks;
}
