/**
 * history-builder.ts — 将 /api/sessions/messages 的 API 响应转换为 ChatListItem[]
 *
 * 替代 app-messages-shim.ts loadMessages() 中的 DOM 构建循环。
 */

import type {
  ChatMessage,
  ChatListItem,
  ContentBlock,
  SessionRegistryFile,
  UserAttachment,
} from '../stores/chat-types';
import type { TodoItem } from '../types';
import { parseUserAttachments } from './message-parser';
import { renderMarkdown } from './markdown';
import { extOfName } from './file-kind';
import { buildAssistantBlocksFromContent } from './assistant-block-builder';

/* eslint-disable @typescript-eslint/no-explicit-any -- API 历史消息 JSON 结构动态，难以静态收窄 */

const LEGACY_STEER_PREFIX_RE = /^(?:（插话，无需 MOOD）|\(Interjection, no MOOD needed\))\n?/;
const MEDIA_ONLY_PLACEHOLDER_TEXT = new Set([
  '(看图)',
  '（看图）',
  '(view image)',
  '（看圖）',
  '（画像を見る）',
  '(이미지 보기)',
  '(看视频)',
  '（看视频）',
  '(view video)',
  '（看影片）',
  '（動画を見る）',
  '(비디오 보기)',
  '(听音频)',
  '（听音频）',
  '(listen to audio)',
  '（聽音訊）',
  '（音声を聞く）',
  '(오디오 듣기)',
]);

// 历史里可能残留 provider/model 边界注入的图片尺寸提示。
// 这类 <file name="image-N"> 行只服务于模型坐标换算，不属于用户输入的可见正文。
const LEGACY_IMAGE_DIMENSION_NOTE_LINE_RE =
  /^<file name="image-\d+">\[Image: original \d+x\d+, displayed at \d+x\d+\. Multiply coordinates by \d+(?:\.\d+)? to map to original image\.\]<\/file>$/;

// ── API 响应类型 ──

export interface HistoryApiResponse {
  messages: Array<{
    id?: string;
    entryId?: string;
    role: string;
    content: string;
    thinking?: string;
    toolCalls?: Array<{
      id?: string;
      toolCallId?: string;
      name: string;
      args?: Record<string, unknown>;
      status?: 'succeeded' | 'failed' | 'unknown';
      success?: boolean;
      error?: string;
    }>;
    images?: Array<{ data: string; mimeType: string }>;
    timestamp?: number | string | null;
    sourceIndex?: number;
    turnInputEntryId?: string;
    turnInputVisible?: boolean;
    agentReview?: import('../stores/chat-types').AgentReviewContext;
    agentReviewRequest?: import('../stores/chat-types').AgentReviewRequestContext;
    sessionRefs?: Array<{ sessionId: string; label: string }>;
    agentMentions?: Array<{ agentId: string; label: string }>;
    displayText?: string;
  }>;
  sessionFiles?: SessionRegistryFile[];
  blocks?: Array<any>;
  // COMPAT(v0.98/v0.127, remove no earlier than v0.133):
  // 以下三个老字段在新服务端不再返回；其中 artifacts 仅保留为旧 session 恢复协议。
  fileOutputs?: Array<{
    afterIndex: number;
    files: Array<{ fileId?: string; filePath: string; label: string; ext: string; mime?: string; kind?: string; storageKind?: string; presentation?: string; listed?: boolean; status?: string; missingAt?: number | null }>;
  }>;
  artifacts?: Array<{
    afterIndex: number;
    artifactId: string;
    artifactType: string;
    title: string;
    content: string;
    language?: string;
    fileId?: string;
    filePath?: string;
    label?: string;
    ext?: string;
    mime?: string;
    kind?: string;
    storageKind?: string;
    presentation?: string;
    listed?: boolean;
    status?: string;
    missingAt?: number | null;
  }>;
  cards?: Array<{
    afterIndex: number;
    card: { type: string; pluginId: string; route: string; title?: string; description?: string };
  }>;
  todos?: TodoItem[];
  hasMore?: boolean;
}

// ── 兼容层 ──

