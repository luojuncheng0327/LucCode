/**
 * PreviewEditor — CodeMirror 6 编辑器组件
 *
 * Obsidian 风格 markdown live preview：
 * - 衬线体渲染，无行号，无行高亮
 * - 已成立的语法标记始终 conceal，未完成的输入保留源码
 * - H1 居中，标题/粗体/斜体等格式实时渲染
 *
 * 架构：
 * - forwardRef 暴露 EditorView handle，供外部 toolbar 发命令
 * - Compartment 动态扩展槽，运行时可切换 mode/language
 * - 文件系统 source of truth，直接对接文件读写
 */

import { forwardRef, useEffect, useRef, useCallback, useImperativeHandle, useLayoutEffect, useState, Fragment } from 'react';
import { EditorContextMenu } from './preview/EditorContextMenu';
import { isContextMenuButton } from '../stores/selection-actions';
import {
  EditorView, keymap, highlightActiveLine, drawSelection,
  lineNumbers,
} from '@codemirror/view';
import { EditorState, Compartment, Transaction, EditorSelection } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import {
  syntaxHighlighting, bracketMatching,
} from '@codemirror/language';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { markdownHighlight, codeHighlight } from '../editor/highlight';
import { markdownTheme, codeTheme } from '../editor/theme';
import { markdownBlockDecoField, markdownDecoPlugin, markdownImageContextFacet } from '../editor/md-decorations';
import { markdownCoverField } from '../editor/cover-field';
import {
  markdownBlockHandlePlugin,
  type MarkdownBlockMenuRequest,
} from '../editor/markdown-block-handles';
import { markdownBlockSelectionPlugin } from '../editor/markdown-block-selection';
import { mermaidDecoField } from '../editor/mermaid-field';
import { linkClickHandler } from '../editor/link-handler';
import { tableDecoField } from '../editor/table-field';
import { csvTableField } from '../editor/csv-field';
import { requestUserEditCheckpoint, type UserEditCheckpointReason } from '../utils/checkpoints';
import {
  arrayBufferToBase64,
  buildMarkdownAttachmentPlan,
  type MarkdownAttachmentPlan,
} from '../utils/markdown-attachments';
import {
  clearAppFileDragPayload,
  readAppFileDragPayload,
} from '../utils/app-file-drag';
import {
  isMarkdownCoverOnlyUpdate,
  mergeMarkdownCoverIntoDocument,
  parseMarkdownCover,
} from '../utils/markdown-cover';
import {
  applyMarkdownCoverImageDrop,
  hasMarkdownCoverDropImage,
} from '../utils/markdown-cover-drop';
import { isRemoteWorkbenchContentRef } from '../utils/remote-file-preview';
import type { FileVersion, RemoteWorkbenchContentRef, VersionedWriteResult } from '../types';
import type { PreviewScrollSnapshot } from '../../../../shared/preview-reading-position.ts';

/* ── Types ── */

export interface PreviewEditorHandle {
  getView(): EditorView | null;
  focus(): void;
  getScrollSnapshot(contentHash?: string): PreviewScrollSnapshot | null;
  restoreScrollSnapshot(snapshot: PreviewScrollSnapshot | null | undefined): void;
  scrollToLine(line: number): void;
  scrollToOffset(from: number, to?: number, options?: PreviewEditorScrollOptions): void;
  getTopVisibleLine(): number;
}

export interface PreviewEditorScrollOptions {
  focus?: boolean;
}

export interface PreviewEditorStats {
  selectedChars: number;
  totalChars: number;
}

export interface PreviewEditorQuoteRange {
  from: number;
  to: number;
}

export type PreviewEditorSaveDocument = (
  content: string,
  expectedVersion?: FileVersion | null,
) => Promise<VersionedWriteResult>;

export interface PreviewEditorProps {
  content: string;
  filePath?: string;
  remoteContentRef?: RemoteWorkbenchContentRef | null;
  fileVersion?: FileVersion | null;
  saveDocument?: PreviewEditorSaveDocument;
  mode: 'markdown' | 'code' | 'csv' | 'text';
  language?: string | null;
  onSelectionChange?: (view: EditorView) => void;
  onSelectionCommit?: (view: EditorView) => void;
  onQuoteRange?: (view: EditorView, range: PreviewEditorQuoteRange) => void;
  onStatsChange?: (stats: PreviewEditorStats) => void;
  onContentChange?: (content: string, fileVersion?: FileVersion | null) => void;
  initialScrollSnapshot?: PreviewScrollSnapshot | null;
  contentHash?: string;
  onScrollSnapshotChange?: (snapshot: PreviewScrollSnapshot, topVisibleLine: number) => void;
  /**
   * 只读模式：禁用编辑、不挂 autosave listener。
   * 调用方（如派生 viewer 窗口）自己把新 content 作为 prop 传入即可。
   */
  readOnly?: boolean;
}

const SAVE_DELAY = 600;
const CHECKPOINT_INTERVAL = 5 * 60 * 1000;
const EDITOR_HOST_MIN_SIZE_PX = 1;

