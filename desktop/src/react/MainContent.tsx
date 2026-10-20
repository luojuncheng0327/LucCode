/**
 * MainContent.tsx — 主内容区域：拖拽处理 + 布局编排
 *
 * 从 App.tsx 提取。包含：
 * - handleDrop() 拖拽附件处理
 * - MainContent（原 MainContentDrag）组件
 * - DropText 子组件
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import { useStore } from './stores';
import { lucFetch } from './hooks/use-luc-fetch';
import { toSlash, baseName } from './utils/format';
import { isAudioFileName } from './utils/file-kind';
import { buildWaveformFromBase64 } from './utils/audio-waveform';
import type { AudioWaveform } from './stores/chat-types';
import {
  clearAppFileDragPayload,
  readAppFileDragPayload,
  type AppFileDragPayload,
} from './utils/app-file-drag';
import { deskNativeRootDir } from './stores/desk-actions';
import { BrowserCard } from './components/BrowserCard';
import { ComputerUseOverlay } from './components/ComputerUseOverlay';

declare function t(key: string, vars?: Record<string, string | number>): string;

/* eslint-disable @typescript-eslint/no-explicit-any -- deskFiles item typing */

// ── 拖拽附件 drop handler（从 bridge.ts appInput shim 迁移） ──

async function installSkillFile(filePath: string, sessionPath?: string | null): Promise<void> {
  try {
    const agentId = useStore.getState().currentAgentId || '';
    if (!agentId) {
      useStore.getState().addToast(
        t('settings.skills.installError') + ': no current agent',
        'error',
      );
      return;
    }
    const res = await lucFetch(`/api/skills/install?agentId=${encodeURIComponent(agentId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: filePath, ...(sessionPath ? { sessionPath } : {}) }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    useStore.getState().addToast(
      t('settings.skills.installSuccess', { name: data.skill?.name || '' }),
      'success',
    );
  } catch (err) {
    useStore.getState().addToast(
      t('settings.skills.installError') + ': ' + (err instanceof Error ? err.message : String(err)),
      'error',
    );
  }
}

function blockChatAttachmentDropOutsideChat(): boolean {
  if (useStore.getState().currentTab !== 'channels') return false;
  useStore.getState().addToast(t('channel.filesUnsupported'), 'error');
  return true;
}

function chatAudioMimeTypeForName(name: string): string {
  const ext = name.toLowerCase().replace(/^.*\./, '');
  const mimeMap: Record<string, string> = {
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
    flac: 'audio/flac',
    m4a: 'audio/mp4',
    weba: 'audio/webm',
    webm: 'audio/webm',
  };
  return mimeMap[ext] || 'audio/wav';
}

async function computeAudioWaveformsForPaths(srcPaths: string[]): Promise<Record<string, { waveform: AudioWaveform }>> {
  const out: Record<string, { waveform: AudioWaveform }> = {};
  if (typeof window.platform?.readFileBase64 !== 'function') return out;
  for (const srcPath of srcPaths) {
    const name = baseName(srcPath);
    if (!isAudioFileName(name)) continue;
    try {
      const mimeType = chatAudioMimeTypeForName(name);
      const base64 = await window.platform.readFileBase64(srcPath);
      const waveform = base64 ? await buildWaveformFromBase64(base64, mimeType) : undefined;
      if (waveform) out[srcPath] = { waveform };
    } catch (err) {
      console.warn('[upload] failed to compute audio waveform', err);
    }
  }
  return out;
}

/**
 * attachFilesFromPaths — 将文件系统路径列表附加为聊天附件
 *
 * 拖拽和文件选择器共用此逻辑。nameMap 可选，用于保留拖拽时的原始文件名。
 */
export async function attachFilesFromPaths(
  srcPaths: string[],
  nameMap: Record<string, string> = {},
): Promise<void> {
  if (srcPaths.length === 0) return;
  if (blockChatAttachmentDropOutsideChat()) return;
  if (useStore.getState().attachedFiles.length >= 9) return;

  // .skill 文件直接安装为用户技能，不当附件处理
  const skillPaths = srcPaths.filter(p => /\.skill$/i.test(p));
  if (skillPaths.length) {
    srcPaths = srcPaths.filter(p => !skillPaths.includes(p));
    const sessionPath = useStore.getState().currentSessionPath || null;
    for (const p of skillPaths) installSkillFile(p, sessionPath);
    if (srcPaths.length === 0) return;
  }

  // Desk 文件直接附加（保留原始路径，不走 upload）。
  // mount 工作台只有在服务端披露 native root（local_fs + local owner）时
  // 才有真实路径可直接附加；远端/虚拟 mount 不走此分支。
  const s = useStore.getState();
  const deskBase = toSlash(deskNativeRootDir(s) ?? '').replace(/\/+$/, '');
  if (deskBase) {
    const prefix = deskBase + '/';
    const deskFileMap = new Map(s.deskFiles.map((f: any) => [f.name, f]));
    const isDeskPath = (p: string) => { const s = toSlash(p); return s === deskBase || s.startsWith(prefix); };
    const deskPaths = srcPaths.filter(isDeskPath);
    srcPaths = srcPaths.filter((p) => !isDeskPath(p));
    for (const p of deskPaths) {
      if (useStore.getState().attachedFiles.length >= 9) break;
      const name = baseName(p);
      const isRoot = toSlash(p) === deskBase;
      const knownFile = deskFileMap.get(name);
      useStore.getState().addAttachedFile({
        path: p,
        name,
        isDirectory: isRoot || (knownFile?.isDir ?? false),
      });
    }
  }
  if (srcPaths.length === 0) return;

  try {
    const sessionPath = useStore.getState().currentSessionPath || null;
    const metadataByPath = await computeAudioWaveformsForPaths(srcPaths);
    const res = await lucFetch('/api/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        paths: srcPaths,
        ...(Object.keys(metadataByPath).length ? { metadataByPath } : {}),
        ...(sessionPath ? { sessionPath } : {}),
      }),
    });
    const data = await res.json();
    const failed: string[] = [];
    for (const item of data.uploads || []) {
      if (item.dest) {
        useStore.getState().addAttachedFile({
          fileId: item.fileId,
          path: item.dest,
          name: item.name,
          isDirectory: item.isDirectory || false,
          waveform: item.waveform || metadataByPath[item.src]?.waveform,
        });
      } else if (item.error) {
        failed.push(nameMap[item.src] || baseName(item.src));
      }
    }
    if (failed.length > 0) {
      useStore.getState().addToast(
        t('error.uploadPartialFail', { files: failed.join(', ') }),
        'error',
      );
    }
  } catch (err) {
    console.error('[upload]', err);
    useStore.getState().addToast(
      t('error.uploadFailed'),
      'error',
    );
  }
}

export async function attachAppFileDragPayloadToInput(payload: AppFileDragPayload): Promise<void> {
  if (payload.files.length === 0) return;
  if (blockChatAttachmentDropOutsideChat()) return;
  const state = useStore.getState();
  if (state.attachedFiles.length >= 9) return;

  if (payload.source === 'session-file') {
    for (const file of payload.files) {
      if (useStore.getState().attachedFiles.length >= 9) break;
      useStore.getState().addAttachedFile({
        fileId: file.fileId,
        path: file.path,
        name: file.name,
        isDirectory: file.isDirectory || false,
        ...(file.base64Data ? { base64Data: file.base64Data } : {}),
        ...(file.mimeType ? { mimeType: file.mimeType } : {}),
      });
    }
    return;
  }

  const paths = payload.files
    .filter(file => file.path)
    .map(file => file.path);
  await attachFilesFromPaths(paths);
}

async function handleDrop(e: React.DragEvent): Promise<void> {
  const appPayload = readAppFileDragPayload(e.dataTransfer);
  if (appPayload) {
    clearAppFileDragPayload(appPayload.dragId);
    await attachAppFileDragPayloadToInput(appPayload);
    return;
  }

  const files = e.dataTransfer?.files;
  if (!files || files.length === 0) return;

  const nameMap: Record<string, string> = {};
  const srcPaths: string[] = [];
  for (const file of Array.from(files)) {
    const filePath = window.platform?.getFilePath?.(file);
    if (filePath) {
      srcPaths.push(filePath);
      nameMap[filePath] = file.name;
    }
  }
  await attachFilesFromPaths(srcPaths, nameMap);
}

// ── DropText ──

function DropText() {
  const agentName = useStore(s => s.agentName);
  return <span className="drop-text">{t('drop.hint', { name: agentName })}</span>;
}

// ── MainContent（拖拽区域 + children） ──

export function MainContent({ children }: { children: React.ReactNode }) {
  const [dragActive, setDragActive] = useState(false);
  const dragCounter = useRef(0);
  const welcomeVisible = useStore(s => s.welcomeVisible);
  const currentTab = useStore(s => s.currentTab);
  const welcomeMode = welcomeVisible && currentTab === 'chat';

  const finishDragSession = useCallback(() => {
    dragCounter.current = 0;
    setDragActive(false);
  }, []);

  useEffect(() => {
    // 外部文件在窗口外松手、Escape 取消或窗口失焦时，React 根节点不一定
    // 收到成对的 drop/dragleave。这里只结束生命周期，不消费 DataTransfer。
    window.addEventListener('drop', finishDragSession, true);
    window.addEventListener('dragend', finishDragSession, true);
    window.addEventListener('blur', finishDragSession);
    return () => {
      window.removeEventListener('drop', finishDragSession, true);
      window.removeEventListener('dragend', finishDragSession, true);
      window.removeEventListener('blur', finishDragSession);
    };
  }, [finishDragSession]);

  const onDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current++;
    if (dragCounter.current === 1) setDragActive(true);
  }, []);
  const onDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current = Math.max(0, dragCounter.current - 1);
    if (dragCounter.current === 0) finishDragSession();
  }, [finishDragSession]);
  const onDragOver = useCallback((e: React.DragEvent) => e.preventDefault(), []);
  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    finishDragSession();
    void handleDrop(e);
  }, [finishDragSession]);

  return (
    <div
      className={`main-content${welcomeMode ? ' welcome-mode' : ''}`}
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDropCapture={finishDragSession}
      onDrop={onDrop}
      onDragEndCapture={finishDragSession}
    >
      <BrowserCard />
      <ComputerUseOverlay />
      <div className={`drop-overlay${dragActive ? ' visible' : ''}`}>
        <div className="drop-overlay-inner">
          <span className="drop-icon">📎</span>
          <DropText />
        </div>
      </div>
      {children}
    </div>
  );
}
