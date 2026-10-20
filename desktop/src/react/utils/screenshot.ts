// desktop/src/react/utils/screenshot.ts
import { useStore } from '../stores';
import { selectSelectedIdsBySession } from '../stores/session-selectors';
import { sessionScopedValue } from '../stores/session-slice';
import { extractScreenshotPayload, buildThemeName, type ScreenshotPayload } from './screenshot-extract';
import { readScreenshotSegmentVisibleCharLimit, splitScreenshotMessages } from './screenshot-segments';
import { resolveScreenshotFontFamily } from './font-presets';
import type { ChatMessage } from '../stores/chat-types';
import {
  appendConnectionAuth,
  buildConnectionUrl,
  createLocalServerConnection,
} from '../services/server-connection';
import { userFallbackAvatar, yuanFallbackAvatar } from './agent-helpers';
import { isMarkdownFileName } from './file-kind';

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface InlineNoticeTarget {
  deskDir?: string;
  filePath?: string;
}

function dispatchInlineNotice(text: string, type: 'success' | 'error', target: InlineNoticeTarget = {}) {
  window.dispatchEvent(new CustomEvent('luc-inline-notice', {
    detail: { text, type, ...target },
  }));
}

type StoreSnapshot = ReturnType<typeof useStore.getState>;
type ScreenshotRenderPayload = ScreenshotPayload & {
  saveDir?: string | null;
  locale?: string;
  fontFamily?: string;
  segmentIndex?: number;
  segmentTotal?: number;
};

export interface ArticleScreenshotOptions {
  filePath?: string | null;
  articleType?: string | null;
  language?: string | null;
  saveDir?: string | null;
}

export interface MarkdownFileScreenshotOptions {
  saveDir?: string | null;
  fileName?: string | null;
}

interface ScreenshotRenderResult {
  success: boolean;
  error?: string;
  dir?: string;
  filePath?: string;
}

interface AvatarCache {
  assistant: string | null;
  user: string | null;
}

function beginScreenshotProgress(totalBlocks: number, totalPages: number): () => void {
  const state = useStore.getState() as StoreSnapshot & {
    beginScreenshotTask?: (progress: {
      completedBlocks: number;
      totalBlocks: number;
      currentPage: number;
      totalPages: number;
    }) => void;
    endScreenshotTask?: () => void;
  };
  state.beginScreenshotTask?.({
    completedBlocks: 0,
    totalBlocks,
    currentPage: totalPages > 0 ? 1 : 0,
    totalPages,
  });

  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    const latest = useStore.getState() as StoreSnapshot & { endScreenshotTask?: () => void };
    latest.endScreenshotTask?.();
  };
}

function updateScreenshotProgress(progress: {
  completedBlocks?: number;
  currentPage?: number;
}) {
  const state = useStore.getState() as StoreSnapshot & {
    updateScreenshotProgress?: (progress: {
      completedBlocks?: number;
      currentPage?: number;
    }) => void;
  };
  state.updateScreenshotProgress?.(progress);
}

async function resolveAvatarCache(state: StoreSnapshot): Promise<AvatarCache> {
  const [assistant, user] = await Promise.all([
    state.currentAgentId
      ? fetchAvatarAsDataUrl('assistant', state.currentAgentId).catch(() => null)
      : Promise.resolve(null),
    fetchAvatarAsDataUrl('user', null).catch(() => null),
  ]);
  const [assistantFallback, userFallback] = await Promise.all([
    assistant
      ? Promise.resolve(assistant)
      : resolveAssistantFallbackAvatar(state).catch(() => null),
    user
      ? Promise.resolve(user)
      : Promise.resolve(userFallbackAvatar(state.userName || '我')),
  ]);

  return {
    assistant: assistantFallback,
    user: userFallback,
  };
}