interface SaveJob {
  text: string;
  revision: number;
}

interface PendingIncomingContent {
  content: string;
  fileVersion: FileVersion | null;
  noticeShown: boolean;
}

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function showSaveError(prefixKey: string, err: unknown): void {
  const tFn = window.t ?? ((p: string) => p);
  window.dispatchEvent(new CustomEvent('luc-inline-notice', {
    detail: { text: `${tFn(prefixKey)}: ${getErrorMessage(err)}`, type: 'error' },
  }));
}

function fileVersionIdentity(version: FileVersion | null | undefined): string {
  if (!version) return '';
  return [
    Number.isFinite(version.mtimeMs) ? version.mtimeMs : '',
    Number.isFinite(version.size) ? version.size : '',
    version.sha256 || '',
  ].join(':');
}

function clampPos(pos: number, max: number): number {
  return Math.max(0, Math.min(pos, max));
}

function countTextChars(text: string): number {
  return Array.from(text).length;
}

function getSelectedText(state: EditorState): string {
  return state.selection.ranges
    .filter(range => !range.empty)
    .map(range => state.sliceDoc(range.from, range.to))
    .join('');
}

function getEditorStats(view: EditorView): PreviewEditorStats {
  return {
    selectedChars: countTextChars(getSelectedText(view.state).trim()),
    totalChars: countTextChars(view.state.doc.toString()),
  };
}

function scrollRatio(scrollTop: number, scrollHeight: number, clientHeight: number): number {
  const max = Math.max(0, scrollHeight - clientHeight);
  return max > 0 ? Math.min(1, Math.max(0, scrollTop / max)) : 0;
}

function getScrollSnapshot(view: EditorView, contentHash?: string): PreviewScrollSnapshot {
  const el = view.scrollDOM;
  return {
    scrollTop: el.scrollTop,
    scrollLeft: el.scrollLeft,
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
    ratio: scrollRatio(el.scrollTop, el.scrollHeight, el.clientHeight),
    ...(contentHash ? { contentHash } : {}),
  };
}

function restoreEditorScrollSnapshot(view: EditorView, snapshot: PreviewScrollSnapshot | null | undefined): void {
  if (!snapshot) return;
  const el = view.scrollDOM;
  const restore = () => {
    const max = Math.max(0, el.scrollHeight - el.clientHeight);
    const top = Number.isFinite(snapshot.scrollTop)
      ? snapshot.scrollTop
      : Number.isFinite(snapshot.ratio) ? (snapshot.ratio || 0) * max : 0;
    el.scrollTop = Math.min(max, Math.max(0, top));
    el.scrollLeft = Math.max(0, snapshot.scrollLeft || 0);
  };
  restore();
  queueMicrotask(restore);
  window.requestAnimationFrame?.(restore);
}

function topVisibleLine(view: EditorView): number {
  const rect = view.scrollDOM.getBoundingClientRect();
  const pos = view.posAtCoords({ x: rect.left + 8, y: rect.top + 8 }) ?? view.viewport.from;
  return Math.max(0, view.state.doc.lineAt(pos).number - 1);
}

function scrollEditorToOffset(view: EditorView, from: number, to = from, options: PreviewEditorScrollOptions = {}): void {
  const length = view.state.doc.length;
  const safeFrom = clampPos(from, length);
  const safeTo = clampPos(to, length);
  view.dispatch({
    selection: EditorSelection.single(safeFrom, safeTo),
    effects: EditorView.scrollIntoView(safeFrom, { y: 'start', yMargin: 64 }),
  });
  if (options.focus !== false) view.focus();
}

function restoreScrollPosition(view: EditorView, scrollTop: number, scrollLeft: number): void {
  const restore = () => {
    view.scrollDOM.scrollTop = scrollTop;
    view.scrollDOM.scrollLeft = scrollLeft;
  };
  restore();
  queueMicrotask(restore);
  window.requestAnimationFrame?.(restore);
}

function editorHostBoxSize(el: HTMLElement): { width: number; height: number } {
  const rect = el.getBoundingClientRect();
  return {
    width: Math.max(rect.width, el.clientWidth, el.offsetWidth),
    height: Math.max(rect.height, el.clientHeight, el.offsetHeight),
  };
}

function isEditorHostReady(el: HTMLElement): boolean {
  if (!el.isConnected) return false;
  const doc = el.ownerDocument;
  const win = doc.defaultView;
  if (!win || win.closed) return false;
  if (doc.visibilityState === 'hidden') return false;
  const { width, height } = editorHostBoxSize(el);
  return width >= EDITOR_HOST_MIN_SIZE_PX && height >= EDITOR_HOST_MIN_SIZE_PX;
}

