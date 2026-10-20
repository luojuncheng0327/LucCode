/**
 * SessionTodoCard — 右侧「进程」卡（最高优先级，置顶任务区）
 *
 * 展示当前对话的 keyed todos。无 todo / 无对话时返回 null。
 */
import { useEffect, useRef, useState } from 'react';
import { useStore } from '../../stores';
import { completeSessionTodos } from '../../stores/session-actions';
import { sessionScopedListIncludes, sessionScopedValue } from '../../stores/session-slice';
import type { TodoItem, TodoStatus } from '../../types';
import styles from './SessionTodoCard.module.css';

const EMPTY_TODOS: TodoItem[] = [];

const STATUS_TEXT: Partial<Record<TodoStatus, string>> = {
  pending: '○',
  completed: '✓',
};

function InProgressIcon() {
  return (
    <svg className={styles.inProgressIcon} width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M21 3v5m0 0h-5m5 0-3-2.708A9 9 0 1 0 20.777 14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function displayText(todo: TodoItem): string {
  if (todo.status === 'in_progress' && todo.activeForm) return todo.activeForm;
  return todo.content || todo.activeForm || '';
}

function CheckIcon() {
  return (
    <svg className={styles.actionIcon} width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M20 6L9 17l-5-5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function SessionTodoCard() {
  const mountedRef = useRef(true);
  const [completing, setCompleting] = useState(false);
  const sessionPath = useStore((s) => s.currentSessionPath);
  const todos = useStore((s) => {
    const path = s.currentSessionPath;
    return path ? (sessionScopedValue(s, s.todosBySession, path) ?? EMPTY_TODOS) : EMPTY_TODOS;
  });
  const streaming = useStore((s) => {
    const path = s.currentSessionPath;
    return sessionScopedListIncludes(s, s.streamingSessions, path);
  });
  const t = window.t ?? ((k: string) => k);

  useEffect(() => () => {
    mountedRef.current = false;
  }, []);

  if (!sessionPath || !todos.length) return null;

  const done = todos.filter((td) => td.status === 'completed').length;
  const actionDisabled = completing || streaming;

  async function handleCompleteAll() {
    if (actionDisabled || !sessionPath) return;
    setCompleting(true);
    try {
      await completeSessionTodos(sessionPath);
    } finally {
      if (mountedRef.current) setCompleting(false);
    }
  }

  return (
    <section className={`universal-card ${styles.card}`} aria-label={t('rightWorkspace.todo.title')}>
      <div className={styles.header}>
        <span className={styles.title}>{t('rightWorkspace.todo.title')}</span>
        <span className={styles.count}>{done}/{todos.length}</span>
      </div>
      <div className={styles.list}>
        {todos.map((td, i) => (
          <div key={`todo-${i}`} className={styles.row} data-status={td.status}>
            <span className={styles.icon} aria-hidden="true">
              {td.status === 'in_progress' ? <InProgressIcon /> : STATUS_TEXT[td.status]}
            </span>
            <span className={styles.text}>{displayText(td)}</span>
          </div>
        ))}
      </div>
      <button
        className={styles.completeButton}
        type="button"
        onClick={handleCompleteAll}
        disabled={actionDisabled}
        aria-label={t('common.markAllComplete')}
        title={streaming ? t('rightWorkspace.todo.waitForOutput') : t('common.markAllComplete')}
      >
        <CheckIcon />
        <span>{t('common.markAllComplete')}</span>
      </button>
    </section>
  );
}
