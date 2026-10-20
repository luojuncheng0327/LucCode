/**
 * FloatSidebar — 侧边栏折叠时 hover 滑入的全高面板
 *
 * 左侧：完整 ChatSidebarContent（搜索、分组、拖拽、右键菜单）
 * 右侧：完整 RightWorkspacePanel（文件树、笺编辑器）
 */

import { useState, useCallback, useRef } from 'react';
import { useStore } from '../stores';
import { useAnimatePresence } from '../hooks/use-animate-presence';
import { createNewSession } from '../stores/session-actions';
import { openSettingsModal } from '../stores/settings-modal-actions';
import { ChatSidebarContent } from './app/ChatSidebar';
import { RightWorkspacePanel } from './right-workspace/RightWorkspacePanel';
import { RegionalErrorBoundary } from './RegionalErrorBoundary';

import type { ActivePanel } from '../types';

type FloatSidebarSide = 'left' | 'right';

let _enterTimer: ReturnType<typeof setTimeout> | null = null;
let _leaveTimer: ReturnType<typeof setTimeout> | null = null;

export function useFloatSidebar() {
  const [side, setSide] = useState<FloatSidebarSide | null>(null);

  const show = useCallback((target: FloatSidebarSide) => {
    if (_leaveTimer) clearTimeout(_leaveTimer);
    if (_enterTimer) clearTimeout(_enterTimer);
    _enterTimer = setTimeout(() => {
      const isCollapsed = target === 'left'
        ? !useStore.getState().sidebarOpen
        : !useStore.getState().jianOpen;
      if (!isCollapsed) return;
      setSide(target);
    }, 200);
  }, []);

  const scheduleHide = useCallback(() => {
    if (_enterTimer) clearTimeout(_enterTimer);
    _leaveTimer = setTimeout(() => setSide(null), 200);
  }, []);

  const cancelHide = useCallback(() => {
    if (_leaveTimer) clearTimeout(_leaveTimer);
  }, []);

  const hide = useCallback(() => {
    if (_enterTimer) clearTimeout(_enterTimer);
    if (_leaveTimer) clearTimeout(_leaveTimer);
    setSide(null);
  }, []);

  return { side, show, scheduleHide, cancelHide, hide };
}

const FLOAT_SIDEBAR_ANIM_DURATION = 250;

function togglePanel(panel: ActivePanel) {
  const s = useStore.getState();
  s.setActivePanel(s.activePanel === panel ? null : panel);
}

export function FloatSidebar({
  side,
  onMouseEnter,
  onMouseLeave,
  onAction,
}: {
  side: FloatSidebarSide | null;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  onAction: () => void;
}) {
  const lastSideRef = useRef<FloatSidebarSide>('left');
  if (side) lastSideRef.current = side;

  const { mounted, stage } = useAnimatePresence(side !== null, {
    duration: FLOAT_SIDEBAR_ANIM_DURATION,
  });

  if (!mounted) return null;

  const activeSide = lastSideRef.current;

  return (
    <div
      className="float-sidebar"
      data-side={activeSide}
      data-stage={stage}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <div className={`float-sidebar-panel float-sidebar-panel-${activeSide}`}>
        {activeSide === 'left' ? (
          <LeftPanel onAction={onAction} />
        ) : (
          <RightPanel />
        )}
      </div>
    </div>
  );
}

function LeftPanel({ onAction }: { onAction: () => void }) {
  const handleNewSession = useCallback(() => {
    onAction();
    createNewSession();
  }, [onAction]);

  const handleOpenSettings = useCallback(() => {
    onAction();
    openSettingsModal();
  }, [onAction]);

  return (
    <div className="sidebar-chat-content">
      <ChatSidebarContent
        showSettingsButton
        showActivityBars
        onNewSession={handleNewSession}
        onCollapse={onAction}
        onOpenSettings={handleOpenSettings}
        onTogglePanel={togglePanel}
        region="float-sidebar"
      />
    </div>
  );
}

function RightPanel() {
  return (
    <RegionalErrorBoundary region="float-sidebar-right">
      <RightWorkspacePanel compact />
    </RegionalErrorBoundary>
  );
}
