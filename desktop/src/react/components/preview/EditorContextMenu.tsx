/**
 * EditorContextMenu — 编辑器右键上下文菜单
 *
 * 由 PreviewEditor 内部挂载，自动适配所有渲染路径（主面板、Viewer 窗口等）。
 *
 * mode === 'markdown' && !readOnly 时显示格式化工具栏（B I S 等）；
 * readOnly 时只保留 复制 / 全选。
 *
 * 所有 document / window 引用走 ownerDocument / ownerWindow，
 * 保证在 DOM-adopted 子窗口中 portal 和事件监听指向正确的宿主。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { undo, redo } from '@codemirror/commands';
import { useStore } from '../../stores';
import type { EditorView } from '@codemirror/view';
import type {
  MarkdownBlockMenuRequest,
  MarkdownBlockMenuTarget,
} from '../../editor/markdown-block-handles';
import { copyMarkdownSource } from '../../editor/markdown-block-selection';
import { EditorFormatMenu } from './EditorFormatMenu';

function label(key: string, fallback: string): string {
  try {
    const translated = window.t?.(key);
    return translated && translated !== key ? translated : fallback;
  } catch {
    return fallback;
  }
}

interface MenuState {
  position: { x: number; y: number };
  hasSelection: boolean;
  canUndo: boolean;
  canRedo: boolean;
  blockTarget?: MarkdownBlockMenuTarget;
}

function editorHasSelection(view: EditorView): boolean {
  return view.state.selection.ranges.some(r => !r.empty);
}

function editorCanUndo(view: EditorView): boolean {
  return undo({ state: view.state, dispatch: () => {} });
}

function editorCanRedo(view: EditorView): boolean {
  return redo({ state: view.state, dispatch: () => {} });
}

function eventTargetClosest(target: EventTarget | null, selector: string): Element | null {
  if (!target || typeof target !== 'object' || !('nodeType' in target)) return null;
  const node = target as Node;
  const element = node.nodeType === 1 ? node as Element : node.parentElement;
  return element?.closest(selector) ?? null;
}

interface Props {
  getView: () => EditorView | null;
  containerRef: React.RefObject<HTMLDivElement | null>;
  mode: 'markdown' | 'code' | 'csv' | 'text';
  readOnly?: boolean;
  blockMenuRequest?: MarkdownBlockMenuRequest | null;
  onBlockMenuClose?: () => void;
  onQuoteRange?: (view: EditorView, range: { from: number; to: number }) => void;
}

export function EditorContextMenu({
  getView,
  containerRef,
  mode,
  readOnly = false,
  blockMenuRequest,
  onBlockMenuClose,
  onQuoteRange,
}: Props) {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const ownerDoc = useCallback(
    () => containerRef.current?.ownerDocument ?? document,
    [containerRef],
  );
  const ownerWin = useCallback(
    () => containerRef.current?.ownerDocument?.defaultView ?? window,
    [containerRef],
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;

    const handleContextMenu = (e: MouseEvent) => {
      const view = getView();
      if (!view) return;

      const target = e.target;
      if (!(target instanceof HTMLElement)) return;
      if (!container.contains(target)) return;

      e.preventDefault();
      e.stopPropagation();

      useStore.getState().clearQuoteCandidate?.();

      setMenu({
        position: { x: e.clientX, y: e.clientY },
        hasSelection: editorHasSelection(view),
        canUndo: !readOnly && editorCanUndo(view),
        canRedo: !readOnly && editorCanRedo(view),
      });
      onBlockMenuClose?.();
    };

    container.addEventListener('contextmenu', handleContextMenu);
    return () => container.removeEventListener('contextmenu', handleContextMenu);
  }, [getView, containerRef, onBlockMenuClose, readOnly]);

  useEffect(() => {
    if (!blockMenuRequest) {
      setMenu(current => current?.blockTarget ? null : current);
      return;
    }
    const view = getView();
    if (!view) return;
    const { target } = blockMenuRequest;
    if (view.state.sliceDoc(target.from, target.to) !== target.source) {
      onBlockMenuClose?.();
      return;
    }
    useStore.getState().clearQuoteCandidate?.();
    setMenu({
      position: blockMenuRequest.position,
      hasSelection: true,
      canUndo: !readOnly && editorCanUndo(view),
      canRedo: !readOnly && editorCanRedo(view),
      blockTarget: target,
    });
  }, [blockMenuRequest, getView, onBlockMenuClose, readOnly]);

  useEffect(() => {
    if (!menu || !menuRef.current) return;
    const el = menuRef.current;
    const rect = el.getBoundingClientRect();
    const win = ownerWin();
    let { x, y } = menu.position;
    if (x + rect.width > win.innerWidth) x = win.innerWidth - rect.width - 4;
    if (y + rect.height > win.innerHeight) y = win.innerHeight - rect.height - 4;
    if (x < 0) x = 4;
    if (y < 0) y = 4;
    el.style.left = x + 'px';
    el.style.top = y + 'px';
  }, [menu, ownerWin]);

  useEffect(() => {
    if (!menu) return undefined;
    const doc = ownerDoc();
    const win = ownerWin();

    const close = () => {
      setMenu(null);
      if (menu.blockTarget) onBlockMenuClose?.();
    };
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      // The Grabber owns its toggle. Closing here during capture would clear
      // the request before the button's click handler runs, making that same
      // click open a fresh menu instead of closing the current one.
      if (menu.blockTarget && eventTargetClosest(e.target, '.cm-markdown-block-handle')) return;
      close();
    };
    const handleCtx = (e: MouseEvent) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      close();
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    const handleScroll = () => close();

    const timer = setTimeout(() => {
      doc.addEventListener('click', handleClick, true);
      doc.addEventListener('contextmenu', handleCtx, true);
      doc.addEventListener('keydown', handleKeyDown);
      win.addEventListener('scroll', handleScroll, true);
    });

    return () => {
      clearTimeout(timer);
      doc.removeEventListener('click', handleClick, true);
      doc.removeEventListener('contextmenu', handleCtx, true);
      doc.removeEventListener('keydown', handleKeyDown);
      win.removeEventListener('scroll', handleScroll, true);
    };
  }, [menu, onBlockMenuClose, ownerDoc, ownerWin]);

  const close = useCallback(() => {
    if (menu?.blockTarget) onBlockMenuClose?.();
    setMenu(null);
  }, [menu?.blockTarget, onBlockMenuClose]);

  const selectBlockTarget = useCallback((
    view: EditorView,
    target: MarkdownBlockMenuTarget,
    selection: 'block' | 'start' | 'end',
  ): boolean => {
    if (view.state.sliceDoc(target.from, target.to) !== target.source) return false;
    if (selection === 'block') {
      view.dispatch({ selection: { anchor: target.from, head: target.to } });
    } else {
      view.dispatch({ selection: { anchor: selection === 'start' ? target.from : target.to } });
    }
    return true;
  }, []);

  const runEditCommand = useCallback(async (command: 'cut' | 'copy' | 'paste' | 'selectAll') => {
    const view = getView();
    if (!view) return;
    const target = menu?.blockTarget;
    if (target && command === 'copy') {
      if (view.state.sliceDoc(target.from, target.to) !== target.source) return;
      try {
        await copyMarkdownSource(view, target.source);
      } catch (err) {
        console.warn('[EditorContextMenu] copy block source failed:', err);
      }
      return;
    }
    if (target && command !== 'selectAll') {
      const selection = command === 'paste' ? 'end' : 'block';
      if (!selectBlockTarget(view, target, selection)) return;
    }
    view.focus();
    try {
      await window.platform?.runEditCommand?.(command);
    } catch (err) {
      console.warn('[EditorContextMenu] edit command failed:', err);
    }
  }, [getView, menu?.blockTarget, selectBlockTarget]);

  const runBlockCommand = useCallback((
    selection: 'block' | 'start',
    command: (view: EditorView) => void,
  ) => {
    const view = getView();
    if (!view) return;
    const target = menu?.blockTarget;
    if (target && !selectBlockTarget(view, target, selection)) return;
    command(view);
  }, [getView, menu?.blockTarget, selectBlockTarget]);

  const runQuoteCommand = useCallback(() => {
    const view = getView();
    if (!view || !onQuoteRange) return;
    const target = menu?.blockTarget;
    if (target) {
      if (view.state.sliceDoc(target.from, target.to) !== target.source) return;
      onQuoteRange(view, { from: target.from, to: target.to });
      return;
    }
    const { from, to } = view.state.selection.main;
    if (from !== to) onQuoteRange(view, { from, to });
  }, [getView, menu?.blockTarget, onQuoteRange]);

  const handleUndo = useCallback(() => {
    const view = getView();
    if (view) { undo(view); view.focus(); }
  }, [getView]);

  const handleRedo = useCallback(() => {
    const view = getView();
    if (view) { redo(view); view.focus(); }
  }, [getView]);

  if (!menu) return null;

  const isMac = navigator.platform?.startsWith('Mac') || navigator.userAgent?.includes('Mac');
  const mod = isMac ? '⌘' : 'Ctrl+';
  const showFmt = mode === 'markdown' && !readOnly;

  return createPortal(
    <div
      className="context-menu"
      ref={menuRef}
      style={{ left: menu.position.x, top: menu.position.y }}
    >
      {onQuoteRange && (
        <>
          <MenuItem
            label={label('selection.quoteToChat', '引用到对话')}
            disabled={!menu.hasSelection}
            onClick={() => { close(); runQuoteCommand(); }}
          />
          <div className="context-menu-divider" />
        </>
      )}
      {!readOnly && (
        <MenuItem
          label={label('ctx.cut', '剪切')}
          shortcut={`${mod}X`}
          disabled={!menu.hasSelection}
          onClick={() => { close(); void runEditCommand('cut'); }}
        />
      )}
      <MenuItem
        label={label('ctx.copy', '复制')}
        shortcut={`${mod}C`}
        disabled={!menu.hasSelection}
        onClick={() => { close(); void runEditCommand('copy'); }}
      />
      {!readOnly && (
        <MenuItem
          label={label('ctx.paste', '粘贴')}
          shortcut={`${mod}V`}
          onClick={() => { close(); void runEditCommand('paste'); }}
        />
      )}
      <div className="context-menu-divider" />
      <MenuItem
        label={label('ctx.selectAll', '全选')}
        shortcut={`${mod}A`}
        onClick={() => { close(); void runEditCommand('selectAll'); }}
      />
      {!readOnly && (
        <>
          <div className="context-menu-divider" />
          <MenuItem
            label={label('ctx.undo', '撤销')}
            shortcut={`${mod}Z`}
            disabled={!menu.canUndo}
            onClick={() => { close(); handleUndo(); }}
          />
          <MenuItem
            label={label('ctx.redo', '重做')}
            shortcut={isMac ? '⇧⌘Z' : 'Ctrl+Y'}
            disabled={!menu.canRedo}
            onClick={() => { close(); handleRedo(); }}
          />
        </>
      )}

      {showFmt && (
        <EditorFormatMenu
          blockTarget={Boolean(menu.blockTarget)}
          close={close}
          runBlockCommand={runBlockCommand}
        />
      )}
    </div>,
    ownerDoc().body,
  );
}

/* ── 子组件 ── */

function MenuItem({ label: text, shortcut, disabled, onClick }: {
  label: string;
  shortcut?: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <div
      className={`context-menu-item${disabled ? ' disabled' : ''}`}
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => {
        if (disabled) { e.preventDefault(); e.stopPropagation(); return; }
        e.stopPropagation();
        onClick();
      }}
    >
      <span className="context-menu-label">{text}</span>
      {shortcut && <span className="context-menu-shortcut">{shortcut}</span>}
    </div>
  );
}