function replaceDocumentPreservingSelection(view: EditorView, content: string): boolean {
  const current = view.state.doc.toString();
  if (current === content) return false;
  const nextLength = content.length;
  const { anchor, head } = view.state.selection.main;
  const { scrollTop, scrollLeft } = view.scrollDOM;
  view.dispatch({
    changes: { from: 0, to: current.length, insert: content },
    selection: EditorSelection.single(clampPos(anchor, nextLength), clampPos(head, nextLength)),
    annotations: Transaction.remote.of(true),
  });
  restoreScrollPosition(view, scrollTop, scrollLeft);
  return true;
}

function syncEditorRootToDom(view: EditorView): void {
  const root = view.dom.getRootNode();
  const currentRoot: unknown = view.root;
  if (root === currentRoot) return;
  const nodeType = (root as Node).nodeType;
  const isDocument = nodeType === 9;
  const isShadowRoot = nodeType === 11 && 'host' in root;
  if (isDocument || isShadowRoot) {
    view.setRoot(root as Document | ShadowRoot);
  }
}

interface MarkdownAttachmentSource {
  file?: File;
  path?: string;
  name: string;
  mimeType?: string | null;
}

function dataTransferHasFiles(dataTransfer: DataTransfer | null): boolean {
  if (!dataTransfer) return false;
  if (dataTransfer.files?.length) return true;
  return Array.from(dataTransfer.types || []).includes('Files');
}

function filesFromDataTransfer(dataTransfer: DataTransfer | null): File[] {
  if (!dataTransfer) return [];
  const files = Array.from(dataTransfer.files || []);
  if (files.length > 0) return files;

  return Array.from(dataTransfer.items || [])
    .filter(item => item.kind === 'file')
    .map(item => item.getAsFile())
    .filter((file): file is File => !!file);
}

function attachmentSourcesFromFiles(files: File[]): MarkdownAttachmentSource[] {
  return files
    .filter(file => !file.name.endsWith('/'))
    .map(file => ({
      file,
      path: window.platform?.getFilePath?.(file) || undefined,
      name: file.name,
      mimeType: file.type || null,
    }));
}

function attachmentSourcesFromAppDrag(dataTransfer: DataTransfer | null): MarkdownAttachmentSource[] | null {
  const payload = readAppFileDragPayload(dataTransfer);
  if (!payload) return null;
  return payload.files
    .filter(file => !file.isDirectory && !!file.path)
    .map(file => ({
      path: file.path,
      name: file.name || file.path,
      mimeType: file.mimeType || null,
    }));
}

async function writeMarkdownAttachment(source: MarkdownAttachmentSource, plan: MarkdownAttachmentPlan): Promise<void> {
  let copied = false;
  if (source.path && typeof window.platform?.copyFile === 'function') {
    copied = await window.platform.copyFile(source.path, plan.attachmentPath);
  }
  if (copied) return;

  if (!source.file) {
    throw new Error(`cannot copy attachment: ${source.name}`);
  }
  if (typeof window.platform?.writeFileBinary !== 'function') {
    throw new Error('writeFileBinary unavailable');
  }
  const base64 = arrayBufferToBase64(await source.file.arrayBuffer());
  const ok = await window.platform.writeFileBinary(plan.attachmentPath, base64);
  if (ok === false) {
    throw new Error(`failed to write attachment: ${source.name}`);
  }
}

function insertMarkdownAt(view: EditorView, markdown: string, position: number | null): void {
  const selection = view.state.selection.main;
  const from = position ?? selection.from;
  const to = position ?? selection.to;
  view.dispatch({
    changes: { from, to, insert: markdown },
    selection: EditorSelection.cursor(from + markdown.length),
    scrollIntoView: true,
    annotations: Transaction.userEvent.of('input.paste'),
  });
}

function dropPosition(view: EditorView, event: DragEvent): number | null {
  try {
    return view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? null;
  } catch {
    return null;
  }
}

function dragEventElement(event: DragEvent): Element | null {
  return event.target instanceof Element ? event.target : null;
}

function editorCoverElementFromEvent(event: DragEvent): HTMLElement | null {
  return dragEventElement(event)?.closest('.cm-markdown-cover') as HTMLElement | null;
}

function clearEditorCoverDropState(view: EditorView): void {
  view.dom.classList.remove('cm-markdown-cover-rail-active');
  view.dom.querySelector('.cm-markdown-cover-drop-active')?.classList.remove('cm-markdown-cover-drop-active');
}

function isEditorCoverRailDrop(view: EditorView, event: DragEvent): boolean {
  if (parseMarkdownCover(view.state.doc.toString())) return false;
  const rect = view.scrollDOM.getBoundingClientRect();
  if (!Number.isFinite(event.clientY)) return false;
  const y = event.clientY;
  return y >= rect.top && y <= rect.top + 40;
}

/* ── Editor Component ── */

