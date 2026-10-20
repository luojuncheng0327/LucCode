/**
 * InputContextMenu — 文本输入与指定区域的只读复制右键菜单
 *
 * 监听 document 级别的 contextmenu 事件：
 * - 任意文本输入框（input / textarea / contentEditable）：剪切 / 复制 / 粘贴 / 全选
 * - 只读文本：仅在聊天 / 频道 / 预览 / 设置区激活「复制」
 * 侧边栏等非输入区域的只读右键不接管，避免与业务菜单叠层。
 */

import { useState, useCallback, useEffect } from 'react';
import { ContextMenu, type ContextMenuItem } from '../ui';
import { useStore } from '../stores';

declare function t(key: string): string;

const TEXT_INPUT_TYPES = new Set([
  'text', 'password', 'email', 'search', 'url', 'tel', 'number', '',
]);

/** 允许激活全局右键菜单的区域（聊天、频道、预览、设置） */
const INPUT_CTX_ZONE_SELECTOR = [
  '.chat-area',
  '.input-area',
  '.channel-page',
  '#previewPanel',
  '#settingsPanel',
  '[data-input-ctx-zone]',
].join(', ');

function isTextInput(el: EventTarget | null): el is HTMLElement {
  if (!el || !(el instanceof HTMLElement)) return false;
  if (el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLInputElement) return TEXT_INPUT_TYPES.has(el.type);
  // contentEditable 元素（TipTap、CodeMirror 等富文本/代码编辑器）
  if (el.isContentEditable) return true;
  // CodeMirror: 事件目标可能是 .cm-line 等非 contentEditable 子元素，
  // 但它们的祖先 .cm-content 是 contentEditable
  if (el.closest('.cm-content')) return true;
  return false;
}

function isInInputCtxZone(el: HTMLElement): boolean {
  return !!el.closest(INPUT_CTX_ZONE_SELECTOR);
}

interface MenuState {
  position: { x: number; y: number };
  target: HTMLElement;
  selectionSnapshot: SelectionSnapshot | null;
  readOnlyText?: boolean;
}

interface SelectionSnapshot {
  type: 'text-control' | 'contenteditable';
  start?: number | null;
  end?: number | null;
  range?: Range | null;
}

function getContent(el: HTMLElement): string {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el.value;
  return findEditableRoot(el).textContent || '';
}

function findEditableRoot(el: HTMLElement): HTMLElement {
  // 对于 CM 子元素，找到 .cm-content 作为可编辑根
  if (!el.isContentEditable) {
    const cmContent = el.closest('.cm-content') as HTMLElement | null;
    if (cmContent) return cmContent;
  }
  return el;
}

function isEditable(el: HTMLElement): boolean {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return !el.readOnly && !el.disabled;
  const root = findEditableRoot(el);
  return root.isContentEditable;
}

function getContentSelectionText(el: HTMLElement): string {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const start = el.selectionStart ?? 0;
    const end = el.selectionEnd ?? 0;
    return start === end ? '' : el.value.slice(start, end);
  }
  const root = findEditableRoot(el);
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return '';
  const range = sel.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return '';
  return sel.toString();
}

function captureSelection(el: HTMLElement): SelectionSnapshot | null {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    return {
      type: 'text-control',
      start: el.selectionStart,
      end: el.selectionEnd,
    };
  }
  const root = findEditableRoot(el);
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return null;
  return {
    type: 'contenteditable',
    range: range.cloneRange(),
  };
}

