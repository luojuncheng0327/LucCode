/**
 * ChatArea — 聊天消息列表
 *
 * 每个 session 一个原生滚动 div，visibility:hidden 保持 scrollTop。
 */

import { useEffect, useState } from 'react';
import { useStore } from '../../stores';
import { ChatMessageSurface, type ChatScrollButtonState } from './ChatMessageSurface';
import { ChatFindBar } from './ChatFindBar';
import styles from './Chat.module.css';

const MAX_ALIVE = 5;

export function ChatArea() {
  return (
    <>
      <PanelHost />
      <ChatFindBar />
      <ScrollToBottomBtn />
    </>
  );
}

function PanelHost() {
  const currentPath = useStore(s => s.currentSessionPath);
  const welcomeVisible = useStore(s => s.welcomeVisible);
  const [alive, setAlive] = useState<string[]>([]);

  useEffect(() => {
    if (!currentPath) return;
    setAlive(prev => {
      if (prev.includes(currentPath)) return prev;
      if (prev.length >= MAX_ALIVE) {
        const evictIdx = prev.findIndex(p => p !== currentPath);
        const next = [...prev];
        next.splice(evictIdx, 1);
        next.push(currentPath);
        return next;
      }
      return [...prev, currentPath];
    });
  }, [currentPath]);

  if (welcomeVisible || !currentPath) return null;

  return (
    <>
      {alive.map(path => (
        <ChatMessageSurface
          key={path}
          sessionPath={path}
          active={path === currentPath}
          onScrollButtonChange={setScrollButton}
        />
      ))}
    </>
  );
}

const _scrollBtn = {
  el: null as HTMLElement | null,
  visible: false,
  scrollToBottom: null as (() => void) | null,
  listeners: [] as (() => void)[],
};

function setScrollButton(state: ChatScrollButtonState) {
  _scrollBtn.el = state.el;
  _scrollBtn.visible = state.visible;
  _scrollBtn.scrollToBottom = state.scrollToBottom;
  _scrollBtn.listeners.forEach(listener => listener());
}

function ScrollToBottomBtn() {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const update = () => setVisible(_scrollBtn.visible);
    _scrollBtn.listeners.push(update);
    return () => { _scrollBtn.listeners = _scrollBtn.listeners.filter(f => f !== update); };
  }, []);

  if (!visible) return null;
  return (
    <button className={styles.scrollToBottomFab} onClick={() => {
      _scrollBtn.scrollToBottom?.();
    }}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="6 9 12 15 18 9" />
      </svg>
    </button>
  );
}
