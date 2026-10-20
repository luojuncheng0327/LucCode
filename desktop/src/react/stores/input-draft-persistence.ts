/**
 * 输入框草稿持久化（前端侧）
 *
 * 内存 zustand 是运行时唯一权威，server 是落盘影子：
 * - hydrateInputDrafts()：启动/恢复归档后拉全量，只填内存中不存在的键
 * - initInputDraftPersistence()：注册 input-draft-sync 监听，把 setDraft/clearDraft
 *   变更按 key 独立 debounce 后 PUT 到 /api/input-drafts
 * - session 身份始终使用 sessionId；兼容入口收到 sessionPath 时由 server 边界解析
 * - 服务端是持久真相，hydrate 不覆盖 renderer 内已经更新过的草稿
 */
import type { JSONContent } from '@tiptap/core';
import { lucFetch } from '../hooks/use-luc-fetch';
import { hasServerConnection } from '../services/server-connection';
import { useStore } from './index';
import { resolveWorkspaceUiSurface } from './workspace-ui-state-actions';
import { registerDraftSyncListener } from './input-draft-sync';
import { HOME_DRAFT_KEY } from '../../../../shared/input-drafts.ts';

const PUSH_DEBOUNCE_MS = 500;
const pushTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** 内存 map 的键要么是 sessionId，要么是老数据兜底的 sessionPath（含路径分隔符），要么是 __home__ */
function isPathLikeKey(key: string): boolean {
  return key.includes('/') || key.includes('\\');
}

async function pushDraft(key: string, text: string, doc: JSONContent | null): Promise<void> {
  const body: Record<string, unknown> = {
    surface: resolveWorkspaceUiSurface(),
    text,
    ...(doc ? { doc } : {}),
  };
  if (key === HOME_DRAFT_KEY) body.scope = 'home';
  else if (isPathLikeKey(key)) body.sessionPath = key;
  else body.sessionId = key;
  try {
    await lucFetch('/api/input-drafts', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    // 尽力而为的影子：失败不打断输入，下一次变更自然重试
    console.warn('[input-drafts] draft push failed:', err);
  }
}

function schedulePush(key: string, text: string, doc: JSONContent | null): void {
  if (!hasServerConnection(useStore.getState())) return;
  const existing = pushTimers.get(key);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    pushTimers.delete(key);
    void pushDraft(key, text, doc);
  }, PUSH_DEBOUNCE_MS);
  pushTimers.set(key, timer);
}

/** 拉全量草稿填充内存；内存已有的键以内存为准（用户可能已开始打字） */
export async function hydrateInputDrafts(): Promise<void> {
  if (!hasServerConnection(useStore.getState())) return;
  let data: any = null;
  try {
    const res = await lucFetch(`/api/input-drafts?surface=${resolveWorkspaceUiSurface()}`);
    data = await res.json().catch(() => null);
  } catch (err) {
    console.warn('[input-drafts] hydrate failed:', err);
    return;
  }
  if (!data || typeof data !== 'object') return;
  const current = useStore.getState();
  const drafts = { ...current.drafts };
  const draftDocs = { ...current.draftDocs };
  const applyEntry = (key: string, entry: any) => {
    if (!entry || typeof entry.text !== 'string' || !entry.text.trim()) return;
    if (Object.prototype.hasOwnProperty.call(drafts, key)) return;
    drafts[key] = entry.text;
    if (entry.doc && typeof entry.doc === 'object' && !Array.isArray(entry.doc)) {
      draftDocs[key] = entry.doc;
    }
  };
  if (data.home) applyEntry(HOME_DRAFT_KEY, data.home);
  for (const [sessionId, entry] of Object.entries(data.sessions || {})) {
    applyEntry(sessionId, entry);
  }
  useStore.setState({ drafts, draftDocs, draftsHydratedAt: Date.now() });
}

/** 注册草稿变更监听；在 app-init 早期调用一次 */
export function initInputDraftPersistence(): void {
  registerDraftSyncListener({
    onSet: (key, text, doc) => schedulePush(key, text, doc),
    onClear: (key) => schedulePush(key, '', null),
  });
}
