/**
 * chat-types.ts — 聊天消息数据模型
 *
 * 历史消息和流式消息共用同一套类型。
 * ContentBlock 按展示顺序排列（thinking → mood → tools → text），
 * 不按流式到达顺序。
 */

import type { FileVersion } from '../types';
import type { ThinkingLevel } from './model-slice';

// ── 工具调用 ──

export interface ToolCall {
  id?: string;
  name: string;
  args?: Record<string, unknown>;
  done: boolean;
  success: boolean;
  status?: 'running' | 'succeeded' | 'failed' | 'unknown';
  error?: string;
  details?: { card?: import('../types').PluginCardDetails; [key: string]: unknown };
}

// ── 用户附件 ──

export interface UserAttachment {
  fileId?: string;
  path: string;
  name: string;
  isDir: boolean;
  base64Data?: string;
  mimeType?: string;
  presentation?: 'attachment' | 'voice-input' | string;
  listed?: boolean;
  status?: 'available' | 'expired' | string;
  missingAt?: number | null;
  visionAuxiliary?: boolean;
  transcription?: VoiceTranscription;
  waveform?: AudioWaveform;
}

export interface AudioWaveform {
  version: 1;
  peaks: number[];
  durationMs?: number;
  source?: 'computed' | 'fallback';
}