export const PreviewEditor = forwardRef<PreviewEditorHandle, PreviewEditorProps>(
  function PreviewEditor({ content, filePath, remoteContentRef, fileVersion, saveDocument, mode, language, onSelectionChange, onSelectionCommit, onQuoteRange, onStatsChange, onContentChange, initialScrollSnapshot, contentHash, onScrollSnapshotChange, readOnly = false }, ref) {
    const incomingFileVersionKey = fileVersionIdentity(fileVersion ?? null);
    const containerRef = useRef<HTMLDivElement>(null);
    const viewRef = useRef<EditorView | null>(null);
    const [blockMenuRequest, setBlockMenuRequest] = useState<MarkdownBlockMenuRequest | null>(null);
    const toggleBlockMenu = useCallback((request: MarkdownBlockMenuRequest) => {
      setBlockMenuRequest(current => (
        current
        && current.target.from === request.target.from
        && current.target.to === request.target.to
        && current.target.source === request.target.source
          ? null
          : request
      ));
    }, []);
    const [editorHostReadySignal, setEditorHostReadySignal] = useState(0);
    const lastEditorHostReadyRef = useRef(false);
    const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const saveInFlightRef = useRef(false);
    const pendingSaveRef = useRef<SaveJob | null>(null);
    const lastSavedContentRef = useRef<string>(content);
    const selfWriteContentsRef = useRef<Set<string>>(new Set());
    const pendingIncomingContentRef = useRef<PendingIncomingContent | null>(null);
    const diskVersionRef = useRef<FileVersion | null>(fileVersion ?? null);
    const lastPropFileVersionKeyRef = useRef(incomingFileVersionKey);
    const docRevisionRef = useRef(0);
    const lastCheckpointAtRef = useRef<number>(0);
    const filePathRef = useRef(filePath);
    filePathRef.current = filePath;
    const remoteContentRefRef = useRef(remoteContentRef);
    remoteContentRefRef.current = remoteContentRef;
    const saveDocumentRef = useRef(saveDocument);
    saveDocumentRef.current = saveDocument;
    const selectionCbRef = useRef(onSelectionChange);
    selectionCbRef.current = onSelectionChange;
    const selectionCommitCbRef = useRef(onSelectionCommit);
    selectionCommitCbRef.current = onSelectionCommit;
    const statsCbRef = useRef(onStatsChange);
    statsCbRef.current = onStatsChange;
    const lastStatsRef = useRef<PreviewEditorStats | null>(null);
    const contentCbRef = useRef(onContentChange);
    contentCbRef.current = onContentChange;
    const initialScrollSnapshotRef = useRef(initialScrollSnapshot);
    initialScrollSnapshotRef.current = initialScrollSnapshot;
    const contentHashRef = useRef(contentHash);
    contentHashRef.current = contentHash;
    const scrollSnapshotCbRef = useRef(onScrollSnapshotChange);
    scrollSnapshotCbRef.current = onScrollSnapshotChange;
    const restoredScrollKeyRef = useRef<string>('');

    useEffect(() => {
      if (fileVersion !== undefined) {
        diskVersionRef.current = fileVersion;
      }
    }, [fileVersion]);

    // Per-instance compartments for dynamic reconfiguration
    const cRef = useRef({
      lang: new Compartment(),
      highlight: new Compartment(),
      gutter: new Compartment(),
      conceal: new Compartment(),
      theme: new Compartment(),
    });

    useLayoutEffect(() => {
      const host = containerRef.current;
      if (!host) return undefined;
      const doc = host.ownerDocument;
      const win = doc.defaultView ?? window;
      let disposed = false;
      let rafId: number | null = null;
      let retryTimer: ReturnType<typeof setTimeout> | null = null;
      let resizeObserver: ResizeObserver | null = null;

      const clearPending = () => {
        if (rafId !== null) {
          win.cancelAnimationFrame?.(rafId);
          rafId = null;
        }
        if (retryTimer) {
          clearTimeout(retryTimer);
          retryTimer = null;
        }
      };

      const check = () => {
        rafId = null;
        retryTimer = null;
        if (disposed) return;
        const ready = isEditorHostReady(host);
        if (ready && !lastEditorHostReadyRef.current && !viewRef.current) {
          setEditorHostReadySignal(signal => signal + 1);
        }
        lastEditorHostReadyRef.current = ready;
        if (!ready) {
          retryTimer = setTimeout(() => {
            retryTimer = null;
            scheduleCheck();
          }, 250);
        }
      };

      const scheduleCheck = () => {
        if (disposed || rafId !== null || retryTimer) return;
        if (typeof win.requestAnimationFrame === 'function') {
          rafId = win.requestAnimationFrame(check);
        } else {
          retryTimer = setTimeout(check, 0);
        }
      };

      const requestCheck = () => {
        if (disposed) return;
        if (retryTimer) {
          clearTimeout(retryTimer);
          retryTimer = null;
        }
        scheduleCheck();
      };

      if (typeof win.ResizeObserver === 'function') {
        resizeObserver = new win.ResizeObserver(requestCheck);
        resizeObserver.observe(host);
      }
      doc.addEventListener('visibilitychange', requestCheck);
      win.addEventListener('resize', requestCheck);
      check();

      return () => {
        disposed = true;
        clearPending();
        resizeObserver?.disconnect();
        doc.removeEventListener('visibilitychange', requestCheck);
        win.removeEventListener('resize', requestCheck);
      };
    }, []);

    useImperativeHandle(ref, () => ({
      getView: () => viewRef.current,
      focus: () => viewRef.current?.focus(),
      getScrollSnapshot: (hash?: string) => viewRef.current ? getScrollSnapshot(viewRef.current, hash ?? contentHashRef.current) : null,
      restoreScrollSnapshot: (snapshot) => {
        if (viewRef.current) restoreEditorScrollSnapshot(viewRef.current, snapshot);
      },
      scrollToLine: (line) => {
        const view = viewRef.current;
        if (!view) return;
        const docLine = view.state.doc.line(Math.min(view.state.doc.lines, Math.max(1, line + 1)));
        scrollEditorToOffset(view, docLine.from);
      },
      scrollToOffset: (from, to, options) => {
        if (viewRef.current) scrollEditorToOffset(viewRef.current, from, to, options);
      },
      getTopVisibleLine: () => viewRef.current ? topVisibleLine(viewRef.current) : 0,
    }));

    const createCheckpointIfDue = useCallback(async (fp: string) => {
      const now = Date.now();
      if (lastCheckpointAtRef.current > 0 && now - lastCheckpointAtRef.current < CHECKPOINT_INTERVAL) return;
      const reason: UserEditCheckpointReason = lastCheckpointAtRef.current > 0
        ? 'autosave-interval'
        : 'edit-start';
      try {
        await requestUserEditCheckpoint(fp, reason);
      } catch (err) {
        console.warn('[PreviewEditor] checkpoint failed:', err);
        showSaveError('settings.saveFailed', err);
      } finally {
        lastCheckpointAtRef.current = now;
      }
    }, []);

    const insertMarkdownAttachments = useCallback(async (
      view: EditorView,
      sources: MarkdownAttachmentSource[],
      position: number | null = null,
    ) => {
      const fp = filePathRef.current;
      if (!fp) throw new Error('markdown file path required');
      if (sources.length === 0) return;

      const plans: MarkdownAttachmentPlan[] = [];
      for (let i = 0; i < sources.length; i += 1) {
        const source = sources[i];
        const plan = buildMarkdownAttachmentPlan({
          markdownFilePath: fp,
          originalName: source.name,
          mimeType: source.mimeType,
          index: i,
        });
        await writeMarkdownAttachment(source, plan);
        plans.push(plan);
      }

      insertMarkdownAt(view, plans.map(plan => plan.markdown).join('\n'), position);
    }, []);

    const emitStatsIfChanged = useCallback((view: EditorView) => {
      const next = getEditorStats(view);
      const previous = lastStatsRef.current;
      if (
        previous
        && previous.selectedChars === next.selectedChars
        && previous.totalChars === next.totalChars
      ) {
        return;
      }
      lastStatsRef.current = next;
      statsCbRef.current?.(next);
    }, []);

    const rememberSelfWrite = useCallback((text: string) => {
      selfWriteContentsRef.current.add(text);
      window.setTimeout(() => {
        selfWriteContentsRef.current.delete(text);
      }, 5000);
    }, []);

    const performSave = useCallback(async ({ text, revision }: SaveJob) => {
      const fp = filePathRef.current;
      const saveRemoteDocument = saveDocumentRef.current;
      if (!fp && !saveRemoteDocument) return;

      try {
        if (fp) await createCheckpointIfDue(fp);
        if (revision !== docRevisionRef.current || fp !== filePathRef.current) return;
        const expectedVersion = diskVersionRef.current;
        let nextVersion: FileVersion | null | undefined;

        if (saveRemoteDocument) {
          const result = await saveRemoteDocument(text, expectedVersion);
          if (!result?.ok) {
            if (result?.conflict) {
              const tFn = window.t ?? ((p: string) => p);
              throw new Error(tFn('settings.fileChangedOnDisk'));
            }
            throw new Error('saveDocument returned false');
          }
          nextVersion = result.version ?? null;
          if (result.version) diskVersionRef.current = result.version;
        } else {
          if (!fp) return;
          if (window.platform?.writeFileIfUnchanged) {
            const result = await window.platform.writeFileIfUnchanged(fp, text, expectedVersion);
            if (!result?.ok) {
              if (result?.conflict) {
                const tFn = window.t ?? ((p: string) => p);
                throw new Error(tFn('settings.fileChangedOnDisk'));
              }
              throw new Error('write-file-if-unchanged returned false');
            }
            nextVersion = result.version ?? null;
            if (result.version) diskVersionRef.current = result.version;
          } else {
            const ok = await window.platform?.writeFile(fp, text);
            if (ok === false) throw new Error('write-file returned false');
            nextVersion = undefined;
          }
        }
        lastSavedContentRef.current = text;
        if (pendingIncomingContentRef.current?.content === text) {
          pendingIncomingContentRef.current = null;
        }
        rememberSelfWrite(text);

        if (revision === docRevisionRef.current && fp === filePathRef.current && nextVersion !== undefined) {
          contentCbRef.current?.(text, nextVersion);
        }
      } catch (err) {
        console.warn('[PreviewEditor] write failed:', err);
        showSaveError('settings.saveFailed', err);
      }
    }, [createCheckpointIfDue, rememberSelfWrite]);

    const drainSaveQueue = useCallback(function drain() {
      if (saveInFlightRef.current) return;
      const job = pendingSaveRef.current;
      if (!job) return;
      pendingSaveRef.current = null;
      saveInFlightRef.current = true;
      void performSave(job).finally(() => {
        saveInFlightRef.current = false;
        drain();
      });
    }, [performSave]);

    const saveToFile = useCallback((text: string, revision: number = docRevisionRef.current) => {
      pendingSaveRef.current = { text, revision };
      drainSaveQueue();
    }, [drainSaveQueue]);

    const applyIncomingContent = useCallback((nextContent: string, options: { publish?: boolean } = {}) => {
      const view = viewRef.current;
      if (!view) return;
      const current = view.state.doc.toString();
      if (current === nextContent) {
        if (options.publish) {
          lastSavedContentRef.current = nextContent;
          pendingIncomingContentRef.current = null;
        }
        return;
      }

      if (selfWriteContentsRef.current.has(nextContent)) {
        if (options.publish) {
          lastSavedContentRef.current = nextContent;
          pendingIncomingContentRef.current = null;
        }
        return;
      }

      const hasLocalUnsavedEdits = !readOnly && current !== lastSavedContentRef.current;
      if (hasLocalUnsavedEdits) {
        const merged = mode === 'markdown' && isMarkdownCoverOnlyUpdate(lastSavedContentRef.current, nextContent)
          ? mergeMarkdownCoverIntoDocument(current, nextContent)
          : null;
        if (merged) {
          docRevisionRef.current += 1;
          const revision = docRevisionRef.current;
          if (saveTimerRef.current) {
            clearTimeout(saveTimerRef.current);
            saveTimerRef.current = null;
          }
          lastSavedContentRef.current = nextContent;
          pendingIncomingContentRef.current = null;
          replaceDocumentPreservingSelection(view, merged);
          contentCbRef.current?.(merged);
          saveToFile(merged, revision);
          return;
        }

        const nextVersion = diskVersionRef.current;
        const previousPending = pendingIncomingContentRef.current;
        const samePending = !!previousPending
          && previousPending.content === nextContent
          && fileVersionIdentity(previousPending.fileVersion) === fileVersionIdentity(nextVersion);
        const pending: PendingIncomingContent = {
          content: nextContent,
          fileVersion: nextVersion,
          noticeShown: samePending ? previousPending.noticeShown : false,
        };
        pendingIncomingContentRef.current = pending;
        contentCbRef.current?.(current);
        if (!pending.noticeShown) {
          showSaveError('settings.fileChangedOnDisk', 'local edits are not saved yet');
          pending.noticeShown = true;
        }
        return;
      }

      docRevisionRef.current += 1;
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      lastSavedContentRef.current = nextContent;
      pendingIncomingContentRef.current = null;
      replaceDocumentPreservingSelection(view, nextContent);
      if (options.publish) {
        contentCbRef.current?.(nextContent, diskVersionRef.current);
      }
    }, [mode, readOnly, saveToFile]);

    // Create editor
    useLayoutEffect(() => {
      if (!containerRef.current) return;
      if (!editorHostReadySignal || !isEditorHostReady(containerRef.current)) return;
      const c = cRef.current;
      const isMd = mode === 'markdown';
      const isCsv = mode === 'csv';

      const extensions = [
        ...(isMd ? [] : [drawSelection()]),
        history(),
        bracketMatching(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        EditorView.contentAttributes.of({ spellcheck: 'false' }),
        EditorView.lineWrapping,
        ...(isMd && !readOnly ? [
          EditorView.domEventHandlers({
            dragover(event) {
              const appSources = attachmentSourcesFromAppDrag(event.dataTransfer);
              if (!filePathRef.current || (!appSources && !dataTransferHasFiles(event.dataTransfer))) return false;
              event.preventDefault();
              if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
              return true;
            },
            drop(event, view) {
              const payload = readAppFileDragPayload(event.dataTransfer);
              const appSources = payload
                ? attachmentSourcesFromAppDrag(event.dataTransfer)
                : null;
              const sources = appSources ?? attachmentSourcesFromFiles(filesFromDataTransfer(event.dataTransfer));
              if (!filePathRef.current || sources.length === 0) return false;
              event.preventDefault();
              event.stopPropagation();
              if (payload) clearAppFileDragPayload(payload.dragId);
              const position = dropPosition(view, event);
              void insertMarkdownAttachments(view, sources, position)
                .catch(err => showSaveError('preview.markdownAttachmentInsertFailed', err));
              return true;
            },
            paste(event, view) {
              const sources = attachmentSourcesFromFiles(filesFromDataTransfer(event.clipboardData));
              if (!filePathRef.current || sources.length === 0) return false;
              event.preventDefault();
              event.stopPropagation();
              void insertMarkdownAttachments(view, sources)
                .catch(err => showSaveError('preview.markdownAttachmentInsertFailed', err));
              return true;
            },
          }),
        ] : []),
        // 只读模式：禁用编辑 + 关闭 autosave；不挂 file watch（调用方自理）
        ...(readOnly
          ? [EditorState.readOnly.of(true), EditorView.editable.of(false)]
          : [
              EditorView.updateListener.of((update) => {
                if (!update.docChanged) return;
                if (update.transactions.some((tr) => tr.annotation(Transaction.remote))) return;
                const text = update.state.doc.toString();
                docRevisionRef.current += 1;
                const revision = docRevisionRef.current;
                contentCbRef.current?.(text);
                if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
                saveTimerRef.current = setTimeout(() => {
                  saveTimerRef.current = null;
                  saveToFile(text, revision);
                }, SAVE_DELAY);
              }),
            ]),
        EditorView.updateListener.of((update) => {
          if (update.selectionSet && selectionCbRef.current) {
            selectionCbRef.current(update.view);
          }
          if (update.docChanged || update.selectionSet) {
            emitStatsIfChanged(update.view);
          }
        }),
        // Dynamic compartments
        c.gutter.of(isMd || isCsv ? [] : lineNumbers()),
        c.lang.of(
          isMd ? markdown({ base: markdownLanguage, codeLanguages: languages }) : [],
        ),
        c.highlight.of(
          syntaxHighlighting(isMd ? markdownHighlight : codeHighlight),
        ),
        c.conceal.of(isMd ? [
          markdownImageContextFacet.of({
            filePath,
            getFileUrl: window.platform?.getFileUrl,
          }),
          markdownDecoPlugin,
          markdownCoverField,
          markdownBlockDecoField,
          mermaidDecoField,
        ] : []),
        ...(isMd && !readOnly ? [
          markdownBlockSelectionPlugin(),
          markdownBlockHandlePlugin({
            onOpenMenu: toggleBlockMenu,
          }),
        ] : []),
        ...(isMd ? [tableDecoField] : []),
        ...(isCsv ? [csvTableField] : []),
        c.theme.of(isMd || isCsv ? markdownTheme : codeTheme),
        linkClickHandler,
      ];

      // 代码模式保留行高亮，markdown / csv 模式不要
      if (!isMd && !isCsv) extensions.push(highlightActiveLine());

      const state = EditorState.create({ doc: content, extensions });
      const view = new EditorView({ state, parent: containerRef.current });
      const selectionCommitWindow = containerRef.current.ownerDocument.defaultView ?? window;
      const handledSelectionCommitEvents = new WeakSet<Event>();
      const onSelectionCommitEvent = (event: Event) => {
        if (handledSelectionCommitEvents.has(event)) return;
        if (isContextMenuButton(event)) return;
        handledSelectionCommitEvents.add(event);
        selectionCommitCbRef.current?.(view);
      };
      const onWindowSelectionCommitEvent = (event: Event) => {
        if (!view.hasFocus) return;
        onSelectionCommitEvent(event);
      };
      let scrollTimer: ReturnType<typeof setTimeout> | null = null;
      const publishScrollSnapshot = () => {
        scrollTimer = null;
        scrollSnapshotCbRef.current?.(getScrollSnapshot(view, contentHashRef.current), topVisibleLine(view));
      };
      const onScroll = () => {
        if (!scrollSnapshotCbRef.current) return;
        if (scrollTimer) clearTimeout(scrollTimer);
        scrollTimer = setTimeout(publishScrollSnapshot, 160);
      };
      const onCoverDragOver = (event: DragEvent) => {
        const canApplyCover = Boolean(filePathRef.current || isRemoteWorkbenchContentRef(remoteContentRefRef.current));
        const coverElement = editorCoverElementFromEvent(event);
        if (coverElement && canApplyCover && hasMarkdownCoverDropImage(event.dataTransfer)) {
          event.preventDefault();
          event.stopPropagation();
          if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
          coverElement.classList.add('cm-markdown-cover-drop-active');
          view.dom.classList.remove('cm-markdown-cover-rail-active');
          return;
        }

        if (canApplyCover && hasMarkdownCoverDropImage(event.dataTransfer) && isEditorCoverRailDrop(view, event)) {
          event.preventDefault();
          event.stopPropagation();
          if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
          view.dom.classList.add('cm-markdown-cover-rail-active');
          return;
        }

        clearEditorCoverDropState(view);
      };
      const onCoverDragLeave = (event: DragEvent) => {
        const coverElement = editorCoverElementFromEvent(event);
        if (coverElement && !(event.relatedTarget instanceof Node && coverElement.contains(event.relatedTarget))) {
          coverElement.classList.remove('cm-markdown-cover-drop-active');
        }
        if (!(event.relatedTarget instanceof Node && view.dom.contains(event.relatedTarget))) {
          clearEditorCoverDropState(view);
        }
      };
      const onCoverDrop = (event: DragEvent) => {
        const remoteRef = isRemoteWorkbenchContentRef(remoteContentRefRef.current)
          ? remoteContentRefRef.current
          : null;
        const coverElement = editorCoverElementFromEvent(event);
        const isCoverTarget = Boolean(coverElement)
          || (hasMarkdownCoverDropImage(event.dataTransfer) && isEditorCoverRailDrop(view, event));
        if ((!filePathRef.current && !remoteRef) || !isCoverTarget || !hasMarkdownCoverDropImage(event.dataTransfer)) return;
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        clearEditorCoverDropState(view);
        void applyMarkdownCoverImageDrop({
          filePath: filePathRef.current,
          target: remoteRef,
          dataTransfer: event.dataTransfer,
        });
      };
      view.dom.addEventListener('mouseup', onSelectionCommitEvent);
      view.dom.addEventListener('touchend', onSelectionCommitEvent);
      view.dom.addEventListener('keyup', onSelectionCommitEvent);
      selectionCommitWindow.addEventListener('mouseup', onWindowSelectionCommitEvent);
      selectionCommitWindow.addEventListener('touchend', onWindowSelectionCommitEvent);
      selectionCommitWindow.addEventListener('keyup', onWindowSelectionCommitEvent);
      view.scrollDOM.addEventListener('scroll', onScroll, { passive: true });
      view.dom.addEventListener('dragover', onCoverDragOver, true);
      view.dom.addEventListener('dragleave', onCoverDragLeave, true);
      view.dom.addEventListener('drop', onCoverDrop, true);
      viewRef.current = view;
      lastStatsRef.current = null;
      emitStatsIfChanged(view);
      restoreEditorScrollSnapshot(view, initialScrollSnapshotRef.current);

      return () => {
        if (scrollTimer) {
          clearTimeout(scrollTimer);
          publishScrollSnapshot();
        }
        if (saveTimerRef.current) {
          clearTimeout(saveTimerRef.current);
          saveTimerRef.current = null;
          saveToFile(view.state.doc.toString(), docRevisionRef.current);
        }
        view.dom.removeEventListener('mouseup', onSelectionCommitEvent);
        view.dom.removeEventListener('touchend', onSelectionCommitEvent);
        view.dom.removeEventListener('keyup', onSelectionCommitEvent);
        selectionCommitWindow.removeEventListener('mouseup', onWindowSelectionCommitEvent);
        selectionCommitWindow.removeEventListener('touchend', onWindowSelectionCommitEvent);
        selectionCommitWindow.removeEventListener('keyup', onWindowSelectionCommitEvent);
        view.scrollDOM.removeEventListener('scroll', onScroll);
        view.dom.removeEventListener('dragover', onCoverDragOver, true);
        view.dom.removeEventListener('dragleave', onCoverDragLeave, true);
        view.dom.removeEventListener('drop', onCoverDrop, true);
        view.destroy();
        viewRef.current = null;
      };
    }, [editorHostReadySignal, mode, language, readOnly, filePath, remoteContentRef, emitStatsIfChanged, insertMarkdownAttachments]); // eslint-disable-line react-hooks/exhaustive-deps -- 仅在 host 可测量以及 mode/language/readOnly/filePath/remoteContentRef 变化时重建 CodeMirror，content/refs 故意省略以避免销毁重建

    useEffect(() => {
      const view = viewRef.current;
      if (!view) return;
      syncEditorRootToDom(view);
    });

    useEffect(() => {
      const view = viewRef.current;
      const snapshot = initialScrollSnapshot;
      if (!view || !snapshot) return;
      const key = `${filePath || remoteContentRef?.contentPath || ''}:${mode}:${contentHash || ''}:${snapshot.updatedAt || ''}:${snapshot.scrollTop}:${snapshot.ratio ?? ''}`;
      if (restoredScrollKeyRef.current === key) return;
      restoredScrollKeyRef.current = key;
      restoreEditorScrollSnapshot(view, snapshot);
    }, [contentHash, filePath, initialScrollSnapshot, mode, remoteContentRef?.contentPath]);

    // content prop change → update editor (skip if already in sync)
    useEffect(() => {
      const versionChanged = incomingFileVersionKey !== lastPropFileVersionKeyRef.current;
      lastPropFileVersionKeyRef.current = incomingFileVersionKey;
      applyIncomingContent(content, { publish: versionChanged });
    }, [content, incomingFileVersionKey, applyIncomingContent]);

    const getViewForMenu = useCallback(() => viewRef.current, []);
    const closeBlockMenu = useCallback(() => setBlockMenuRequest(null), []);

    return (
      <Fragment>
        <div className={`preview-editor mode-${mode}`} ref={containerRef} />
        <EditorContextMenu
          getView={getViewForMenu}
          containerRef={containerRef}
          mode={mode}
          readOnly={readOnly}
          blockMenuRequest={blockMenuRequest}
          onBlockMenuClose={closeBlockMenu}
          onQuoteRange={onQuoteRange}
        />
      </Fragment>
    );
  },
);
