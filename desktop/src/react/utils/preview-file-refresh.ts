import { useStore } from '../stores';
import { upsertPreviewItem } from '../stores/preview-actions';
import type { PreviewItem } from '../types';
import { readFileForPreviewType, type PreviewReadResult } from './preview-file-content';

const refreshGenerations = new Map<string, number>();
const DEFAULT_RETRY_DELAYS_MS = [80, 240, 600] as const;

export interface PreviewFileRefreshOptions {
  retryMissing?: boolean;
  retryUnchanged?: boolean;
  retryDelaysMs?: readonly number[];
}

export const PREVIEW_FILE_CHANGE_REFRESH_OPTIONS: PreviewFileRefreshOptions = Object.freeze({
  retryMissing: true,
  retryUnchanged: true,
});

export const PREVIEW_FILE_CATCH_UP_REFRESH_OPTIONS: PreviewFileRefreshOptions = Object.freeze({
  retryMissing: true,
});

function beginRefresh(filePath: string): number {
  const next = (refreshGenerations.get(filePath) ?? 0) + 1;
  refreshGenerations.set(filePath, next);
  return next;
}

function isLatestRefresh(filePath: string, generation: number): boolean {
  return refreshGenerations.get(filePath) === generation;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
}

function fileVersionsEqual(a: PreviewItem['fileVersion'], b: PreviewItem['fileVersion']): boolean {
  if (!a || !b) return a === b;
  return a.mtimeMs === b.mtimeMs
    && a.size === b.size
    && a.sha256 === b.sha256;
}

function readMatchesCurrentItem(item: PreviewItem, read: PreviewReadResult): boolean {
  if (item.fileVersion && read.fileVersion) return fileVersionsEqual(item.fileVersion, read.fileVersion);
  const sourceUrl = read.sourceUrl ?? item.sourceUrl;
  return read.content === item.content && sourceUrl === item.sourceUrl;
}

async function readFileForPreviewTypeWithRetry(
  filePath: string,
  item: PreviewItem,
  generation: number,
  options: PreviewFileRefreshOptions,
): Promise<PreviewReadResult | null | undefined> {
  const retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  for (let attempt = 0; ; attempt += 1) {
    const read = await readFileForPreviewType(filePath, item.type);
    if (!isLatestRefresh(filePath, generation)) return undefined;

    const canRetry = attempt < retryDelaysMs.length;
    const shouldRetryMissing = !read && options.retryMissing;
    const shouldRetryUnchanged = !!read && options.retryUnchanged && readMatchesCurrentItem(item, read);
    if (!canRetry || (!shouldRetryMissing && !shouldRetryUnchanged)) return read;

    await delay(retryDelaysMs[attempt] ?? 0);
    if (!isLatestRefresh(filePath, generation)) return undefined;
  }
}

export function __resetPreviewFileRefreshStateForTests(): void {
  refreshGenerations.clear();
}

export async function refreshPreviewItemsFromFile(filePath: string, options: PreviewFileRefreshOptions = {}): Promise<void> {
  const generation = beginRefresh(filePath);
  const state = useStore.getState();
  for (const item of state.previewItems || []) {
    if (item.filePath !== filePath) continue;
    const read = await readFileForPreviewTypeWithRetry(filePath, item, generation, options);
    if (!isLatestRefresh(filePath, generation) || read === undefined) return;
    if (!read) {
      upsertPreviewItem({
        ...item,
        status: 'missing',
        missingAt: Date.now(),
      });
      continue;
    }
    upsertPreviewItem({
      ...item,
      content: read.content,
      sourceUrl: read.sourceUrl ?? item.sourceUrl,
      fileVersion: read.fileVersion ?? item.fileVersion,
      status: 'available',
      missingAt: null,
    });
  }
}
