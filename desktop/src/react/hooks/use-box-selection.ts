// desktop/src/react/hooks/use-box-selection.ts
// 桌面端聊天框选 + shift 范围 + 选择模式点击委托 + Esc 退出。
// 仅在精确指针（鼠标/触控板）设备启用；移动端 PWA 维持现有 checkbox 路径。
// 选中态唯一存于 selection-slice；本 hook 只持有拖拽中的临时状态（选框矩形、锚点）。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, RefObject } from 'react';
import { useStore } from '../stores';
import { selectSelectedIdsBySession } from '../stores/session-selectors';
import { rectFromPoints, hitTestMessages, rangeIds, type SelectionRect } from '../utils/box-selection';

interface Params {
  messageElementsRef: RefObject<Map<string, HTMLDivElement>>;
  orderedIds: string[];
  sessionPath: string;
  /** 是否当前显示的会话（Panel 的 active prop）。用于门控 document 级 Esc 监听，避免后台保活 Panel 响应 Esc 清掉不在视口内的选中集。 */
  active: boolean;
}

const DRAG_THRESHOLD = 3;

export function useBoxSelection({ messageElementsRef, orderedIds, sessionPath, active }: Params) {
  const setMessageSelection = useStore(s => s.setMessageSelection);
  const addMessagesToSelection = useStore(s => s.addMessagesToSelection);
  const toggleMessageSelection = useStore(s => s.toggleMessageSelection);
  const clearSelection = useStore(s => s.clearSelection);
  const selectionActive = useStore(s => selectSelectedIdsBySession(s, sessionPath).length > 0);

  const enabled = useMemo(
    () => typeof window !== 'undefined'
      && typeof window.matchMedia === 'function'
      && window.matchMedia('(pointer: fine)').matches,
    [],
  );

  const [box, setBox] = useState<SelectionRect | null>(null);
  const dragRef = useRef<{ x0: number; y0: number; base: string[]; moved: boolean } | null>(null);
  const rafRef = useRef<number | null>(null);
  const justDraggedRef = useRef(false);
  const anchorRef = useRef<string | null>(null);

  const computeHit = useCallback((rect: SelectionRect): string[] => {
    const map = messageElementsRef.current;
    if (!map) return [];
    const els: { id: string; rect: SelectionRect }[] = [];
    map.forEach((el, id) => { if (el) els.push({ id, rect: el.getBoundingClientRect() }); });
    return hitTestMessages(rect, els);
  }, [messageElementsRef]);

  // 拖拽追踪挂 window：移出容器也能继续。
  useEffect(() => {
    if (!enabled) return;
    const onMove = (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      if (!drag.moved
        && (Math.abs(e.clientX - drag.x0) > DRAG_THRESHOLD || Math.abs(e.clientY - drag.y0) > DRAG_THRESHOLD)) {
        drag.moved = true;
      }
      if (!drag.moved) return;
      const rect = rectFromPoints(drag.x0, drag.y0, e.clientX, e.clientY);
      setBox(rect);
      if (rafRef.current != null) return;
      rafRef.current = window.requestAnimationFrame(() => {
        rafRef.current = null;
        // 拖拽期间若有消息流式 register/unregister，中间命中集会随之抖动；最终选择以 onUp 同步重算为准。
        const hit = computeHit(rect);
        setMessageSelection(sessionPath, Array.from(new Set([...drag.base, ...hit])));
        if (hit.length > 0) anchorRef.current = hit[hit.length - 1];
      });
    };
    const onUp = (e: PointerEvent) => {
      const drag = dragRef.current;
      dragRef.current = null;
      if (rafRef.current != null) { window.cancelAnimationFrame(rafRef.current); rafRef.current = null; }
      setBox(null);
      if (drag?.moved) {
        // 松手时同步提交最终选择，避免 rAF 节流让选择滞后于视觉框（快速拖拽漏选）。
        const finalRect = rectFromPoints(drag.x0, drag.y0, e.clientX, e.clientY);
        const hit = computeHit(finalRect);
        setMessageSelection(sessionPath, Array.from(new Set([...drag.base, ...hit])));
        if (hit.length > 0) anchorRef.current = hit[hit.length - 1];
        justDraggedRef.current = true;
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (rafRef.current != null) { window.cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    };
  }, [enabled, computeHit, setMessageSelection, sessionPath]);

  // Esc 清空并退出选择模式。
  // active 门控：只有当前显示的 Panel 才挂 document 级监听，防止后台保活 Panel 响应 Esc 清掉不可见的选中集。
  useEffect(() => {
    if (!enabled || !active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (selectSelectedIdsBySession(useStore.getState(), sessionPath).length > 0) {
        clearSelection(sessionPath);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [enabled, active, clearSelection, sessionPath]);

  // 仅当按下落在留白（非任何消息内部）才起手框选。
  const onPointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (!enabled || e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest('[data-message-id]')) return;
    const current = selectSelectedIdsBySession(useStore.getState(), sessionPath);
    dragRef.current = {
      x0: e.clientX,
      y0: e.clientY,
      base: e.shiftKey ? [...current] : [], // shift=追加，否则替换
      moved: false,
    };
  }, [enabled, sessionPath]);

  // 选择模式下，捕获阶段把消息内点击转成 toggle / 范围选择，屏蔽内部交互。
  const onClickCapture = useCallback((e: ReactMouseEvent<HTMLDivElement>) => {
    if (!enabled) return;
    if (justDraggedRef.current) {
      justDraggedRef.current = false;
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    const active = selectSelectedIdsBySession(useStore.getState(), sessionPath).length > 0;
    if (!active) return; // 普通模式不拦截
    const target = e.target as HTMLElement;
    if (target.closest('[data-message-actions]')) return; // 放行截图/复制/全选按钮
    const group = target.closest('[data-message-id]') as HTMLElement | null;
    if (!group) return; // 点在留白，留给 onPointerDown
    const id = group.getAttribute('data-message-id');
    if (!id) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.shiftKey && anchorRef.current) {
      addMessagesToSelection(sessionPath, rangeIds(orderedIds, anchorRef.current, id));
    } else {
      toggleMessageSelection(sessionPath, id);
      anchorRef.current = id;
    }
  }, [enabled, sessionPath, orderedIds, addMessagesToSelection, toggleMessageSelection]);

  return {
    box: enabled ? box : null,
    // 拖拽中（box 存在）或已有选中都算"选择模式激活"，用于 CSS 屏蔽内部交互。
    selectionModeActive: enabled && (selectionActive || box !== null),
    onPointerDown,
    onClickCapture,
  };
}
