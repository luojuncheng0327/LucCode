/**
 * stream-invalidator.ts — stream render / resume state 的注册桥接
 *
 * 打破循环依赖（chat-slice → use-stream-buffer → stores → chat-slice）：
 * use-stream-buffer / stream-resume 在模块加载时调 register*，
 * chat-slice 和 session-actions 通过纯函数入口触达 stream 状态，
 * 不反向 import 具体模块。
 *
 * 未注册时调用均 no-op，保证 store 的加载顺序不会导致崩溃。
 */

export interface StreamBufferSnapshot {
  hasContent: boolean;
  messageId: string | null;
  text: string;
  thinking: string;
  mood: string;
  moodYuan: string;
  inThinking: boolean;
  inMood: boolean;
}

type Invalidator = (sessionPath?: string) => void;
type Snapshotter = (sessionPath: string) => StreamBufferSnapshot | null;

let _invalidator: Invalidator | null = null;
let _resumeMetaInvalidator: Invalidator | null = null;
let _snapshotter: Snapshotter | null = null;

export function registerStreamBufferInvalidator(fn: Invalidator): void {
  _invalidator = fn;
}

export function registerStreamResumeMetaInvalidator(fn: Invalidator): void {
  _resumeMetaInvalidator = fn;
}

export function registerStreamBufferSnapshot(fn: Snapshotter): void {
  _snapshotter = fn;
}

/** 由 session 数据归属方调用：清除指定 session 的 streamBuffer 状态 */
export function invalidateStreamBuffer(sessionPath?: string): void {
  _invalidator?.(sessionPath);
}

/** 由 session 数据归属方调用：清除指定 session 的 resume seq/去重状态 */
export function invalidateStreamResumeMeta(sessionPath?: string): void {
  _resumeMetaInvalidator?.(sessionPath);
}

/** 读取当前 in-flight streamBuffer 的快照；无内容或未注册时返回 null */
export function snapshotStreamBuffer(sessionPath: string): StreamBufferSnapshot | null {
  return _snapshotter ? _snapshotter(sessionPath) : null;
}