export interface VoiceTranscription {
  status: 'pending' | 'ready' | 'failed';
  text?: string;
  providerId?: string;
  modelId?: string;
  protocolId?: string;
  language?: string;
  durationMs?: number;
  error?: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface AgentReviewContext {
  requestId?: string | null;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  reviewedSessionId?: string | null;
  reviewerSessionId?: string | null;
  reviewerAgentId: string;
  reviewerAgentName: string;
  text?: string | null;
  error?: string | null;
  completedAt?: string | null;
}

export interface AgentReviewRequestContext {
  requestId?: string | null;
  reviewedSessionId: string;
  reviewerAgentId: string;
  reviewerAgentName: string;
}

export interface DeskContext {
  dir: string;
  fileCount: number;
}

export interface SessionRegistryFile {
  id?: string;
  fileId?: string;
  sessionPath?: string;
  filePath?: string;
  realPath?: string;
  legacyFileIds?: string[];
  legacyFilePaths?: string[];
  label?: string;
  displayName?: string;
  filename?: string;
  ext?: string;
  mime?: string;
  kind?: string;
  storageKind?: string;
  presentation?: 'attachment' | 'voice-input' | string;
  listed?: boolean;
  status?: 'available' | 'expired' | string;
  missingAt?: number | null;
  origin?: string;
  operations?: string[];
  createdAt?: number;
  mtimeMs?: number;
  size?: number | null;
  version?: FileVersion | null;
  isDirectory?: boolean;
  resource?: ResourceEnvelope;
  transcription?: VoiceTranscription;
  waveform?: AudioWaveform;
}

export interface ResourceEnvelope {
  schemaVersion: 1;
  resourceId: string;
  name: string;
  studioId: string;
  type: 'file' | string;
  source: 'session_file' | string;
  sourceId?: string;
  fileId?: string;
  displayName?: string;
  filename?: string;
  ext?: string | null;
  mime?: string;
  size?: number | null;
  kind?: string;
  isDirectory?: boolean;
  origin?: string;
  operations?: string[];
  createdAt?: number | string;
  mtimeMs?: number;
  lifecycle: {
    status: 'available' | 'expired' | string;
    missingAt: number | string | null;
  };
  storage: {
    provider: 'session_file' | string;
    storageKind?: string;
    localOnly?: boolean;
  };
  links: {
    self: string;
    content?: string;
  };
}

// ── 内容块 ──

export interface SessionConfirmationBlock {
  type: 'session_confirmation';
  confirmId: string;
  kind: string;
  surface: 'input' | 'message';
  status: 'pending' | 'confirmed' | 'rejected' | 'timeout' | 'aborted';
  title: string;
  body?: string;
  subject?: {
    label: string;
    detail?: string;
  };
  severity?: 'normal' | 'elevated' | 'danger';
  actions?: {
    confirmLabel?: string;
    rejectLabel?: string;
  };
  payload?: Record<string, unknown>;
}

export interface SettingsUpdateChange {
  key: string;
  label: string;
  before: string;
  after: string;
  sensitive?: boolean;
}

export interface SettingsUpdatePayload {
  status: 'applied' | 'failed' | 'skipped' | 'needs_action' | string;
  action: string;
  key: string;
  title: string;
  summary: string;
  target?: {
    type?: string;
    id?: string | null;
    label?: string | null;
  };
  changes?: SettingsUpdateChange[];
}

export interface SuggestionCardBlock {
  type: 'suggestion_card';
  kind: 'automation_draft' | string;
  confirmId?: string;
  suggestionId?: string;
  suggestionShortCode?: string;
  operation?: 'create' | 'update' | string;
  status: 'pending' | 'approved' | 'rejected' | string;
  title: string;
  description?: string;
  target?: {
    type?: string;
    id?: string | null;
    label?: string | null;
  };
  detail?: {
    kind?: string;
    operation?: 'create' | 'update' | string;
    jobData?: Record<string, unknown>;
    [key: string]: unknown;
  };
  actions?: Array<{
    id?: string;
    kind?: string;
    label?: string;
  }>;
}

// 物种 A：文本装饰器（流式组装，upsert 到 blocks 数组）
export type TextDecorator =
  | { type: 'thinking'; content: string; sealed: boolean }
  | { type: 'mood'; yuan: string; text: string }
  | { type: 'tool_group'; tools: ToolCall[]; collapsed: boolean }
  | { type: 'text'; html: string; source?: string };

// 物种 B：富内容块（通过 content_block 事件 push，不 upsert）
export type RichBlock =
  | { type: 'file'; fileId?: string; filePath: string; label: string; ext: string; mime?: string; kind?: string; storageKind?: string; presentation?: 'attachment' | 'voice-input' | string; listed?: boolean; status?: 'available' | 'expired' | string; missingAt?: number | null; resource?: ResourceEnvelope; mtimeMs?: number; size?: number | null; version?: FileVersion | null; waveform?: AudioWaveform; replacesTaskId?: string }
  | { type: 'media_generation'; taskId: string; kind: 'image' | 'video' | string; status: 'pending' | 'failed' | 'aborted' | string; prompt?: string; batchId?: string; reason?: string }
  // COMPAT(create_artifact, remove no earlier than v0.133 after legacy sessions are migrated)
  | { type: 'artifact'; artifactId: string; artifactType: string; title: string; content: string; language?: string | null; fileId?: string; filePath?: string; label?: string; ext?: string; mime?: string; kind?: string; storageKind?: string; presentation?: 'attachment' | 'voice-input' | string; listed?: boolean; status?: 'available' | 'expired' | string; missingAt?: number | null; resource?: ResourceEnvelope; mtimeMs?: number; size?: number | null; version?: FileVersion | null }
  | { type: 'screenshot'; base64: string; mimeType: string }
  | { type: 'skill'; skillName: string; skillFilePath: string; fileId?: string; installedFile?: Record<string, unknown>; installedSkillSource?: Record<string, unknown> }
  | { type: 'cron_confirm'; confirmId?: string; jobData: Record<string, unknown>; status: 'pending' | 'approved' | 'rejected' }
  | SuggestionCardBlock
  | { type: 'settings_confirm'; confirmId?: string; settingKey: string; cardType: 'toggle' | 'list' | 'text'; currentValue: string; proposedValue: string; options?: string[]; optionLabels?: Record<string, string>; label: string; description?: string; frontend?: boolean; status: 'pending' | 'confirmed' | 'rejected' | 'timeout' }
  | { type: 'settings_update'; update: SettingsUpdatePayload }
  | SessionConfirmationBlock
  | {
    type: 'interlude';
    id: string;
    deliveryId?: string;
    variant: 'deferred_result' | string;
    timelinePlacement?: 'after_anchor_message' | string;
    taskId?: string;
    status?: 'success' | 'failed' | 'aborted' | string;
    sourceKind?: 'subagent' | 'workflow' | 'tool' | string;
    sourceLabel?: string;
    previewSessionId?: string;
    previewSessionPath?: string;
    previewAgentId?: string;
    text: string;
    detailMarkdown?: string;
  }
  | {
    type: 'subagent';
    taskId: string;
    task: string;
    taskTitle: string;
    agentId?: string;
    agentName?: string;
    requestedAgentId?: string;
    requestedAgentName?: string;
    executorAgentId?: string;
    executorAgentNameSnapshot?: string;
    sessionId?: string | null;
    streamKey: string;
    streamStatus: 'running' | 'done' | 'failed' | 'aborted';
    summary?: string;
    label?: string | null;
    reuseInstance?: string | null;
  }
  | {
    // workflow inline 概览块（聊天流工具卡）：只携带「名 + 状态 + 时长」，不展开实时流。
    type: 'workflow';
    taskId: string;
    taskTitle: string;
    streamStatus: 'running' | 'done' | 'failed' | 'aborted';
    summary?: string;
    startedAt?: number | null;
    finishedAt?: number | null;
  }
  | { type: 'plugin_card'; card: import('../types').PluginCardDetails }
  | { type: 'interactive_card'; cardId: string; title: string; code: string };

export type ContentBlock = TextDecorator | RichBlock;

// ── 消息 ──

export interface ChatMessage {
  id: string;              // UI message id；本地发送的 user message 可先使用 clientMessageId
  sourceEntryId?: string;  // Pi SDK session entry id，用于 branch-aware 的重新生成/编辑
  /** 本次 Agent turn 的真实输入 entry；隐藏后台输入也必须保留，不能猜到最近可见 user。 */
  turnInputEntryId?: string;
  /** false 表示真实 turn input 只用于模型上下文，不对应可见用户节点。 */
  turnInputVisible?: boolean;
  role: 'user' | 'assistant';
  // User
  text?: string;
  textHtml?: string;
  quotedText?: string;
  attachments?: UserAttachment[];
  deskContext?: DeskContext | null;
  skills?: string[];
  sessionRefs?: Array<{ sessionId: string; label: string }>;
  agentMentions?: Array<{ agentId: string; label: string }>;
  agentReview?: AgentReviewContext;
  agentReviewRequest?: AgentReviewRequestContext;
  sendStatus?: 'pending' | 'failed';
  sendError?: string;
  /** 非用户本人发出的消息来源（如别的 Agent 经跨 session 协作投递）。老数据无此字段，按普通用户消息渲染。 */
  origin?: { kind: 'agent'; agentId: string | null; agentName: string | null };
  // Assistant
  blocks?: ContentBlock[];
  // 通用
  timestamp?: number;
}

// ── Virtuoso 列表项 ──

export type ChatListItem =
  | { type: 'message'; data: ChatMessage }
  | { type: 'interlude'; id: string; data: Extract<ContentBlock, { type: 'interlude' }> }
  | { type: 'compaction'; id: string; yuan: string };

// ── Per-session 模型快照 ──
// 挂在 chat-slice 的 sessionModelsByPath keyed map 上，
// 与消息缓存 SessionMessages 解耦：模型信息可以在消息还没加载时独立写入，
// 不会因为在 chatSessions 里创建 stub 而骗过"是否已加载"的判据（issue #405）。

export interface SessionModel {
  id: string;
  name: string;
  provider: string;
  /** 输入模态数组（Pi SDK 标准字段），镜像后端 /models, /models/switch 响应；音频走 Luc 兼容能力字段。 */
  input?: ("text" | "image" | "video" | "audio")[];
  video?: boolean;
  videoTransport?: string | null;
  videoTransportSupported?: boolean;
  audio?: boolean;
  audioTransport?: string | null;
  audioTransportSupported?: boolean;
  reasoning?: boolean;
  xhigh?: boolean;
  thinkingLevels?: ThinkingLevel[];
  defaultThinkingLevel?: ThinkingLevel;
  contextWindow?: number;
  /** Historical sessions can remain readable while their exact model is no longer executable. */
  available?: boolean;
  unavailableReason?: 'model_removed' | 'provider_not_configured' | 'temporarily_unavailable' | null;
}

// ── Per-session 消息状态 ──
// entry 存在 ⟺ 消息状态已初始化（initSession 调用过）。
// 不要为了存别的东西（例如模型快照）就写 stub 进来——会把这个语义打破。

export interface SessionMessages {
  items: ChatListItem[];
  hasMore: boolean;
  loadingMore: boolean;
  oldestId?: string;
  /**
   * hydrate 时服务端返回的磁盘修订点（stat 签名）。
   * null = 未知（如 WS 端为新会话 initSession 的空状态，或服务端 stat 失败）。
   * reconcileCurrentSessionMessages 用它与 /api/sessions 列表投影的 revision
   * 对比，决定是否补拉离线窗口（/rc 接管等）漏掉的消息（issue #1610）。
   */
  revision?: string | null;
}

// ── 流式缓冲（不入 Zustand） ──

export interface StreamBuffer {
  sessionPath: string;
  textAcc: string;
  thinkingAcc: string;
  moodAcc: string;
  moodYuan: string;
  inThinking: boolean;
  inMood: boolean;
  lastFlushTime: number;
}