/**
 * COMPAT(v0.98/v0.127, remove no earlier than v0.133):
 * 旧历史消息兼容层，可在确认老 session 已完成迁移后整个删除。
 *
 * 将老格式（fileOutputs/artifacts/cards）转为新 blocks[] 格式。
 * 新服务端返回 blocks[]，此函数只在升级过渡期（老服务端 → 新前端）命中。
 * 如果没有 data.blocks，还需从 toolCalls 重建 cron/settings 确认卡片，
 * 因为老 session 的 toolResult.details 没有 jobData/settingKey 字段。
 */
function normalizeBlocks(data: HistoryApiResponse): Array<any> {
  if (data.blocks) return data.blocks.map(normalizeHistoryBlock).filter((block): block is Record<string, any> => !!block);
  const blocks: Array<any> = [];
  for (const fo of (data.fileOutputs || [])) {
    for (const f of fo.files) {
      blocks.push({ type: 'file', afterIndex: fo.afterIndex, ...f });
    }
  }
  for (const ar of (data.artifacts || [])) {
    const { afterIndex, ...artifact } = ar;
    blocks.push({ type: 'artifact', afterIndex, ...artifact });
  }
  for (const cd of (data.cards || [])) {
    blocks.push({ type: 'plugin_card', afterIndex: cd.afterIndex, card: { ...cd.card, type: cd.card.type || 'iframe' } });
  }

  // COMPAT: 从 toolCalls 重建 cron/settings 确认卡片（仅老 session 无 blocks[] 时）
  for (let i = 0; i < (data.messages || []).length; i++) {
    const m = data.messages[i];
    if (m.role !== 'assistant' || !m.toolCalls) continue;
    for (const tc of m.toolCalls) {
      if (tc.name === 'update_settings' && tc.args) {
        const a = tc.args as Record<string, string>;
        if (a.action === 'apply' || (!a.action && a.key && a.value)) {
          blocks.push({
            type: 'settings_confirm',
            afterIndex: i,
            confirmId: '',
            settingKey: a.key || '',
            cardType: (a.key === 'sandbox' || a.key === 'memory.enabled') ? 'toggle' : 'list',
            currentValue: '',
            proposedValue: a.value || '',
            label: a.key || '',
            status: 'confirmed',
          });
        }
      }
      if (tc.name === 'cron' && tc.args) {
        const a = tc.args as Record<string, any>;
        if (a.action === 'add') {
          blocks.push({
            type: 'cron_confirm',
            afterIndex: i,
            confirmId: '',
            jobData: { type: a.type, schedule: a.schedule, prompt: a.prompt, label: a.label },
            status: 'approved',
          });
        }
      }
    }
  }

  return blocks;
}

function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? value : null;
}

function normalizeBlockAfterIndex(value: unknown): number | null {
  return Number.isInteger(value) && (value as number) >= 0 ? value as number : null;
}

function basenamePortable(value: string): string {
  const normalized = value.replace(/\\/g, '/');
  const slash = normalized.lastIndexOf('/');
  return slash >= 0 ? normalized.slice(slash + 1) : normalized;
}

function normalizePathKey(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.replace(/\\/g, '/');
}

function sessionFileIdLookupKey(fileId: unknown): string | null {
  if (typeof fileId !== 'string') return null;
  const trimmed = fileId.trim();
  return trimmed ? `session-file:${trimmed}` : null;
}

function buildSessionFileLookup(sessionFiles: unknown): Map<string, SessionRegistryFile> {
  const lookup = new Map<string, SessionRegistryFile>();
  if (!Array.isArray(sessionFiles)) return lookup;
  for (const file of sessionFiles) {
    if (!isRecord(file)) continue;
    const record = file as SessionRegistryFile;
    const keys = [
      sessionFileIdLookupKey(record.fileId),
      sessionFileIdLookupKey(record.id),
      ...(record.legacyFileIds || []).map(sessionFileIdLookupKey),
      normalizePathKey(record.filePath),
      normalizePathKey(record.realPath),
      ...(record.legacyFilePaths || []).map(normalizePathKey),
      normalizePathKey(record.resource?.links?.content),
      normalizePathKey(record.resource?.links?.self),
    ].filter((key): key is string => !!key);
    for (const key of keys) {
      if (!lookup.has(key)) lookup.set(key, record);
    }
  }
  return lookup;
}

