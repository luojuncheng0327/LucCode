/**
 * 基线网格回格补偿：表格 / 代码块的内部高度天然不是节奏单位的整数倍，
 * 其后正文会漂离网格。量出块高，把下边距补到下一个格点，块后回格。
 * 节奏单位从容器 computed line-height 取（= --md-rhythm 的实际像素值）。
 */
export function snappedRhythmMargin(blockHeight: number, rhythm: number): number {
  if (!Number.isFinite(rhythm) || rhythm <= 0) return rhythm;
  const remainder = blockHeight % rhythm;
  return remainder === 0 ? rhythm : rhythm + (rhythm - remainder);
}

const SNAP_SELECTOR = '.markdown-table-scroll, .code-block-wrap';

export function observeMarkdownRhythmSnap(container: HTMLElement): () => void {
  if (typeof ResizeObserver === 'undefined') return () => {};
  const rhythm = Number.parseFloat(getComputedStyle(container).lineHeight);
  if (!Number.isFinite(rhythm) || rhythm <= 0) return () => {};
  const observer = new ResizeObserver(entries => {
    for (const entry of entries) {
      const el = entry.target as HTMLElement;
      el.style.marginBottom = `${snappedRhythmMargin(el.getBoundingClientRect().height, rhythm)}px`;
    }
  });
  for (const el of container.querySelectorAll<HTMLElement>(SNAP_SELECTOR)) observer.observe(el);
  return () => observer.disconnect();
}
