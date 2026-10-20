/**
 * 会话内查找条：Cmd+F 唤起，全会话消息级查找（走 /api/sessions/find）。
 * PreviewPanel 的 Cmd+F 用 capture+stopPropagation 拦截，preview 打开时
 * 本组件的 bubble 监听收不到事件，天然让位。
 * 查找状态 keyed by session 常驻（切走再切回仍在）；mark 渲染由
 * ChatMessageSurface 的 active gate 管控，本组件只负责 UI 条与查询编排。
 */
import { useCallback, useEffect, useRef } from 'react';
import { useStore } from '../../stores';
import { sessionScopedValue } from '../../stores/session-slice';
import { runChatFind, stepChatFind } from '../../stores/chat-find-actions';
import { ClassicFindBox } from '../../ui/ClassicFindBox';
import { useI18n } from '../../hooks/use-i18n';
import styles from './Chat.module.css';

const FIND_DEBOUNCE_MS = 300;

export function ChatFindBar() {
  const { t } = useI18n();
  const currentPath = useStore(s => s.currentSessionPath);
  const welcomeVisible = useStore(s => s.welcomeVisible);
  const findState = useStore(s => (
    currentPath ? sessionScopedValue(s, s.chatFindBySession, currentPath) : undefined
  ));
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'f') return;
      if (event.defaultPrevented) return; // preview 等更高优先级已消费
      const state = useStore.getState();
      const path = state.currentSessionPath;
      if (!path || state.welcomeVisible) return;
      event.preventDefault();
      state.openChatFind(path);
      // 已打开时重按 Cmd+F：重聚焦并全选现有词。首次打开时 input 尚未挂载，
      // 查不到即 no-op——由 ClassicFindBox 自身的 open 聚焦兜底。
      requestAnimationFrame(() => {
        const input = document.querySelector<HTMLInputElement>('[data-classic-find-input]');
        input?.focus();
        input?.select();
      });
    };
    window.addEventListener('keydown', onKeyDown); // bubble 阶段，preview 的 capture 拦截天然优先
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
  }, []);

  /** 若 debounce timer 在途则取消它；返回是否确实取消了一个在途 timer */
  const cancelPendingFind = useCallback((): boolean => {
    if (!debounceRef.current) return false;
    clearTimeout(debounceRef.current);
    debounceRef.current = null;
    return true;
  }, []);

  const handleQueryChange = useCallback((query: string) => {
    if (!currentPath) return;
    useStore.getState().setChatFindQuery(currentPath, query);
    cancelPendingFind();
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      void runChatFind(currentPath, query);
    }, FIND_DEBOUNCE_MS);
  }, [currentPath, cancelPendingFind]);

  if (!currentPath || welcomeVisible || !findState?.open) return null;

  const handleStep = (direction: 1 | -1) => {
    // Enter/按钮触发时 debounce 在途：flush 为立即查询（结果落地自动定位），
    // 本次不步进——步进的应是新结果集而非旧结果集。
    if (cancelPendingFind()) {
      void runChatFind(currentPath, findState.query);
      return;
    }
    stepChatFind(currentPath, direction);
  };

  const handleClose = () => {
    // 先取消在途查询，防止 close 之后 timer 触发重建幽灵状态
    cancelPendingFind();
    useStore.getState().closeChatFind(currentPath);
  };

  return (
    <div className={styles.chatFindBarHost}>
      <ClassicFindBox
        open
        query={findState.query}
        resultIndex={Math.max(0, findState.activePos)}
        resultCount={findState.total}
        placeholder={t('chat.find.placeholder')}
        onQueryChange={handleQueryChange}
        onPrevious={() => handleStep(-1)}
        onNext={() => handleStep(1)}
        onClose={handleClose}
      />
    </div>
  );
}