// 历史 marker 只表达“这条消息引用了哪个文件”。展示名、mime、生命周期状态
// 必须来自 SessionFile 账本；账本不存在时才退回 marker path 的 basename。
function displayNameForSessionFile(file: SessionRegistryFile | null | undefined, fallbackPath: string): string {
  if (file?.displayName) return file.displayName;
  if (file?.label) return file.label;
  if (file?.filename) return file.filename;
  return basenamePortable(fallbackPath);
}

function presentationForSessionFile(file: SessionRegistryFile | null | undefined, fallback?: Partial<UserAttachment>): string {
  if (file?.presentation === 'voice-input' || fallback?.presentation === 'voice-input') return 'voice-input';
  return 'attachment';
}

function listedForSessionFile(file: SessionRegistryFile | null | undefined, fallback?: Partial<UserAttachment>): boolean {
  if (typeof file?.listed === 'boolean') return file.listed;
  if (typeof fallback?.listed === 'boolean') return fallback.listed;
  return presentationForSessionFile(file, fallback) !== 'voice-input';
}

function attachmentFromRef(
  ref: { path: string; name: string; isDirectory?: boolean; fileId?: string },
  sessionFileLookup: Map<string, SessionRegistryFile>,
  fallback?: Partial<UserAttachment>,
): UserAttachment {
  const sessionFile = (ref.fileId ? sessionFileLookup.get(sessionFileIdLookupKey(ref.fileId) || '') : null)
    ?? (fallback?.fileId ? sessionFileLookup.get(sessionFileIdLookupKey(fallback.fileId) || '') : null)
    ?? sessionFileLookup.get(normalizePathKey(ref.path) || '');
  const fileId = sessionFile?.fileId || sessionFile?.id || ref.fileId || fallback?.fileId;
  const filePath = sessionFile?.filePath || sessionFile?.realPath || fallback?.path || ref.path;
  const mimeType = sessionFile?.mime || fallback?.mimeType;
  const status = sessionFile?.status || fallback?.status;
  const hasMissingAt = !!sessionFile && Object.prototype.hasOwnProperty.call(sessionFile, 'missingAt')
    ? true
    : !!fallback && Object.prototype.hasOwnProperty.call(fallback, 'missingAt');
  const missingAt = !!sessionFile && Object.prototype.hasOwnProperty.call(sessionFile, 'missingAt')
    ? sessionFile.missingAt
    : fallback?.missingAt;
  const presentation = presentationForSessionFile(sessionFile, fallback);
  const listed = listedForSessionFile(sessionFile, fallback);
  const transcription = sessionFile?.transcription || fallback?.transcription;
  const waveform = sessionFile?.waveform || fallback?.waveform;
  return {
    ...(fileId ? { fileId } : {}),
    path: filePath,
    name: displayNameForSessionFile(sessionFile, fallback?.name || ref.path || ref.name),
    isDir: sessionFile?.isDirectory ?? ref.isDirectory ?? false,
    ...(mimeType ? { mimeType } : {}),
    ...(presentation !== 'attachment' ? { presentation } : {}),
    ...(listed === false ? { listed } : {}),
    ...(status ? { status } : {}),
    ...(hasMissingAt ? { missingAt } : {}),
    ...(transcription ? { transcription } : {}),
    ...(waveform ? { waveform } : {}),
  };
}

type SessionFileMarkerRef = { fileId: string; sessionPath?: string; label: string; kind: string };

function markerMatchesAttachment(marker: SessionFileMarkerRef, ref: { path: string; name: string; isDirectory?: boolean }): boolean {
  if (marker.kind === 'directory' && !ref.isDirectory) return false;
  if (marker.kind !== 'directory' && ref.isDirectory) return false;
  return marker.label === ref.path || marker.label === ref.name;
}

function consumeSessionFileMarkerForAttachment(
  markers: SessionFileMarkerRef[],
  consumed: Set<number>,
  ref: { path: string; name: string; isDirectory?: boolean },
): SessionFileMarkerRef | null {
  for (let index = 0; index < markers.length; index += 1) {
    if (consumed.has(index)) continue;
    const marker = markers[index];
    if (!markerMatchesAttachment(marker, ref)) continue;
    consumed.add(index);
    return marker;
  }
  return null;
}

