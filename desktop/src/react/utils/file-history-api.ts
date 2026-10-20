/**
 * file-history-api — 工作区文件历史的 renderer 侧 HTTP 客户端
 *
 * 与 server/routes/file-history.ts 一一对应：文件清单、单文件版本列表、
 * 快照正文、还原。所有请求都以 agentId 定位工作区（server 端按 principal
 * 解析 native root），组件不需要也不应该自己拼工作区路径。
 *
 * lucFetch 默认 throwOnHttpError=true：非 2xx 直接抛错，调用方按失败处理，
 * 不做静默降级。
 */

import { lucFetch } from '../hooks/use-luc-fetch';

export interface FileHistoryFileEntry {
  relPath: string;
  deletedAt: number | null;
  lastCapturedAt: number;
  snapshotCount: number;
}

export interface FileHistoryVersionEntry {
  id: number;
  capturedAt: number;
  origin: 'event' | 'watcher' | 'sweep' | 'restore';
  opContext: string | null;
  rawSize: number;
}

export interface FileHistorySnapshotContent {
  relPath: string;
  capturedAt: number;
  origin: string;
  content: string;
}

export interface FileHistoryRestoreResult {
  ok: boolean;
  relPath: string;
}

export async function fetchHistoryFiles(agentId: string): Promise<FileHistoryFileEntry[]> {
  const res = await lucFetch(`/api/file-history/files?agentId=${encodeURIComponent(agentId)}`);
  const data = await res.json();
  return data.files;
}

export async function fetchHistoryVersions(
  agentId: string,
  relPath: string,
): Promise<FileHistoryVersionEntry[]> {
  const res = await lucFetch(
    `/api/file-history/versions?agentId=${encodeURIComponent(agentId)}&relPath=${encodeURIComponent(relPath)}`,
  );
  const data = await res.json();
  return data.versions;
}

export async function fetchHistorySnapshot(
  agentId: string,
  id: number,
): Promise<FileHistorySnapshotContent> {
  const res = await lucFetch(
    `/api/file-history/snapshot?agentId=${encodeURIComponent(agentId)}&id=${id}`,
  );
  return res.json();
}

export async function restoreHistorySnapshot(
  agentId: string,
  snapshotId: number,
): Promise<FileHistoryRestoreResult> {
  const res = await lucFetch('/api/file-history/restore', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId, snapshotId }),
  });
  return res.json();
}