async function buildScreenshotPayloadForMessages(
  messages: ChatMessage[],
  theme: string,
  state: StoreSnapshot,
  avatars: AvatarCache,
  imageCache: Map<string, string>,
  segment: { index: number; total: number },
): Promise<ScreenshotRenderPayload> {
  const payload = extractScreenshotPayload(messages, theme) as ScreenshotRenderPayload;
  payload.saveDir = state.homeFolder || null;
  payload.locale = window.i18n?.locale || state.locale || window.navigator?.language || 'zh';
  payload.fontFamily = resolveScreenshotFontFamily();
  if (segment.total > 1) {
    payload.segmentIndex = segment.index;
    payload.segmentTotal = segment.total;
  }

  if (!payload.messages) return payload;

  const assistantName = state.agentName || 'Luc';
  const userName = state.userName || '我';

  for (const msg of payload.messages) {
    if (msg.role === 'assistant') {
      msg.name = assistantName;
      msg.avatarDataUrl = avatars.assistant;
    } else {
      msg.name = userName;
      msg.avatarDataUrl = avatars.user;
    }

    for (const block of msg.blocks) {
      if (block.type !== 'image' || !block.content || block.content.startsWith('data:')) continue;
      const cached = imageCache.get(block.content);
      if (cached) {
        block.content = cached;
        continue;
      }
      try {
        const dataUrl = await fetchImageAsDataUrl(block.content);
        imageCache.set(block.content, dataUrl);
        block.content = dataUrl;
      } catch { /* keep original content; broken image is preferable to failing the whole screenshot */ }
    }
  }

  return payload;
}

/**
 * 截图指定消息并保存到文件（离屏渲染管线）。
 */
export async function takeScreenshot(targetMessageId: string, sessionPath: string): Promise<void> {
  const state = useStore.getState();
  const ids = selectSelectedIdsBySession(state, sessionPath);
  const messageIds = ids.length > 0 ? ids : [targetMessageId];

  // 1. 从 store 提取消息数据
  const session = sessionScopedValue(state, state.chatSessions, sessionPath);
  if (!session) return;

  const messages: ChatMessage[] = [];
  for (const item of session.items) {
    if (item.type !== 'message') continue;
    if (messageIds.includes(item.data.id)) {
      messages.push(item.data);
    }
  }
  if (messages.length === 0) return;

  // 2. 读取截图设置
  const color = localStorage.getItem('luc-screenshot-color') || 'light';
  const width = localStorage.getItem('luc-screenshot-width') || 'mobile';
  const theme = buildThemeName(color, width);

  const t = window.t ?? ((p: string) => p);
  const luc = (window as any).luc;
  if (!luc?.screenshotRender) {
    dispatchInlineNotice(t('common.screenshotFailed'), 'error');
    return;
  }

  const segmentLimit = readScreenshotSegmentVisibleCharLimit();
  const chunks = splitScreenshotMessages(messages, segmentLimit);
  const endProgress = beginScreenshotProgress(messages.length, chunks.length);
  try {
    const avatars = await resolveAvatarCache(state);
    const imageCache = new Map<string, string>();
    const results: ScreenshotRenderResult[] = [];
    let completedBlocks = 0;

    for (let i = 0; i < chunks.length; i += 1) {
      updateScreenshotProgress({ currentPage: i + 1 });
      const payload = await buildScreenshotPayloadForMessages(
        chunks[i],
        theme,
        state,
        avatars,
        imageCache,
        { index: i + 1, total: chunks.length },
      );
      const result = await luc.screenshotRender(payload) as ScreenshotRenderResult;
      if (!result.success) {
        throw new Error(result.error || t('common.screenshotFailed'));
      }
      results.push(result);
      completedBlocks += chunks[i].length;
      updateScreenshotProgress({ completedBlocks });
    }

    const saveDir = results.find(result => result.dir)?.dir;
    const firstFilePath = results.find(result => result.filePath)?.filePath;
    const savedText = chunks.length > 1
      ? t('common.screenshotSavedMultiple', { count: chunks.length })
      : t('common.screenshotSaved');
    dispatchInlineNotice(savedText, 'success', { deskDir: saveDir, filePath: firstFilePath });
  } catch (err) {
    dispatchInlineNotice(`${t('common.screenshotFailed')}: ${getErrorMessage(err)}`, 'error');
  } finally {
    endProgress();
  }
}

/**
 * Markdown 编辑器截图（纯文章模式）。
 */
