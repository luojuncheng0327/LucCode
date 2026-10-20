// desktop/src/react/utils/box-selection.ts
// 框选所需的纯几何 / 集合逻辑。无 DOM、无副作用，可单测。

export interface SelectionRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** 由两个端点构造规范化矩形（与拖拽方向无关）。 */
export function rectFromPoints(x0: number, y0: number, x1: number, y1: number): SelectionRect {
  return {
    left: Math.min(x0, x1),
    top: Math.min(y0, y1),
    right: Math.max(x0, x1),
    bottom: Math.max(y0, y1),
  };
}

/** 两矩形是否相交（仅边缘相接视为不相交）。坐标系需一致（统一用 viewport）。 */
export function rectsIntersect(a: SelectionRect, b: SelectionRect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

/** 命中检测：返回矩形与选框相交的消息 id，保持输入顺序。 */
export function hitTestMessages(
  box: SelectionRect,
  elements: ReadonlyArray<{ id: string; rect: SelectionRect }>,
): string[] {
  return elements.filter(e => rectsIntersect(box, e.rect)).map(e => e.id);
}

/** 闭区间选择：orderedIds 中 [anchorId, targetId] 之间的所有 id（含两端）。任一不存在则返回空。 */
export function rangeIds(orderedIds: readonly string[], anchorId: string, targetId: string): string[] {
  const a = orderedIds.indexOf(anchorId);
  const b = orderedIds.indexOf(targetId);
  if (a < 0 || b < 0) return [];
  const [start, end] = a <= b ? [a, b] : [b, a];
  return orderedIds.slice(start, end + 1);
}
