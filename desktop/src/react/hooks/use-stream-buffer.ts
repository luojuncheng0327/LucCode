/**
 * StreamBufferManager — per-session 流式事件节流缓冲
 *
 * WS 事件到达时写入 buffer（纯 JS 对象，不触发 React），
 * 每 FLUSH_INTERVAL ms 批量 flush 到 Zustand store。
 *
 * 设计为 singleton，不依赖 React 组件生命周期。
 * app-ws-shim 直接调用 streamBufferManager.handle(msg)。
 */

import type { ChatMessage, ContentBlock } from '../stores/chat-types';
import { useStore } from '../stores';
import { sessionScopedKey, sessionScopedValue } from '../stores/session-slice';
import { renderMarkdown } from '../utils/markdown';
import { cleanMoodText } from '../utils/message-parser';
import { findOpenToolIndex, toolCallFromStartEvent, toolCallIdFromEvent } from '../utils/tool-call-identity';
import {
  registerStreamBufferInvalidator,
  registerStreamBufferSnapshot,
  type StreamBufferSnapshot,
} from '../stores/stream-invalidator';
import { bumpMessageLiveVersion } from '../stores/message-live-version';

/* eslint-disable @typescript-eslint/no-explicit-any -- 流式消息 handle(msg) 接收动态 JSON */

const STREAM_FLUSH_FPS = 30;
const FLUSH_INTERVAL = Math.round(1000 / STREAM_FLUSH_FPS);
let streamMessageSeq = 0;
type InterludeContentBlock = Extract<ContentBlock, { type: 'interlude' }>;

function nextStreamMessageId(): string {
  streamMessageSeq = (streamMessageSeq + 1) % Number.MAX_SAFE_INTEGER;
  return `stream-${Date.now()}-${streamMessageSeq}`;
}

interface Buffer {
  sessionPath: string;
  textAcc: string;
  thinkingAcc: string;
  moodAcc: string;
  moodYuan: string;
  inThinking: boolean;
  hasThinkingBlock: boolean;
  inMood: boolean;
  inCard: boolean;
  cardAttrs: { type: string; plugin: string; route: string; title?: string } | null;
  cardDescAcc: string;
  lastFlushTime: number;
  flushTimer: ReturnType<typeof setTimeout> | null;
  /** 当前 turn 绑定的 assistant message id */
  messageId: string | null;
}

function createBuffer(sessionPath: string): Buffer {
  return {
    sessionPath,
    textAcc: '',
    thinkingAcc: '',
    moodAcc: '',
    moodYuan: 'luc',
    inThinking: false,
    hasThinkingBlock: false,
    inMood: false,
    inCard: false,
    cardAttrs: null,
    cardDescAcc: '',
    lastFlushTime: 0,
    flushTimer: null,
    messageId: null,
  };
}