function normalizeUserVisibleText(text: string, hasMediaAttachment: boolean): string {
  if (!hasMediaAttachment) return text;
  const withoutLegacyImageNotes = text
    .split(/\r?\n/)
    .filter(line => !LEGACY_IMAGE_DIMENSION_NOTE_LINE_RE.test(line.trim()))
    .join('\n')
    .trim();
  const trimmed = withoutLegacyImageNotes.trim();
  if (!trimmed) return '';
  return MEDIA_ONLY_PLACEHOLDER_TEXT.has(trimmed) ? '' : withoutLegacyImageNotes;
}

function normalizeHistoryBlock(raw: unknown): Record<string, any> | null {
  if (!isRecord(raw)) return null;
  const type = nonEmptyString(raw.type);
  const afterIndex = normalizeBlockAfterIndex(raw.afterIndex);
  if (!type || afterIndex === null) return null;

  if (type === 'file') {
    const filePath = nonEmptyString(raw.filePath);
    if (!filePath) return null;
    const label = nonEmptyString(raw.label) || basenamePortable(filePath);
    const ext = nonEmptyString(raw.ext) || extOfName(label) || extOfName(filePath) || '';
    return { ...raw, type, afterIndex, filePath, label, ext };
  }

  if (type === 'plugin_card') {
    if (!isRecord(raw.card)) return null;
    const pluginId = nonEmptyString(raw.card.pluginId);
    if (!pluginId) return null;
    const cardType = nonEmptyString(raw.card.type) || 'iframe';
    if (cardType === 'chat.surface') {
      const rawSessionRef = isRecord(raw.card.sessionRef) ? raw.card.sessionRef : {};
      const sessionId = nonEmptyString(raw.card.sessionId) || nonEmptyString(rawSessionRef.sessionId);
      if (!sessionId) return null;
      const sessionPath = nonEmptyString(raw.card.sessionPath)
        || nonEmptyString(rawSessionRef.sessionPath)
        || nonEmptyString(rawSessionRef.path)
        || null;
      const sessionRef = {
        ...rawSessionRef,
        sessionId,
        ...(sessionPath ? { sessionPath } : {}),
      };
      return {
        ...raw,
        type,
        afterIndex,
        card: {
          ...raw.card,
          pluginId,
          type: cardType,
          sessionId,
          ...(sessionPath ? { sessionPath } : {}),
          sessionRef,
        },
      };
    }
    const route = nonEmptyString(raw.card.route);
    if (!route) return null;
    return { ...raw, type, afterIndex, card: { ...raw.card, pluginId, type: cardType, route } };
  }

  if (type === 'cron_confirm') {
    if (!isRecord(raw.jobData)) return null;
    return {
      ...raw,
      type,
      afterIndex,
      jobData: raw.jobData,
      status: nonEmptyString(raw.status) || 'approved',
    };
  }

  if (type === 'suggestion_card') {
    const kind = nonEmptyString(raw.kind);
    const title = nonEmptyString(raw.title);
    if (!kind || !title) return null;
    return {
      ...raw,
      type,
      afterIndex,
      kind,
      title,
      status: nonEmptyString(raw.status) || 'pending',
    };
  }

  if (type === 'screenshot') {
    if (!nonEmptyString(raw.base64) || !nonEmptyString(raw.mimeType)) return null;
  } else if (type === 'settings_update') {
    if (!isRecord(raw.update)) return null;
  } else if (type === 'skill') {
    if (!nonEmptyString(raw.skillName)) return null;
  } else if (type === 'interlude') {
    if (!nonEmptyString(raw.text)) return null;
  }

  return { ...raw, type, afterIndex };
}

// ── 构建 ──

type InterludeContentBlock = Extract<ContentBlock, { type: 'interlude' }>;

function isInterludeHistoryBlock(block: Record<string, any>): block is InterludeContentBlock & { afterIndex: number; sourceIndex?: number } {
  return block.type === 'interlude';
}

function interludeContentBlock(block: Record<string, any>, fallbackId: string): InterludeContentBlock {
  const { afterIndex: _afterIndex, ...content } = block;
  return {
    ...content,
    type: 'interlude',
    id: nonEmptyString(content.id) || fallbackId,
    variant: nonEmptyString(content.variant) || 'deferred_result',
    text: nonEmptyString(content.text) || '',
  } as InterludeContentBlock;
}

