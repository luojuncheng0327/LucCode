// desktop/src/react/utils/screenshot-extract.ts

import type { AudioWaveform, ChatMessage, ContentBlock, UserAttachment, VoiceTranscription } from '../stores/chat-types';
import type { FileKind } from '../types/file-ref';
import { extOfName, isImageOrSvgExt, kindOfFileName } from './file-kind';

export type ScreenshotAttachmentKind = FileKind | 'directory';

export type ScreenshotBlock =
  // html: pre-rendered HTML from assistant text blocks - inject directly into template
  // markdown: raw Markdown from user messages - main process renders via markdown-it
  // image: base64 dataUrl or file path (caller converts to base64)
  | { type: 'html' | 'markdown' | 'image'; content: string }
  // attachment: semantic user attachment marker for non-image files and expired media.
  | {
    type: 'attachment';
    kind: ScreenshotAttachmentKind;
    name: string;
    presentation?: 'attachment' | 'voice-input' | string;
    status?: 'available' | 'expired' | string;
    transcription?: VoiceTranscription;
    waveform?: AudioWaveform;
  };

export interface ScreenshotMessage {
  role: 'user' | 'assistant';
  name: string;
  avatarDataUrl: string | null;
  showHeader: boolean;
  blocks: ScreenshotBlock[];
}

export interface ScreenshotPayload {
  mode: 'article' | 'conversation';
  theme: string;
  markdown?: string;          // article mode from Markdown editor
  filePath?: string | null;    // source file for resolving relative article attachments
  articleType?: string | null; // markdown / code / future preview item types
  language?: string | null;    // code article language
  messages?: ScreenshotMessage[];
}

export function buildThemeName(color: string, width: string): string {
  const base = color === 'sakura' ? 'sakura-light' : `solarized-${color}`;
  return width === 'desktop' ? `${base}-desktop` : base;
}

// 扩展名识别统一走 file-kind 中心表；禁止维护私有 IMAGE_EXTS 表。
function extractBlocks(blocks: ContentBlock[]): ScreenshotBlock[] {
  const result: ScreenshotBlock[] = [];
  for (const block of blocks) {
    if (block.type === 'text') {
      result.push({ type: 'html', content: block.html });
    } else if (block.type === 'file' && isImageOrSvgExt(block.ext)) {
      result.push({ type: 'image', content: block.filePath });
    } else if (block.type === 'screenshot') {
      result.push({ type: 'image', content: `data:${block.mimeType};base64,${block.base64}` });
    }
  }
  return result;
}

function isImageAttachment(attachment: UserAttachment): boolean {
  if (attachment.mimeType?.startsWith('image/')) return true;
  return isImageOrSvgExt(extOfName(attachment.name || attachment.path));
}

function basenamePortable(value: string): string {
  const normalized = value.replace(/\\/g, '/');
  const slash = normalized.lastIndexOf('/');
  return slash >= 0 ? normalized.slice(slash + 1) : normalized;
}

function attachmentName(attachment: UserAttachment): string {
  return attachment.name || basenamePortable(attachment.path || '') || 'attachment';
}

function attachmentKind(attachment: UserAttachment): ScreenshotAttachmentKind {
  if (attachment.isDir) return 'directory';
  return kindOfFileName(attachment.name || attachment.path, attachment.mimeType);
}

function extractAttachmentBlock(attachment: UserAttachment): ScreenshotBlock {
  return {
    type: 'attachment',
    kind: attachmentKind(attachment),
    name: attachmentName(attachment),
    ...(attachment.presentation && attachment.presentation !== 'attachment'
      ? { presentation: attachment.presentation }
      : {}),
    ...(attachment.status ? { status: attachment.status } : {}),
    ...(attachment.transcription ? { transcription: attachment.transcription } : {}),
    ...(attachment.waveform ? { waveform: attachment.waveform } : {}),
  };
}

function extractUserBlocks(msg: ChatMessage): ScreenshotBlock[] {
  const result: ScreenshotBlock[] = [];
  if (msg.text) result.push({ type: 'markdown', content: msg.text });

  for (const attachment of msg.attachments || []) {
    const isAvailableImage = !attachment.isDir
      && attachment.status !== 'expired'
      && isImageAttachment(attachment);
    if (isAvailableImage && attachment.base64Data) {
      result.push({
        type: 'image',
        content: `data:${attachment.mimeType || 'image/png'};base64,${attachment.base64Data}`,
      });
    } else if (isAvailableImage && attachment.path) {
      result.push({ type: 'image', content: attachment.path });
    } else {
      result.push(extractAttachmentBlock(attachment));
    }
  }

  return result;
}

export function extractScreenshotPayload(
  messages: ChatMessage[],
  theme: string,
): ScreenshotPayload {
  const roles = new Set(messages.map(m => m.role));
  const isMixed = roles.size > 1;

  const buildMsg = (m: ChatMessage, index: number): ScreenshotMessage => ({
    role: m.role,
    name: '',
    avatarDataUrl: null as string | null,
    showHeader: index === 0 || messages[index - 1].role !== m.role,
    blocks: m.role === 'user'
      ? extractUserBlocks(m)
      : extractBlocks(m.blocks || []),
  });

  if (isMixed) {
    return {
      mode: 'conversation',
      theme,
      messages: messages.map(buildMsg),
    };
  }

  return {
    mode: 'article',
    theme,
    messages: messages.map(buildMsg),
  };
}