export async function takeArticleScreenshot(markdown: string, options: ArticleScreenshotOptions = {}): Promise<void> {
  const color = localStorage.getItem('luc-screenshot-color') || 'light';
  const width = localStorage.getItem('luc-screenshot-width') || 'mobile';
  const theme = buildThemeName(color, width);

  const t = window.t ?? ((p: string) => p);
  const luc = (window as any).luc;
  if (!luc?.screenshotRender) {
    dispatchInlineNotice(t('common.screenshotFailed'), 'error');
    return;
  }

  const homeFolder = useStore.getState().homeFolder || null;
  const saveDir = Object.prototype.hasOwnProperty.call(options, 'saveDir')
    ? options.saveDir ?? null
    : homeFolder;
  const endProgress = beginScreenshotProgress(1, 1);
  try {
    const result = await luc.screenshotRender({
      mode: 'article',
      theme,
      markdown,
      filePath: options.filePath || null,
      articleType: options.articleType || 'markdown',
      language: options.language || null,
      saveDir,
      locale: window.i18n?.locale || useStore.getState().locale || window.navigator?.language || 'zh',
      fontFamily: resolveScreenshotFontFamily(),
    });

    if (result.success) {
      updateScreenshotProgress({ completedBlocks: 1 });
      dispatchInlineNotice(t('common.screenshotSaved'), 'success', {
        deskDir: result.dir,
        filePath: result.filePath,
      });
    } else {
      dispatchInlineNotice(`${t('common.screenshotFailed')}: ${result.error}`, 'error');
    }
  } catch (err) {
    dispatchInlineNotice(`${t('common.screenshotFailed')}: ${getErrorMessage(err)}`, 'error');
  } finally {
    endProgress();
  }
}

async function readMarkdownFileForScreenshot(filePath: string, fileName?: string | null): Promise<string> {
  if (!filePath || (!isMarkdownFileName(filePath) && !isMarkdownFileName(fileName || undefined))) {
    throw new Error('not a Markdown file');
  }

  const snapshot = await window.platform?.readFileSnapshot?.(filePath);
  if (snapshot && typeof snapshot.content === 'string') {
    return snapshot.content;
  }

  const content = await window.platform?.readFile?.(filePath);
  if (typeof content === 'string') {
    return content;
  }

  throw new Error(`failed to read Markdown file: ${filePath}`);
}

export async function takeMarkdownFileScreenshot(
  filePath: string,
  options: MarkdownFileScreenshotOptions = {},
): Promise<void> {
  const t = window.t ?? ((p: string) => p);
  try {
    const markdown = await readMarkdownFileForScreenshot(filePath, options.fileName);
    const articleOptions: ArticleScreenshotOptions = {
      filePath,
      articleType: 'markdown',
    };
    if (Object.prototype.hasOwnProperty.call(options, 'saveDir')) {
      articleOptions.saveDir = options.saveDir;
    }
    await takeArticleScreenshot(markdown, articleOptions);
  } catch (err) {
    dispatchInlineNotice(`${t('common.screenshotFailed')}: ${getErrorMessage(err)}`, 'error');
  }
}

// ── 辅助：fetch 图片转 data URL ──

async function fetchImageAsDataUrl(filePath: string): Promise<string> {
  const url = window.platform?.getFileUrl?.(filePath) ?? '';
  return fetchUrlAsDataUrl(url);
}

async function fetchUrlAsDataUrl(url: string): Promise<string> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`failed to fetch image: ${resp.status}`);
  const blob = await resp.blob();
  return blobToDataUrl(blob);
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return `data:${blob.type || 'application/octet-stream'};base64,${btoa(binary)}`;
}

function resolveAssetUrl(src: string): string {
  try {
    return new URL(src, window.location.href).toString();
  } catch {
    return src;
  }
}

async function resolveAssistantFallbackAvatar(state: StoreSnapshot): Promise<string | null> {
  const fallbackSrc = yuanFallbackAvatar(state.agentYuan || undefined);
  if (!fallbackSrc) return null;
  if (fallbackSrc.startsWith('data:')) return fallbackSrc;
  try {
    return await fetchUrlAsDataUrl(resolveAssetUrl(fallbackSrc));
  } catch {
    return userFallbackAvatar(state.agentName || 'Luc');
  }
}

async function fetchAvatarAsDataUrl(role: string, agentId: string | null): Promise<string | null> {
  const port = await (window as any).luc?.getServerPort?.();
  const token = await (window as any).luc?.getServerToken?.();
  const connection = createLocalServerConnection({ serverPort: port, serverToken: token });
  if (!connection || !connection.token) return null;

  const path = role === 'user'
    ? '/api/avatar/user'
    : `/api/agents/${agentId}/avatar`;

  const resp = await fetch(buildConnectionUrl(connection, path), {
    headers: appendConnectionAuth(connection),
  });
  if (!resp.ok) return null;
  const blob = await resp.blob();
  return blobToDataUrl(blob).catch(() => null);
}