function isMediaInterludeAnchor(block: Record<string, any>, taskId: string): boolean {
  return (
    (block.type === 'media_generation' && block.taskId === taskId) ||
    (block.type === 'file' && block.replacesTaskId === taskId)
  );
}

function shouldPlaceInterludeBeforeMessage(interlude: Record<string, any>, inlineBlocks: Record<string, any>[]): boolean {
  if (interlude.timelinePlacement === 'after_anchor_message') return false;
  const taskId = nonEmptyString(interlude.taskId);
  if (!taskId) return false;
  return inlineBlocks.some((block) => isMediaInterludeAnchor(block, taskId));
}

function normalizeHistoryTimestamp(value: number | string | null | undefined): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

function normalizeSourceIndex(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function sourceOrderedItems(
  items: ChatListItem[],
  data: HistoryApiResponse,
  allBlocks: Array<any>,
): ChatListItem[] {
  if (!items.length) return items;
  const orderById = new Map<string, number>();
  for (let i = 0; i < data.messages.length; i += 1) {
    const sourceIndex = normalizeSourceIndex(data.messages[i].sourceIndex);
    if (sourceIndex === null) continue;
    orderById.set(data.messages[i].id || `hist-${i}`, sourceIndex);
  }
  for (const block of allBlocks) {
    if (!isInterludeHistoryBlock(block)) continue;
    const sourceIndex = normalizeSourceIndex(block.sourceIndex);
    const id = nonEmptyString(block.id);
    if (sourceIndex === null || !id) continue;
    orderById.set(id, sourceIndex);
  }
  if (orderById.size === 0) return items;

  const entries = items.map((item, index) => {
    const id = item.type === 'message' ? item.data.id : item.id;
    return { item, index, sourceIndex: orderById.get(id) ?? null };
  });
  if (entries.some((entry) => entry.sourceIndex === null)) return items;

  return entries
    .sort((a, b) => (
      (a.sourceIndex as number) - (b.sourceIndex as number) ||
      a.index - b.index
    ))
    .map((entry) => entry.item);
}

export function buildItemsFromHistory(data: HistoryApiResponse): ChatListItem[] {
  const items: ChatListItem[] = [];
  const sessionFileLookup = buildSessionFileLookup(data.sessionFiles);

  // 按 afterIndex 分组统一 blocks
  const allBlocks = normalizeBlocks(data);
  const blockMap: Record<number, Array<any>> = {};
  for (const b of allBlocks) {
    (blockMap[b.afterIndex] ??= []).push(b);
  }

  for (let i = 0; i < data.messages.length; i++) {
    const m = data.messages[i];
    const id = m.id || `hist-${i}`;
    const timestamp = normalizeHistoryTimestamp(m.timestamp);

    if (m.role === 'user') {
      // 跨 session 协作：非用户本人发出的消息带 origin，此时以 displayText（干净正文，
      // 不含模型侧身份前缀）为准；老消息没有这两个字段，走既有 content 管道，行为不变。
      const origin = (m as any).origin;
      const originDisplayText = (origin || m.agentReview || m.agentReviewRequest || m.sessionRefs?.length)
        && typeof m.displayText === 'string' ? m.displayText : null;

      // strip steer 前缀（内部标记，不应展示给用户）
      const rawContent = (originDisplayText ?? (m.content || ''))
        .replace(LEGACY_STEER_PREFIX_RE, '')
        .replace(/^<t>[^<]*<\/t>\s*/, '');

      // 过滤系统注入的后台任务通知（steer 消息），不展示给用户
      if (/<luc-background-result\s/.test(rawContent) || /<luc-deferred-tasks>/.test(rawContent)) {
        continue;
      }

      const { text, files, attachedImages, attachedVideos, attachedAudios, sessionFileRefs, deskContext, quotedText } = parseUserAttachments(rawContent);
      const hasMarkerMedia = attachedImages.length > 0 || attachedVideos.length > 0 || attachedAudios.length > 0;
      const visibleText = normalizeUserVisibleText(text, hasMarkerMedia);
      const consumedSessionFileMarkers = new Set<number>();
      const fileAtts = files.map((f) => {
        const marker = consumeSessionFileMarkerForAttachment(sessionFileRefs, consumedSessionFileMarkers, f);
        return attachmentFromRef({
          path: f.path,
          name: f.name,
          isDirectory: f.isDirectory,
          ...(marker?.fileId ? { fileId: marker.fileId } : {}),
        }, sessionFileLookup, marker ? {
          fileId: marker.fileId,
          name: marker.label,
        } : undefined);
      });
      const imageBlocks = m.images || [];
      const markerImageAtts = attachedImages.map((ref, idx) => {
        const img = imageBlocks[idx];
        return attachmentFromRef(ref, sessionFileLookup, {
          ...(img?.mimeType ? { mimeType: img.mimeType } : {}),
        });
      });
      const imageAtts = imageBlocks.slice(attachedImages.length).map((img, idx) => ({
        path: `image-${idx}`,
        name: `image-${idx}.${(img.mimeType || 'image/png').split('/')[1] || 'png'}`,
        isDir: false,
        base64Data: img.data,
        mimeType: img.mimeType,
      }));
      const markerVideoAtts = attachedVideos.map((ref) => attachmentFromRef(ref, sessionFileLookup));
      const markerAudioAtts = attachedAudios.map((ref) => attachmentFromRef(ref, sessionFileLookup));
      const allAtts = [...fileAtts, ...markerImageAtts, ...markerVideoAtts, ...markerAudioAtts, ...imageAtts];
      const msg: ChatMessage = {
        id,
        sourceEntryId: m.entryId,
        role: 'user',
        text: visibleText,
        textHtml: visibleText ? renderMarkdown(visibleText) : undefined,
        attachments: allAtts.length ? allAtts : undefined,
        deskContext: deskContext || undefined,
        quotedText: quotedText || undefined,
        timestamp,
        ...(origin ? { origin } : {}),
        ...(m.agentReview ? { agentReview: m.agentReview } : {}),
        ...(m.agentReviewRequest ? { agentReviewRequest: m.agentReviewRequest } : {}),
        ...(m.sessionRefs?.length ? { sessionRefs: m.sessionRefs } : {}),
        ...(m.agentMentions?.length ? { agentMentions: m.agentMentions } : {}),
      };
      items.push({ type: 'message', data: msg });
    } else if (m.role === 'assistant') {
      const msgBlocks = blockMap[i] || [];
      const inlineBlocks = msgBlocks.filter((block) => !isInterludeHistoryBlock(block));
      const interludeBlocks = msgBlocks.filter(isInterludeHistoryBlock);
      const beforeInterludes = interludeBlocks.filter((block) => shouldPlaceInterludeBeforeMessage(block, inlineBlocks));
      const afterInterludes = interludeBlocks.filter((block) => !shouldPlaceInterludeBeforeMessage(block, inlineBlocks));
      const blocks = buildAssistantBlocksFromContent({
        content: m.content,
        thinking: m.thinking,
        toolCalls: m.toolCalls,
        extraBlocks: inlineBlocks,
      });

      for (let j = 0; j < beforeInterludes.length; j += 1) {
        const data = interludeContentBlock(beforeInterludes[j], `interlude:${i}:before:${j}`);
        items.push({
          type: 'interlude',
          id: data.id,
          data,
        });
      }

      const msg: ChatMessage = {
        id,
        sourceEntryId: m.entryId,
        role: 'assistant',
        blocks,
        ...(m.turnInputEntryId ? { turnInputEntryId: m.turnInputEntryId } : {}),
        ...(typeof m.turnInputVisible === 'boolean' ? { turnInputVisible: m.turnInputVisible } : {}),
      };
      if (timestamp !== undefined) msg.timestamp = timestamp;
      if (blocks.length > 0) {
        items.push({ type: 'message', data: msg });
      }

      for (let j = 0; j < afterInterludes.length; j += 1) {
        const data = interludeContentBlock(afterInterludes[j], `interlude:${i}:after:${j}`);
        items.push({
          type: 'interlude',
          id: data.id,
          data,
        });
      }
    }
  }

  return sourceOrderedItems(items, data, allBlocks);
}
