import type { JSONContent } from '@tiptap/core';

/**
 * 草稿变更通知通道：input-slice 是唯一收口点，持久化实现由
 * input-draft-persistence 在 app-init 时注册。未注册时为 no-op
 * （测试环境、server 未连接前的输入都安全）。
 */
export interface DraftSyncListener {
  onSet(key: string, text: string, doc: JSONContent | null): void;
  onClear(key: string): void;
}

let listener: DraftSyncListener | null = null;

export function registerDraftSyncListener(next: DraftSyncListener | null): void {
  listener = next;
}

export function notifyDraftSet(key: string, text: string, doc: JSONContent | null): void {
  listener?.onSet(key, text, doc);
}

export function notifyDraftCleared(key: string): void {
  listener?.onClear(key);
}