function normalizeSessionId(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function bufferKeyForSession(sessionPath: string, sessionId: string | null = null): string {
  const explicitSessionId = normalizeSessionId(sessionId);
  if (explicitSessionId) return explicitSessionId;
  const state = useStore.getState();
  return sessionScopedKey(state, sessionPath) || sessionPath;
}

function resolveSessionYuan(sessionPath: string): string {
  const state = useStore.getState();
  const sessionAgentId = state.sessions.find((session: any) => session.path === sessionPath)?.agentId ?? null;
  if (!sessionAgentId) return 'luc';
  return state.agents.find((agent: any) => agent.id === sessionAgentId)?.yuan || 'luc';
}

class StreamBufferManager {
  private buffers = new Map<string, Buffer>();
  private bufferKeysByPath = new Map<string, string>();

  private adoptBufferKey(fromKey: string, toKey: string, buf: Buffer): void {
    if (fromKey === toKey) return;
    this.buffers.delete(fromKey);
    this.buffers.set(toKey, buf);
    for (const [pathKey, bufferKey] of this.bufferKeysByPath) {
      if (bufferKey === fromKey) this.bufferKeysByPath.set(pathKey, toKey);
    }
  }

  private deleteBufferKey(key: string): void {
    this.buffers.delete(key);
    for (const [pathKey, bufferKey] of [...this.bufferKeysByPath]) {
      if (bufferKey === key) this.bufferKeysByPath.delete(pathKey);
    }
  }

  private lookupBuffer(sessionPath: string, sessionId: string | null = null): Buffer | null {
    const key = bufferKeyForSession(sessionPath, sessionId);
    let buf = this.buffers.get(key) || null;
    if (buf) return buf;

    const aliasKey = this.bufferKeysByPath.get(sessionPath) || null;
    if (aliasKey) {
      buf = this.buffers.get(aliasKey) || null;
      if (buf) {
        this.adoptBufferKey(aliasKey, key, buf);
        this.bufferKeysByPath.set(sessionPath, key);
        return buf;
      }
    }

    if (key !== sessionPath) {
      buf = this.buffers.get(sessionPath) || null;
      if (buf) {
        this.adoptBufferKey(sessionPath, key, buf);
        this.bufferKeysByPath.set(sessionPath, key);
        return buf;
      }
    }

    return null;
  }

  /** 获取或创建 session buffer */
  private getBuffer(sessionPath: string, sessionId: string | null = null): Buffer {
    const key = bufferKeyForSession(sessionPath, sessionId);
    let buf = this.lookupBuffer(sessionPath, sessionId);
    if (!buf) {
      buf = createBuffer(sessionPath);
      this.buffers.set(key, buf);
    }
    buf.sessionPath = sessionPath;
    this.bufferKeysByPath.set(sessionPath, key);
    return buf;
  }

  private hasTurnState(buf: Buffer): boolean {
    return !!(
      buf.messageId ||
      buf.textAcc ||
      buf.thinkingAcc ||
      buf.hasThinkingBlock ||
      buf.moodAcc ||
      buf.inThinking ||
      buf.inMood ||
      buf.inCard ||
      buf.cardAttrs ||
      buf.cardDescAcc
    );
  }

  private resetTurnState(buf: Buffer): void {
    if (buf.flushTimer) {
      clearTimeout(buf.flushTimer);
      buf.flushTimer = null;
    }
    buf.textAcc = '';
    buf.thinkingAcc = '';
    buf.hasThinkingBlock = false;
    buf.moodAcc = '';
    buf.inThinking = false;
    buf.inMood = false;
    buf.inCard = false;
    buf.cardAttrs = null;
    buf.cardDescAcc = '';
    buf.messageId = null;
  }

  private finishBufferTurn(buf: Buffer): void {
    if (this.hasTurnState(buf)) {
      this.flush(buf);
    } else if (buf.flushTimer) {
      clearTimeout(buf.flushTimer);
      buf.flushTimer = null;
    }
    this.resetTurnState(buf);
  }

  /** 确保 store 中已存在当前 turn 绑定的 assistant message */
  private ensureMessage(buf: Buffer): void {
    const store = useStore.getState();
    const session = sessionScopedValue(store, store.chatSessions, buf.sessionPath);
    if (!session) return; // session 未初始化（loadMessages 尚未完成）

    const targetId = buf.messageId;
    const existing = targetId
      ? session.items.find((item) =>
        item.type === 'message' &&
        item.data.id === targetId &&
        item.data.role === 'assistant',
      )
      : null;
    if (existing) {
      buf.messageId = targetId;
      return;
    }

    const id = targetId || nextStreamMessageId();
    const msg: ChatMessage = { id, role: 'assistant', blocks: [], timestamp: Date.now() };
    store.appendItem(buf.sessionPath, { type: 'message', data: msg });
    bumpMessageLiveVersion(buf.sessionPath);
    buf.messageId = id;
  }

  private updateTargetMessage(buf: Buffer, updater: (msg: ChatMessage) => ChatMessage): void {
    this.ensureMessage(buf);
    if (!buf.messageId) return;
    const updated = useStore.getState().updateMessageById(buf.sessionPath, buf.messageId, updater);
    if (!updated) {
      console.warn('[stream] target assistant message missing after ensureMessage:', buf.sessionPath, buf.messageId);
      return;
    }
    bumpMessageLiveVersion(buf.sessionPath);
  }

  private appendInterlude(buf: Buffer, block: InterludeContentBlock): boolean {
    const consumed = useStore.getState().appendInterludeItem(buf.sessionPath, block);
    if (consumed) bumpMessageLiveVersion(buf.sessionPath);
    return consumed;
  }

  /** 调度节流 flush */
  private scheduleFlush(buf: Buffer): void {
    const now = Date.now();
    if (now - buf.lastFlushTime >= FLUSH_INTERVAL) {
      this.flush(buf);
    } else if (!buf.flushTimer) {
      buf.flushTimer = setTimeout(() => {
        buf.flushTimer = null;
        this.flush(buf);
      }, FLUSH_INTERVAL - (now - buf.lastFlushTime));
    }
  }

  /** 把 buffer 中累积的内容一次性 flush 到 Zustand */
  private flush(buf: Buffer): void {
    buf.lastFlushTime = Date.now();
    if (buf.flushTimer) {
      clearTimeout(buf.flushTimer);
      buf.flushTimer = null;
    }

    this.updateTargetMessage(buf, (msg) => {
      const blocks = [...(msg.blocks || [])];

      // ── Thinking ──
      if (buf.thinkingAcc || buf.hasThinkingBlock || buf.inThinking) {
        const idx = blocks.findIndex(b => b.type === 'thinking');
        const thinkingBlock: ContentBlock = {
          type: 'thinking',
          content: buf.thinkingAcc,
          sealed: !buf.inThinking,
        };
        if (idx >= 0) blocks[idx] = thinkingBlock;
        else blocks.unshift(thinkingBlock); // thinking 在最前面
      }

      // ── Mood ──
      if (buf.moodAcc || buf.inMood) {
        const idx = blocks.findIndex(b => b.type === 'mood');
        const moodBlock: ContentBlock = {
          type: 'mood',
          yuan: buf.moodYuan,
          text: buf.inMood ? buf.moodAcc : cleanMoodText(buf.moodAcc),
        };
        if (idx >= 0) blocks[idx] = moodBlock;
        else {
          // mood 在 thinking 后面
          const insertAt = blocks.findIndex(b => b.type !== 'thinking');
          blocks.splice(insertAt >= 0 ? insertAt : blocks.length, 0, moodBlock);
        }
      }

      // ── Text ──
      if (buf.textAcc) {
        const displayText = buf.textAcc.replace(/<tool_code>[\s\S]*?<\/tool_code>\s*/g, '');
        const html = renderMarkdown(displayText);
        const idx = blocks.findIndex(b => b.type === 'text');
        if (idx >= 0) {
          blocks[idx] = { type: 'text', html, source: displayText };
        } else {
          blocks.push({ type: 'text', html, source: displayText });
        }
      }

      return { ...msg, blocks };
    });
  }

  // ── 公开事件处理器 ──

  handle(msg: any): void {
    const sessionPath = msg.sessionPath;
    if (!sessionPath) {
      console.warn('[ws] stream event missing sessionPath:', msg.type);
      return;
    }
    const sessionId = normalizeSessionId(msg.sessionId);
    const buf = this.getBuffer(sessionPath, sessionId);

    switch (msg.type) {
      case 'text_delta':
        this.ensureMessage(buf);
        buf.textAcc += msg.delta || '';
        this.scheduleFlush(buf);
        break;

      case 'thinking_start':
        this.ensureMessage(buf);
        buf.inThinking = true;
        buf.hasThinkingBlock = true;
        buf.thinkingAcc = '';
        this.flush(buf);
        break;

      case 'thinking_delta':
        buf.hasThinkingBlock = true;
        buf.thinkingAcc += msg.delta || '';
        // 与 text/mood 共用时间节流，避免思考流只能在结束后显示。
        this.scheduleFlush(buf);
        break;

      case 'thinking_end':
        buf.hasThinkingBlock = true;
        buf.inThinking = false;
        this.flush(buf);
        break;

      case 'mood_start':
        this.ensureMessage(buf);
        buf.inMood = true;
        buf.moodAcc = '';
        buf.moodYuan = resolveSessionYuan(sessionPath);
        this.flush(buf);
        break;

      case 'mood_text':
        buf.moodAcc += msg.delta || '';
        this.scheduleFlush(buf);
        break;

      case 'mood_end':
        buf.inMood = false;
        this.flush(buf);
        break;

      case 'card_start':
        this.ensureMessage(buf);
        buf.inCard = true;
        buf.cardAttrs = msg.attrs || null;
        buf.cardDescAcc = '';
        break;

      case 'card_text':
        buf.cardDescAcc += msg.delta || '';
        break;

      case 'card_end': {
        buf.inCard = false;
        if (buf.cardAttrs) {
          this.flush(buf); // flush pending text first
          const card = {
            type: buf.cardAttrs.type || 'iframe',
            pluginId: buf.cardAttrs.plugin || '',
            route: buf.cardAttrs.route || '',
            title: buf.cardAttrs.title,
            description: buf.cardDescAcc,
          };
          this.updateTargetMessage(buf, (m) => ({
            ...m,
            blocks: [...(m.blocks || []), { type: 'plugin_card' as const, card }],
          }));
        }
        buf.cardAttrs = null;
        buf.cardDescAcc = '';
        break;
      }

      case 'tool_start':
        this.ensureMessage(buf);
        // 工具事件频率低，直接写 store
        this.flush(buf); // 先 flush 文本
        this.updateTargetMessage(buf, (m) => {
          const blocks = [...(m.blocks || [])];
          // 找最后一个 tool_group 或创建新的
          let lastTg = blocks.length - 1;
          while (lastTg >= 0 && blocks[lastTg].type !== 'tool_group') lastTg--;
          if (lastTg >= 0 && blocks[lastTg].type === 'tool_group') {
            const tg = blocks[lastTg] as Extract<ContentBlock, { type: 'tool_group' }>;
            // 如果上一个 group 里还有未完成的工具，追加到同一个 group
            if (tg.tools.some(t => !t.done)) {
              blocks[lastTg] = {
                ...tg,
                tools: [...tg.tools, toolCallFromStartEvent(msg)],
              };
              return { ...m, blocks };
            }
          }
          // 新建 tool_group
          blocks.push({
            type: 'tool_group',
            tools: [toolCallFromStartEvent(msg)],
            collapsed: false,
          });
          return { ...m, blocks };
        });
        break;

      case 'tool_end':
        this.updateTargetMessage(buf, (m) => {
          const blocks = [...(m.blocks || [])];
          // 从后往前找含该 tool 名且未 done 的
          for (let i = blocks.length - 1; i >= 0; i--) {
            if (blocks[i].type !== 'tool_group') continue;
            const tg = blocks[i] as Extract<ContentBlock, { type: 'tool_group' }>;
            const toolIdx = findOpenToolIndex(tg.tools, msg);
            if (toolIdx >= 0) {
              const tools = [...tg.tools];
              const id = toolCallIdFromEvent(msg);
              tools[toolIdx] = {
                ...tools[toolIdx],
                ...(id ? { id } : {}),
                done: true,
                success: !!msg.success,
                status: msg.status || (msg.success ? 'succeeded' : 'failed'),
                ...(typeof msg.error === 'string' && msg.error ? { error: msg.error } : {}),
                details: msg.details,
              };
              const allDone = tools.every(t => t.done);
              blocks[i] = { ...tg, tools, collapsed: allDone && tools.length > 1 };
              return { ...m, blocks };
            }
          }
          return m;
        });
        break;

      case 'content_block': {
        let block = msg.block;
        // Apply cached patches (block_update 可能先于 content_block 到达)
        if (block.taskId) {
          const pending = (useStore.getState() as any)._pendingBlockPatches;
          const cached = pending?.[block.taskId];
          if (cached) {
            block = { ...block, ...cached };
            delete pending[block.taskId];
          }
        }

        if (isInterludeBlock(block)) {
          if (this.hasTurnState(buf)) this.flush(buf);
          this.appendInterlude(buf, block);
          break;
        }

        const taskId = replacementTaskId(block);
        if (taskId) {
          if (this.hasTurnState(buf)) this.flush(buf);
          const consumed = useStore.getState().resolveBlockByTaskId(buf.sessionPath, taskId, block);
          if (consumed) {
            bumpMessageLiveVersion(buf.sessionPath);
            break;
          }
        }

        this.ensureMessage(buf);
        this.flush(buf);
        this.updateTargetMessage(buf, (m) => ({
          ...m,
          blocks: mergeContentBlock([...(m.blocks || [])], block),
        }));
        break;
      }

      case 'compaction_start':
        break;

      case 'compaction_end':
        break;

      case 'turn_end':
        useStore.getState().bindPersistedTurnEntries?.(buf.sessionPath, {
          turnInputEntryId: msg.turnInputEntryId,
          userEntryId: msg.userEntryId,
          assistantEntryId: msg.assistantEntryId,
          assistantMessageId: buf.messageId,
        });
        this.finishBufferTurn(buf);
        break;

    }
  }

  /** 服务端确认新 turn 开始：释放任何遗留的本地 turn 绑定。 */
  beginTurn(sessionPath: string, sessionId: string | null = null): void {
    const buf = this.getBuffer(sessionPath, sessionId);
    this.finishBufferTurn(buf);
  }

  /** 服务端确认当前 turn 结束或被中止：flush 可见内容，然后释放 turn-local 绑定。 */
  finishTurn(sessionPath: string, sessionId: string | null = null): void {
    const buf = this.lookupBuffer(sessionPath, sessionId);
    if (!buf) return;
    buf.sessionPath = sessionPath;
    this.finishBufferTurn(buf);
  }

  /** 清理指定 session 的 buffer */
  clear(sessionPath: string, sessionId: string | null = null): void {
    const key = bufferKeyForSession(sessionPath, sessionId);
    const aliasKey = this.bufferKeysByPath.get(sessionPath) || null;
    const buf = this.lookupBuffer(sessionPath, sessionId);
    if (buf?.flushTimer) clearTimeout(buf.flushTimer);
    this.deleteBufferKey(key);
    if (aliasKey && aliasKey !== key) this.deleteBufferKey(aliasKey);
    if (key !== sessionPath) this.deleteBufferKey(sessionPath);
  }

  /** 清理所有 */
  clearAll(): void {
    for (const [, buf] of this.buffers) {
      if (buf.flushTimer) clearTimeout(buf.flushTimer);
    }
    this.buffers.clear();
    this.bufferKeysByPath.clear();
  }

  /**
   * 取当前 buffer 的快照。供 loadMessages 在 session 重建后合并 in-flight
   * 内容：jsonl 只在 turn_end 落盘，在 stream 进行中重建 session 时，
   * 这份快照是避免 UI 上"正在流的消息凭空消失"的唯一来源。
   */
  snapshot(sessionPath: string, sessionId: string | null = null): StreamBufferSnapshot | null {
    const buf = this.lookupBuffer(sessionPath, sessionId);
    if (!buf) return null;
    const hasContent = !!(buf.textAcc || buf.thinkingAcc || buf.hasThinkingBlock || buf.moodAcc);
    if (!hasContent) return null;
    return {
      hasContent: true,
      messageId: buf.messageId,
      text: buf.textAcc,
      thinking: buf.thinkingAcc,
      mood: buf.inMood ? buf.moodAcc : cleanMoodText(buf.moodAcc),
      moodYuan: buf.moodYuan,
      inThinking: buf.inThinking,
      inMood: buf.inMood,
    };
  }
}

/** 全局 singleton */
export const streamBufferManager = new StreamBufferManager();

function mergeContentBlock(blocks: ContentBlock[], block: ContentBlock): ContentBlock[] {
  if (isInterludeBlock(block)) return blocks;
  if (block.type === 'media_generation' && block.status === 'pending') {
    const resolved = blocks.some((existing) => isResolvedTaskBlock(existing, block.taskId));
    if (resolved) return blocks;
  }
  const taskId = replacementTaskId(block);
  if (!taskId) return [...blocks, block];
  const idx = blocks.findIndex((existing) => (
    existing.type === 'media_generation' &&
    existing.taskId === taskId
  ));
  if (idx < 0) return [...blocks, block];
  const next = [...blocks];
  next[idx] = block;
  return next;
}

function replacementTaskId(block: ContentBlock): string | null {
  if (block.type === 'file') return block.replacesTaskId || null;
  if (block.type === 'media_generation' && block.status !== 'pending') return block.taskId;
  return null;
}

function isResolvedTaskBlock(block: ContentBlock, taskId: string): boolean {
  if (block.type === 'file') return block.replacesTaskId === taskId;
  return block.type === 'media_generation' &&
    block.taskId === taskId &&
    block.status !== 'pending';
}

function isInterludeBlock(block: ContentBlock): block is Extract<ContentBlock, { type: 'interlude' }> {
  return block.type === 'interlude';
}


// 让 chat-slice / session-actions 通过桥接模块触达 manager，打破循环依赖。
registerStreamBufferInvalidator((sessionPath) => {
  if (sessionPath == null) streamBufferManager.clearAll();
  else streamBufferManager.clear(sessionPath);
});
registerStreamBufferSnapshot((sessionPath) => streamBufferManager.snapshot(sessionPath));
