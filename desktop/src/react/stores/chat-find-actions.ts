/**
 * 会话内查找与 Session Bar 命中定位的编排动作。
 * 模式对齐 session-actions.ts：模块级 async 函数 + useStore.getState()。
 */
import { useStore } from './index';
import { lucFetch } from '../hooks/use-luc-fetch';
import { switchSession } from './session-actions';
import { sessionScopedValue } from './session-slice';
import type { ChatFindResults, ChatFindState } from './chat-find-slice';

function translate(key: string, fallback: string): string {
  const t = typeof window !== 'undefined' ? window.t : undefined;
  return t?.(key) || fallback;
}

function findStateFor(path: string): ChatFindState | undefined {
  const state = useStore.getState();
  return sessionScopedValue(state as Record<string, any>, state.chatFindBySession, path) as ChatFindState | undefined;
}

export async function fetchSessionFind(path: string, query: string): Promise<ChatFindResults | null> {
  try {
    const res = await lucFetch(
      `/api/sessions/find?path=${encodeURIComponent(path)}&q=${encodeURIComponent(query)}`,
    );
    const data = await res.json();
    if (!res.ok || data.error) {
      console.warn('[chat-find] find failed:', data.error || res.status);
      return null;
    }
    return {
      matches: Array.isArray(data.matches) ? data.matches : [],
      total: Number(data.total) || 0,
      tokens: Array.isArray(data.tokens) ? data.tokens : [],
      truncated: data.truncated === true,
      bestIndex: typeof data.bestIndex === 'number' ? data.bestIndex : null,
      revision: typeof data.revision === 'string' ? data.revision : null,
    };
  } catch (err) {
    console.warn('[chat-find] find request error:', err);
    return null;
  }
}

/**
 * 查找条输入驱动：查询当前 session 并写入结果，自动定位到最新命中。
 * 只负责查询与结果落地——query 状态由 UI 层（ChatFindBar）在输入时写入；
 * 若在这里写 query，close 之后到达的调用会经 EMPTY_FIND 兜底重建幽灵条目。
 */
export async function runChatFind(path: string, query: string): Promise<void> {
  const trimmed = query.trim();
  if (!trimmed) return;
  const results = await fetchSessionFind(path, trimmed);
  // 竞态护栏：查询已变化或查找条已关闭时丢弃结果
  const current = findStateFor(path);
  if (!current || !current.open || current.query.trim() !== trimmed) return;
  if (!results) {
    useStore.getState().setChatFindStatus(path, 'error');
    return;
  }
  useStore.getState().setChatFindResults(path, results);
  // 防切换窗口内 debounce 残留把陈旧定位意图种给已离开的会话
  if (useStore.getState().currentSessionPath !== path) return;
  const last = results.matches[results.matches.length - 1];
  if (last) {
    useStore.getState().requestMessageLocate({ sessionPath: path, messageIndex: last.index, term: trimmed });
  }
}

/** 查找条上一条/下一条（wrap 环回） */
export function stepChatFind(path: string, direction: 1 | -1): void {
  const current = findStateFor(path);
  if (!current || current.matches.length === 0) return;
  const count = current.matches.length;
  const base = current.activePos < 0 ? count - 1 : current.activePos;
  const next = (base + direction + count) % count;
  useStore.getState().setChatFindActivePos(path, next);
  const match = current.matches[next];
  useStore.getState().requestMessageLocate({
    sessionPath: path,
    messageIndex: match.index,
    term: current.query.trim(),
  });
}

/** Session Bar 内容命中点击：切 session + 定位最佳命中 + 打开查找条带入搜词 */
export async function locateSearchHit(path: string, query: string): Promise<void> {
  const trimmed = query.trim();
  if (!trimmed) {
    await switchSession(path);
    return;
  }
  const findPromise = fetchSessionFind(path, trimmed);
  await switchSession(path);
  if (useStore.getState().currentSessionPath !== path) return; // 切换失败或已被抢占
  const results = await findPromise;
  if (!results) {
    useStore.getState().addToast(
      translate('chat.find.locateFailed', '未能定位到该消息'),
      'error',
      4000,
    );
    return;
  }
  if (results.total === 0 || results.matches.length === 0) {
    console.warn('[chat-find] search hit but find returned empty:', path, trimmed);
    return;
  }
  useStore.getState().openChatFind(path, trimmed);
  useStore.getState().setChatFindResults(path, results);
  const bestPos = results.bestIndex != null
    ? results.matches.findIndex((m) => m.index === results.bestIndex)
    : -1;
  const exactPos = results.matches.findIndex((m) => m.exact);
  const pos = bestPos >= 0 ? bestPos : (exactPos >= 0 ? exactPos : 0);
  useStore.getState().setChatFindActivePos(path, pos);
  useStore.getState().requestMessageLocate({
    sessionPath: path,
    messageIndex: results.matches[pos].index,
    term: trimmed,
  });
}