function restoreSelection(target: HTMLElement, snapshot: SelectionSnapshot | null): void {
  if (!snapshot) return;
  if (snapshot.type === 'text-control' && (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) {
    target.focus();
    if (snapshot.start != null && snapshot.end != null) {
      target.setSelectionRange(snapshot.start, snapshot.end);
    }
    return;
  }
  if (snapshot.type === 'contenteditable' && snapshot.range) {
    const root = findEditableRoot(target);
    root.focus();
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(snapshot.range);
  }
}

function selectAll(el: HTMLElement): void {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    el.focus();
    el.select();
    return;
  }
  // contentEditable / CodeMirror
  const root = findEditableRoot(el);
  root.focus();
  const range = document.createRange();
  range.selectNodeContents(root);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

export function InputContextMenu() {
  const [menu, setMenu] = useState<MenuState | null>(null);

  useEffect(() => {
    const handleContextMenu = (e: MouseEvent) => {
      const target = e.target;
      if (!target || !(target instanceof HTMLElement)) return;

      // 已有更具体的右键菜单（业务组件已 preventDefault），不叠层
      if (e.defaultPrevented) return;
      // 显式排除标记（desk 卡片等）
      if (target.closest('[data-no-input-ctx]')) return;
      // CodeMirror 编辑器由 EditorContextMenu 处理
      if (target.closest('.cm-editor')) return;

      if (isTextInput(target)) {
        // 任意区域的文本输入框都保留编辑菜单（含侧边栏重命名等）
        e.preventDefault();
        setMenu({
          position: { x: e.clientX, y: e.clientY },
          target,
          selectionSnapshot: captureSelection(target),
        });
        return;
      }

      // 只读「复制」仅限聊天 / 频道 / 预览 / 设置区
      if (!isInInputCtxZone(target)) return;

      e.preventDefault();
      useStore.getState().clearQuoteCandidate?.();
      setMenu({
        position: { x: e.clientX, y: e.clientY },
        target,
        selectionSnapshot: null,
        readOnlyText: true,
      });
    };

    document.addEventListener('contextmenu', handleContextMenu);
    return () => document.removeEventListener('contextmenu', handleContextMenu);
  }, []);

  const handleClose = useCallback(() => setMenu(null), []);

  if (!menu) return null;

  const { target, selectionSnapshot } = menu;

  if (menu.readOnlyText) {
    const sel = window.getSelection();
    const hasTextSelection = !!sel && !sel.isCollapsed && sel.toString().length > 0;
    const readOnlyItems: ContextMenuItem[] = [
      {
        label: t('ctx.copy'),
        disabled: !hasTextSelection,
        action: () => {
          try { void window.platform?.runEditCommand?.('copy'); }
          catch { /* noop */ }
        },
      },
    ];
    return (
      <ContextMenu
        items={readOnlyItems}
        position={menu.position}
        onClose={handleClose}
      />
    );
  }

  const hasSelection = getContentSelectionText(target).length > 0;
  const hasContent = getContent(target).length > 0;
  const editable = isEditable(target);

  const runEditCommand = async (command: 'cut' | 'copy' | 'paste' | 'selectAll') => {
    if (command === 'paste' || command === 'selectAll') {
      findEditableRoot(target).focus();
    } else {
      restoreSelection(target, selectionSnapshot);
    }
    try {
      await window.platform?.runEditCommand?.(command);
    } catch (err) {
      console.warn('[InputContextMenu] edit command failed:', err);
    }
  };

  const items: ContextMenuItem[] = [];

  if (editable) {
    items.push({
      label: t('ctx.cut'),
      disabled: !hasSelection,
      action: () => void runEditCommand('cut'),
    });
  }

  items.push({
    label: t('ctx.copy'),
    disabled: !hasSelection,
    action: () => void runEditCommand('copy'),
  });

  if (editable) {
    items.push({
      label: t('ctx.paste'),
      action: () => void runEditCommand('paste'),
    });
  }

  if (hasContent) {
    items.push({ divider: true });
    items.push({
      label: t('ctx.selectAll'),
      action: () => {
        if (window.platform?.runEditCommand) {
          void runEditCommand('selectAll');
          return;
        }
        selectAll(target);
      },
    });
  }

  return (
    <ContextMenu
      items={items}
      position={menu.position}
      onClose={handleClose}
    />
  );
}
