/**
 * useSidebarResize — 侧边栏宽度拖拽调整
 *
 * 从 sidebar-shim.ts 的 initSidebarResize 迁移。
 * 在 useEffect 中绑定 resize handle 事件，并在 unmount 时完整清理。
 */

import { useEffect } from 'react';
import { useStore } from '../stores';
import { CHAT_MIN_WIDTH } from '../layout-constants';

type ResizeMax = number | (() => number);

export function useSidebarResize(): void {
  const currentTab = useStore(s => s.currentTab);
  const currentChannel = useStore(s => s.currentChannel);
  const previewOpen = useStore(s => s.previewOpen);

  useEffect(() => {
    const root = document.documentElement;
    const sidebarEl = document.getElementById('sidebar');
    const jianSidebarEl = document.getElementById('jianSidebar');
    const channelInspectorEl = document.getElementById('channelInspector');
    const leftHandle = document.getElementById('sidebarResizeHandle');
    const rightHandle = document.getElementById('jianResizeHandle');
    const channelInspectorHandle = document.getElementById('channelInspectorResizeHandle');
    const previewPanel = document.getElementById('previewPanel');

    const LEFT_MIN = 180, LEFT_MAX = 400;
    const RIGHT_MIN = 200, RIGHT_MAX = 600;
    const CHANNEL_INSPECTOR_MIN = 220, CHANNEL_INSPECTOR_MAX = 620;
    const PREVIEW_MIN = 320;

    const leftInner = sidebarEl?.querySelector('.sidebar-inner') as HTMLElement | null;
    const rightInner = jianSidebarEl?.querySelector('.jian-sidebar-inner') as HTMLElement | null;
    const previewInner = previewPanel?.querySelector('[data-preview-panel-inner]') as HTMLElement | null;

    function cssWidth(name: string, fallback: number): number {
      const parsed = parseInt(getComputedStyle(root).getPropertyValue(name), 10);
      return Number.isFinite(parsed) ? parsed : fallback;
    }

    function visiblePanelWidth(el: HTMLElement | null, cssVar: string, fallback: number, visible: boolean): number {
      if (!visible) return 0;
      return el?.offsetWidth || cssWidth(cssVar, fallback);
    }

    function clampWidth(value: number, min: number, max: number): number {
      const upper = Number.isFinite(max) ? Math.max(min, max) : min;
      return Math.max(min, Math.min(upper, value));
    }

    function createResizeEventShield(): () => void {
      const shield = document.createElement('div');
      shield.setAttribute('data-resize-event-shield', '');
      Object.assign(shield.style, {
        position: 'fixed',
        inset: '0',
        zIndex: '2147483647',
        cursor: 'col-resize',
        background: 'transparent',
      });
      document.body.appendChild(shield);
      return () => {
        shield.remove();
      };
    }

    function getPreviewMaxWidth(): number {
      const state = useStore.getState();
      const occupiedWidth =
        visiblePanelWidth(sidebarEl, '--sidebar-width', 240, state.sidebarOpen) +
        visiblePanelWidth(jianSidebarEl, '--jian-sidebar-width', 260, state.jianOpen) +
        visiblePanelWidth(
          channelInspectorEl,
          '--channel-inspector-width',
          280,
          state.currentTab === 'channels' && !!state.currentChannel,
        );

      return Math.max(PREVIEW_MIN, window.innerWidth - occupiedWidth - CHAT_MIN_WIDTH);
    }

    function applySidebarWidth(w: number): void {
      const px = w + 'px';
      root.style.setProperty('--sidebar-width', px);
      if (leftInner) { leftInner.style.width = px; leftInner.style.minWidth = px; }
    }

    function updateJianColumns(w: number): void {
      const cols = w > 520 ? 3 : w > 350 ? 2 : 1;
      root.style.setProperty('--jian-columns', String(cols));
    }

    function applyJianWidth(w: number): void {
      const px = w + 'px';
      root.style.setProperty('--jian-sidebar-width', px);
      if (rightInner) { rightInner.style.width = px; rightInner.style.minWidth = px; }
      updateJianColumns(w);
    }

    function applyChannelInspectorWidth(w: number): void {
      const px = w + 'px';
      root.style.setProperty('--channel-inspector-width', px);
      if (channelInspectorEl) {
        channelInspectorEl.style.width = px;
        channelInspectorEl.style.minWidth = px;
      }
    }

    function applyPreviewWidth(w: number): void {
      const px = w + 'px';
      root.style.setProperty('--preview-panel-width', px);
      if (previewInner) { previewInner.style.width = px; previewInner.style.minWidth = px; }
    }

    // 恢复保存的宽度
    const savedLeft = localStorage.getItem('luc-sidebar-width');
    const savedRight = localStorage.getItem('luc-jian-width');
    const savedChannelInspector = localStorage.getItem('luc-channel-inspector-width');
    const savedPreview = localStorage.getItem('luc-preview-width');
    if (savedLeft) applySidebarWidth(Number(savedLeft));
    if (savedRight) applyJianWidth(Number(savedRight));
    if (savedChannelInspector) applyChannelInspectorWidth(Number(savedChannelInspector));
    if (savedPreview) {
      const savedPreviewWidth = Number(savedPreview);
      if (Number.isFinite(savedPreviewWidth)) {
        applyPreviewWidth(clampWidth(savedPreviewWidth, PREVIEW_MIN, getPreviewMaxWidth()));
      }
    }

    const cleanupFns: Array<() => void> = [];

    function setupHandle(
      handle: HTMLElement | null,
      getSidebar: () => HTMLElement | null,
      getWidth: () => number,
      setWidth: (w: number) => void,
      min: number,
      max: ResizeMax,
      storageKey: string,
      isRight: boolean,
    ): void {
      if (!handle) return;

      const onHandleMove = (e: MouseEvent) => {
        const rect = handle.getBoundingClientRect();
        handle.style.setProperty('--handle-y', (e.clientY - rect.top) + 'px');
      };
      const onHandleLeave = () => {
        handle.style.setProperty('--handle-y', '-999px');
      };

      let activeDragCleanup: (() => void) | null = null;
      let removeResizeShield: (() => void) | null = null;

      const onMouseDown = (e: MouseEvent) => {
        activeDragCleanup?.();
        activeDragCleanup = null;
        removeResizeShield = null;

        e.preventDefault();
        const sidebarTarget = getSidebar();
        if (!sidebarTarget || sidebarTarget.classList.contains('collapsed')) return;

        const startX = e.clientX;
        const startW = getWidth();
        let liveWidth = startW;
        handle.classList.add('active');
        document.body.classList.add('resizing');
        removeResizeShield = createResizeEventShield();

        function onMove(e: MouseEvent): void {
          const delta = isRight ? startX - e.clientX : e.clientX - startX;
          const maxWidth = typeof max === 'function' ? max() : max;
          const w = clampWidth(startW + delta, min, maxWidth);
          liveWidth = w;
          setWidth(w);
          const rect = handle!.getBoundingClientRect();
          handle!.style.setProperty('--handle-y', (e.clientY - rect.top) + 'px');
        }

        function onUp(): void {
          handle!.classList.remove('active');
          document.body.classList.remove('resizing');
          handle!.style.setProperty('--handle-y', '-999px');
          removeResizeShield?.();
          removeResizeShield = null;
          const w = liveWidth;
          localStorage.setItem(storageKey, String(w));
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          activeDragCleanup = null;
        }

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
        activeDragCleanup = () => {
          handle.classList.remove('active');
          document.body.classList.remove('resizing');
          handle.style.setProperty('--handle-y', '-999px');
          removeResizeShield?.();
          removeResizeShield = null;
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          activeDragCleanup = null;
        };
      };

      handle.addEventListener('mousemove', onHandleMove);
      handle.addEventListener('mouseleave', onHandleLeave);
      handle.addEventListener('mousedown', onMouseDown);

      cleanupFns.push(() => {
        activeDragCleanup?.();
        handle.removeEventListener('mousemove', onHandleMove);
        handle.removeEventListener('mouseleave', onHandleLeave);
        handle.removeEventListener('mousedown', onMouseDown);
      });
    }

    setupHandle(
      leftHandle,
      () => sidebarEl,
      () => sidebarEl?.offsetWidth || 240,
      (w) => applySidebarWidth(w),
      LEFT_MIN, LEFT_MAX, 'luc-sidebar-width', false,
    );

    setupHandle(
      rightHandle,
      () => jianSidebarEl,
      () => jianSidebarEl?.offsetWidth || 260,
      (w) => applyJianWidth(w),
      RIGHT_MIN, RIGHT_MAX, 'luc-jian-width', true,
    );

    setupHandle(
      channelInspectorHandle,
      () => channelInspectorEl,
      () => channelInspectorEl?.offsetWidth || 280,
      (w) => applyChannelInspectorWidth(w),
      CHANNEL_INSPECTOR_MIN, CHANNEL_INSPECTOR_MAX, 'luc-channel-inspector-width', true,
    );

    const previewHandle = document.getElementById('previewResizeHandle');
    setupHandle(
      previewHandle,
      () => previewPanel,
      () => previewPanel?.offsetWidth || 580,
      (w) => applyPreviewWidth(w),
      PREVIEW_MIN, getPreviewMaxWidth, 'luc-preview-width', true,
    );

    return () => {
      for (const cleanup of cleanupFns) cleanup();
    };
  }, [currentTab, currentChannel, previewOpen]);
}
