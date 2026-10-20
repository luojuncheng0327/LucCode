/**
 * PreviewRenderer — PreviewItem 内容的声明式渲染
 *
 * 替代 PreviewPanel 中命令式 DOM 构建的 switch/case useEffect。
 * 每种 previewItem 类型对应一个 JSX 分支或子组件。
 */

import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent, type ReactNode } from 'react';
import { renderMarkdownPreview } from '../../utils/markdown';
import {
  parseMarkdownCover,
  removeMarkdownCover,
  resolveMarkdownCoverImagePath,
  stripMarkdownFrontMatterForPreview,
  updateMarkdownCoverLayout,
  type MarkdownCover,
  type MarkdownCoverLayoutPatch,
} from '../../utils/markdown-cover';
import {
  dispatchCoverNotice,
  type MarkdownCoverTargetInput,
} from '../../utils/markdown-cover-generation';
import {
  isExternalCoverImagePath,
  regenerateMarkdownCoverWithPrompt,
  saveMarkdownCoverImage,
} from '../../utils/markdown-cover-actions';
import {
  applyMarkdownCoverImageDrop,
  hasMarkdownCoverDropImage,
} from '../../utils/markdown-cover-drop';
import { parseCSV, injectCopyButtons } from '../../utils/format';
import { observeMarkdownRhythmSnap } from '../../utils/markdown-rhythm';
import { fileIconSvg } from '../../utils/icons';
import { openFilePreview } from '../../utils/file-preview';
import { openInternalLink, resolveLinkTarget, type LinkOpenContext } from '../../utils/link-open';
import { showError } from '../../utils/ui-helpers';
import { lucFetch } from '../../hooks/use-luc-fetch';
import { useStore } from '../../stores';
import { upsertPreviewItem } from '../../stores/preview-actions';
import { isRemoteWorkbenchContentRef, normalizeWorkbenchContentRef, saveRemoteWorkbenchContent } from '../../utils/remote-file-preview';
import { useMermaidDiagrams } from '../../hooks/use-mermaid-diagrams';
import { LinkContextMenu, type LinkContextMenuState } from '../shared/LinkContextMenu';
import { DocumentReferencesBlock, MarkdownPropertiesBlock } from './MarkdownChrome';
import type { PreviewItem } from '../../types';
import previewStyles from '../Preview.module.css';

declare function t(key: string, vars?: Record<string, string | number>): string;

// ── LegacyMediaFallback ──
// image / svg 旧类型 previewItem 的隔离渲染组件。
// currentSessionPath 订阅收窄到此组件，不影响 html/markdown/code/csv 等主流路径。

function LegacyMediaFallback({ previewItem }: { previewItem: PreviewItem }) {
  const currentSessionPath = useStore(s => s.currentSessionPath);

  if (process.env.NODE_ENV !== 'production') {
    console.warn('[PreviewRenderer] 旧类型 image/svg previewItem，走 fallback，请通过文件重新打开以使用新 MediaViewer');
  }

  const onOpen = () => {
    if (!previewItem.filePath || !previewItem.ext) return;
    const context = currentSessionPath
      ? { origin: 'session' as const, sessionPath: currentSessionPath }
      : { origin: 'desk' as const };
    openFilePreview(previewItem.filePath, previewItem.title, previewItem.ext, context);
  };

  return (
    <div
      onClick={onOpen}
      role="button"
      tabIndex={0}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: 200,
        color: 'var(--text-muted)',
        cursor: 'default',
        fontSize: '0.85rem',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--text)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-muted)'; }}
    >
      <span>{window.t?.('preview.legacyImageUpgrade') ?? 'This image preview has been upgraded. Click to open in the new viewer.'}</span>
    </div>
  );
}

interface PreviewRendererProps {
  previewItem: PreviewItem;
}

function missingPreviewTitle(): string {
  const translated = window.t?.('preview.fileMovedOrDeleted');
  return translated && translated !== 'preview.fileMovedOrDeleted'
    ? translated
    : 'The original draft was moved or deleted';
}

function MissingPreviewTarget({ previewItem }: { previewItem: PreviewItem }) {
  const label = previewItem.title || previewItem.filePath || '';

  return (
    <div className={previewStyles.previewUnavailable} role="status" data-testid="preview-missing-target">
      <p>{missingPreviewTitle()}</p>
      {label && <span title={label}>{label}</span>}
    </div>
  );
}

// ── HtmlPreview ──
// HTML 内容由 server 注册为 token 化短期文档；右侧 Preview 只承载本地
// artifact/file-backed HTML，用 DOM iframe 渲染，外部网页访问交给内置浏览器。

function HtmlPreview({ previewItem }: { previewItem: PreviewItem }) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setPreviewUrl(null);
    setError(null);

    lucFetch('/api/preview/html', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: previewItem.title,
        content: previewItem.content,
        sourceFilePath: previewItem.filePath,
        sourceRootPath: previewItem.sourceRootPath,
      }),
    })
      .then(async (res) => {
        const data = await res.json().catch(() => null);
        if (!data || typeof data.previewUrl !== 'string' || !data.previewUrl) {
          throw new Error('invalid html preview response');
        }
        if (!cancelled) setPreviewUrl(data.previewUrl);
      })
      .catch((err) => {
        console.error('[PreviewRenderer] HTML preview registration failed:', err);
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });

    return () => {
      cancelled = true;
    };
  }, [previewItem.content, previewItem.filePath, previewItem.sourceRootPath, previewItem.title]);

  if (error) {
    return <pre className="preview-code">{error}</pre>;
  }

  return (
    <iframe
      className="preview-html-frame"
      data-html-preview-frame=""
      title={previewItem.title}
      src={previewUrl || 'about:blank'}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
    />
  );
}

// ── MarkdownPreview ──

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function coverLayout(cover: MarkdownCover): Required<MarkdownCoverLayoutPatch> {
  return {
    displayWidth: clamp(cover.displayWidth ?? 100, 40, 100),
    displayHeight: clamp(cover.displayHeight ?? 320, 160, 720),
    positionX: clamp(cover.positionX ?? 50, 0, 100),
    positionY: clamp(cover.positionY ?? 50, 0, 100),
  };
}

function remoteWorkbenchCoverImageUrl(previewItem: PreviewItem, image: string | null | undefined): string | null {
  if (!image || !isRemoteWorkbenchContentRef(previewItem.remoteContentRef)) return null;
  if (isExternalCoverImagePath(image)) return image;
  const normalized = normalizeWorkbenchContentRef(previewItem.remoteContentRef);
  const parts = image.replace(/^\.?\//, '').split('/').filter(Boolean);
  const name = parts.pop();
  if (!name) return null;
  const subdir = [normalized.subdir, ...parts].filter(Boolean).join('/');
  const params = new URLSearchParams();
  params.set('mountId', normalized.mountId || normalized.rootId || 'default');
  params.set('subdir', subdir);
  params.set('name', name);
  return `/api/workbench/content?${params.toString()}`;
}

function markdownCoverTargetForPreviewItem(previewItem: PreviewItem): MarkdownCoverTargetInput | null {
  if (previewItem.filePath) return { filePath: previewItem.filePath };
  if (!isRemoteWorkbenchContentRef(previewItem.remoteContentRef)) return null;
  const normalized = normalizeWorkbenchContentRef(previewItem.remoteContentRef);
  return {
    target: {
      kind: 'workbench-file',
      mountId: normalized.mountId || normalized.rootId || 'default',
      rootId: normalized.rootId || normalized.mountId || 'default',
      subdir: normalized.subdir || '',
      name: normalized.name,
    },
  };
}

async function writeMarkdownPreviewContent(previewItem: PreviewItem, content: string) {
  if (isRemoteWorkbenchContentRef(previewItem.remoteContentRef)) {
    const result = await saveRemoteWorkbenchContent(previewItem.remoteContentRef, content, previewItem.fileVersion ?? null);
    return { result, nextVersion: result.version ?? null };
  }
  if (!previewItem.filePath || !window.platform?.writeFileIfUnchanged) return null;
  const result = await window.platform.writeFileIfUnchanged(previewItem.filePath, content, previewItem.fileVersion || null);
  return { result, nextVersion: result?.version ?? null };
}

function MarkdownCoverView({ previewItem, cover }: { previewItem: PreviewItem; cover: MarkdownCover }) {
  const [layout, setLayout] = useState(() => coverLayout(cover));
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [coverDropActive, setCoverDropActive] = useState(false);
  const layoutRef = useRef(layout);
  const dragRef = useRef<null | {
    kind: 'position' | 'height';
    startY: number;
    startLayout: Required<MarkdownCoverLayoutPatch>;
  }>(null);

  useEffect(() => {
    setLayout(coverLayout(cover));
  }, [cover.displayHeight, cover.displayWidth, cover.positionX, cover.positionY, cover.image]);

  useEffect(() => {
    layoutRef.current = layout;
  }, [layout]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [menu]);

  const remoteImageUrl = remoteWorkbenchCoverImageUrl(previewItem, cover.image);
  const imagePath = remoteImageUrl ? null : resolveMarkdownCoverImagePath(previewItem.filePath, cover.image);
  const imageUrl = remoteImageUrl || (imagePath && isExternalCoverImagePath(imagePath)
    ? imagePath
    : imagePath ? window.platform?.getFileUrl?.(imagePath) || imagePath : null);
  const coverTarget = useMemo(() => markdownCoverTargetForPreviewItem(previewItem), [previewItem]);

  const persistLayout = useCallback(async (nextLayout: Required<MarkdownCoverLayoutPatch>) => {
    const writeNext = async (content: string, version: PreviewItem['fileVersion']) => {
      const nextContent = updateMarkdownCoverLayout(content, nextLayout);
      const result = await writeMarkdownPreviewContent({ ...previewItem, fileVersion: version }, nextContent);
      return { result: result?.result, nextContent, nextVersion: result?.nextVersion };
    };

    let { result, nextContent, nextVersion } = await writeNext(previewItem.content, previewItem.fileVersion);
    if (!result?.ok && result?.conflict && previewItem.filePath && window.platform?.readFileSnapshot) {
      const snapshot = await window.platform.readFileSnapshot(previewItem.filePath);
      if (snapshot?.content != null) {
        ({ result, nextContent, nextVersion } = await writeNext(snapshot.content, snapshot.version));
      }
    }

    if (result?.ok) {
      upsertPreviewItem({ ...previewItem, content: nextContent, fileVersion: nextVersion });
      return;
    }
    dispatchCoverNotice(
      window.t?.('preview.coverLayoutSaveFailed') ?? 'Failed to save cover layout. The file may have been modified externally.',
      'error',
    );
  }, [previewItem]);

  const deleteCover = useCallback(async () => {
    setMenu(null);
    const writeNext = async (content: string, version: PreviewItem['fileVersion']) => {
      const nextContent = removeMarkdownCover(content);
      if (nextContent === content) return { result: { ok: true, version }, nextContent, nextVersion: version };
      const result = await writeMarkdownPreviewContent({ ...previewItem, fileVersion: version }, nextContent);
      return { result: result?.result, nextContent, nextVersion: result?.nextVersion };
    };

    let { result, nextContent, nextVersion } = await writeNext(previewItem.content, previewItem.fileVersion);
    if (!result?.ok && result?.conflict && previewItem.filePath && window.platform?.readFileSnapshot) {
      const snapshot = await window.platform.readFileSnapshot(previewItem.filePath);
      if (snapshot?.content != null) {
        ({ result, nextContent, nextVersion } = await writeNext(snapshot.content, snapshot.version));
      }
    }

    if (result?.ok) {
      upsertPreviewItem({ ...previewItem, content: nextContent, fileVersion: nextVersion });
      dispatchCoverNotice(window.t?.('preview.coverDeleted') ?? 'Cover removed.', 'success');
      return;
    }
    dispatchCoverNotice(
      window.t?.('preview.coverDeleteFailed') ?? 'Failed to remove cover. The file may have been modified externally.',
      'error',
    );
  }, [previewItem]);

  const finishDrag = useCallback(() => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (drag) void persistLayout(layoutRef.current);
  }, [persistLayout]);

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const dy = event.clientY - drag.startY;
      if (drag.kind === 'height') {
        setLayout(prev => ({
          ...prev,
          displayHeight: clamp(drag.startLayout.displayHeight + dy, 160, 720),
        }));
      } else {
        const delta = (dy / Math.max(1, drag.startLayout.displayHeight)) * 100;
        setLayout(prev => ({
          ...prev,
          positionY: clamp(drag.startLayout.positionY - delta, 0, 100),
        }));
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', finishDrag);
    window.addEventListener('pointercancel', finishDrag);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', finishDrag);
      window.removeEventListener('pointercancel', finishDrag);
    };
  }, [finishDrag]);

  const beginDrag = useCallback((kind: 'position' | 'height', event: React.PointerEvent) => {
    event.preventDefault();
    setMenu(null);
    dragRef.current = {
      kind,
      startY: event.clientY,
      startLayout: layout,
    };
  }, [layout]);

  const saveImage = useCallback(async () => {
    setMenu(null);
    await saveMarkdownCoverImage(imagePath);
  }, [imagePath]);

  const regenerateWithPrompt = useCallback(async () => {
    setMenu(null);
    await regenerateMarkdownCoverWithPrompt(coverTarget);
  }, [coverTarget]);

  const handleCoverDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!coverTarget || !hasMarkdownCoverDropImage(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'copy';
    setCoverDropActive(true);
  }, [coverTarget]);

  const handleCoverDragLeave = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
    setCoverDropActive(false);
  }, []);

  const handleCoverDrop = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!coverTarget || !hasMarkdownCoverDropImage(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    setCoverDropActive(false);
    void applyMarkdownCoverImageDrop({
      ...coverTarget,
      dataTransfer: event.dataTransfer,
    });
  }, [coverTarget]);

  if (!imageUrl) return null;

  return (
    <div
      className={`markdown-cover${coverDropActive ? ' markdown-cover-drop-active' : ''}`}
      style={{
        width: `${layout.displayWidth}%`,
        height: `${layout.displayHeight}px`,
        marginLeft: 'auto',
        marginRight: 'auto',
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        setMenu({ x: event.clientX, y: event.clientY });
      }}
      onDragOver={handleCoverDragOver}
      onDragLeave={handleCoverDragLeave}
      onDrop={handleCoverDrop}
    >
      <img
        src={imageUrl}
        alt=""
        draggable={false}
        style={{ objectPosition: `${layout.positionX}% ${layout.positionY}%` }}
        onPointerDown={(event) => beginDrag('position', event)}
      />
      <div
        className="markdown-cover-resize"
        role="separator"
        aria-orientation="horizontal"
        onPointerDown={(event) => beginDrag('height', event)}
      />
      {menu && (
        <div
          className="markdown-cover-menu"
          style={{ left: `${menu.x}px`, top: `${menu.y}px` }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button type="button" onClick={saveImage}>{t('preview.cover.saveImage')}</button>
          <button type="button" onClick={regenerateWithPrompt}>{t('preview.cover.regenerateWithPrompt')}</button>
          <button type="button" className="markdown-cover-menu-danger" onClick={deleteCover}>{t('preview.cover.deleteCover')}</button>
        </div>
      )}
    </div>
  );
}

function isMarkdownTopCoverDrop(event: DragEvent<HTMLElement>): boolean {
  const rect = event.currentTarget.getBoundingClientRect();
  const y = Number.isFinite(event.clientY) ? event.clientY : rect.top;
  return y >= rect.top && y <= rect.top + 40;
}

function MarkdownCoverDropRail({ active }: { active: boolean }) {
  return (
    <div
      aria-hidden="true"
      className={`markdown-cover-drop-rail${active ? ' markdown-cover-drop-rail-active' : ''}`}
    />
  );
}

function MarkdownNoCoverDropHost({ coverTarget, children }: { coverTarget: MarkdownCoverTargetInput | null; children: ReactNode }) {
  const [active, setActive] = useState(false);

  const handleDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!coverTarget || !hasMarkdownCoverDropImage(event.dataTransfer) || !isMarkdownTopCoverDrop(event)) {
      setActive(false);
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'copy';
    setActive(true);
  }, [coverTarget]);

  const handleDragLeave = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
    setActive(false);
  }, []);

  const handleDrop = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!coverTarget || !hasMarkdownCoverDropImage(event.dataTransfer) || !isMarkdownTopCoverDrop(event)) return;
    event.preventDefault();
    event.stopPropagation();
    setActive(false);
    void applyMarkdownCoverImageDrop({
      ...coverTarget,
      dataTransfer: event.dataTransfer,
    });
  }, [coverTarget]);

  if (!coverTarget) return <>{children}</>;
  return (
    <div
      className="markdown-cover-drop-host"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <MarkdownCoverDropRail active={active} />
      {children}
    </div>
  );
}

function MarkdownPreview({ previewItem }: { previewItem: PreviewItem }) {
  const divRef = useRef<HTMLDivElement>(null);
  const [linkMenu, setLinkMenu] = useState<LinkContextMenuState | null>(null);
  const cover = useMemo(() => parseMarkdownCover(previewItem.content), [previewItem.content]);
  const coverTarget = useMemo(() => markdownCoverTargetForPreviewItem(previewItem), [previewItem]);
  const body = useMemo(() => stripMarkdownFrontMatterForPreview(previewItem.content), [previewItem.content]);
  const linkContext = useMemo<LinkOpenContext>(() => ({
    origin: 'desk',
    baseFilePath: previewItem.filePath,
  }), [previewItem.filePath]);

  const findAnchor = useCallback((event: MouseEvent): HTMLAnchorElement | null => {
    const root = divRef.current;
    const target = event.target;
    if (!root || !(target instanceof Element)) return null;
    const anchor = target.closest<HTMLAnchorElement>('a[href]');
    if (!anchor || !root.contains(anchor)) return null;
    return anchor;
  }, []);

  const handleLinkClick = useCallback((event: MouseEvent) => {
    const anchor = findAnchor(event);
    if (!anchor) return;
    const href = anchor.getAttribute('href') || '';
    const context = {
      ...linkContext,
      label: anchor.textContent?.trim() || undefined,
    };
    const target = resolveLinkTarget(href, context);
    if (target.kind === 'anchor') return;
    event.preventDefault();
    event.stopPropagation();
    void (async () => {
      if (target.kind === 'file' && /\.(md|markdown|mdx|txt|csv|json|ya?ml)$/i.test(target.filePath) && window.platform?.readFileSnapshot) {
        const snapshot = await window.platform.readFileSnapshot(target.filePath).catch(() => null);
        if (!snapshot) {
          showError(`Link target not found: ${target.filePath}`);
          return;
        }
      }
      await openInternalLink(href, context);
    })();
  }, [findAnchor, linkContext]);

  const handleLinkContextMenu = useCallback((event: MouseEvent) => {
    const anchor = findAnchor(event);
    if (!anchor) return;
    event.preventDefault();
    event.stopPropagation();
    setLinkMenu({
      href: anchor.getAttribute('href') || '',
      context: {
        ...linkContext,
        label: anchor.textContent?.trim() || undefined,
      },
      position: { x: event.clientX, y: event.clientY },
    });
  }, [findAnchor, linkContext]);

  useEffect(() => {
    if (divRef.current) {
      injectCopyButtons(divRef.current);
      return observeMarkdownRhythmSnap(divRef.current);
    }
  }, [body]);
  useMermaidDiagrams(divRef, [body]);

  return (
    <>
      <div className={previewStyles.markdownPreviewDocument}>
        {cover && <MarkdownCoverView previewItem={previewItem} cover={cover} />}
        {cover ? (
          <>
            <MarkdownPropertiesBlock content={previewItem.content} />
            <div
              ref={divRef}
              className="preview-markdown md-content markdown-has-cover"
              onClick={handleLinkClick}
              onContextMenu={handleLinkContextMenu}
              dangerouslySetInnerHTML={{
                __html: renderMarkdownPreview(body, {
                  filePath: previewItem.filePath,
                  getFileUrl: window.platform?.getFileUrl,
                }),
              }}
            />
            <DocumentReferencesBlock previewItem={previewItem} />
          </>
        ) : (
          <MarkdownNoCoverDropHost coverTarget={coverTarget}>
            <MarkdownPropertiesBlock content={previewItem.content} />
            <div
              ref={divRef}
              className="preview-markdown md-content"
              onClick={handleLinkClick}
              onContextMenu={handleLinkContextMenu}
              dangerouslySetInnerHTML={{
                __html: renderMarkdownPreview(body, {
                  filePath: previewItem.filePath,
                  getFileUrl: window.platform?.getFileUrl,
                }),
              }}
            />
            <DocumentReferencesBlock previewItem={previewItem} />
          </MarkdownNoCoverDropHost>
        )}
      </div>
      {linkMenu && (
        <LinkContextMenu
          state={linkMenu}
          onClose={() => setLinkMenu(null)}
        />
      )}
    </>
  );
}

// ── CsvPreview ──

function CsvPreview({ content }: { content: string }) {
  const rows = parseCSV(content);
  if (rows.length === 0) {
    return <div className="preview-csv"><table /></div>;
  }

  const headerRow = rows[0];
  const bodyRows = rows.slice(1);

  return (
    <div className="preview-csv">
      <table>
        <thead>
          <tr>
            {headerRow.map((cell, i) => (
              <th key={`csv-h-${i}`}>{cell}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {bodyRows.map((row, ri) => (
            <tr key={`csv-r-${ri}`}>
              {row.map((cell, ci) => (
                <td key={`csv-c-${ri}-${ci}`}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── PdfPreview ──
// sourceUrl 是新路径；content/base64 只保留给旧 previewItem 兼容。

function appendPdfViewerHash(url: string): string {
  if (!url || url === 'about:blank') return url;
  const params = 'toolbar=0&navpanes=0';
  const hashIndex = url.indexOf('#');
  if (hashIndex < 0) return `${url}#${params}`;
  const prefix = url.slice(0, hashIndex + 1);
  const hash = url.slice(hashIndex + 1);
  return `${prefix}${hash ? `${hash}&` : ''}${params}`;
}

function PdfPreview({ previewItem }: { previewItem: PreviewItem }) {
  const source = useMemo(() => {
    if (previewItem.sourceUrl) {
      return { url: previewItem.sourceUrl, revoke: false };
    }
    if (!previewItem.content) {
      return { url: 'about:blank', revoke: false };
    }
    const raw = atob(previewItem.content);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    if (typeof URL.createObjectURL !== 'function') {
      return { url: `data:application/pdf;base64,${previewItem.content}`, revoke: false };
    }
    return { url: URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' })), revoke: true };
  }, [previewItem.content, previewItem.sourceUrl]);

  useEffect(() => {
    return () => {
      if (source.revoke) URL.revokeObjectURL(source.url);
    };
  }, [source]);

  return <iframe className="preview-pdf" src={appendPdfViewerHash(source.url)} />;
}

// ── FileInfoPreview ──

function FileInfoPreview({ previewItem }: { previewItem: PreviewItem }) {
  const t = window.t ?? ((p: string) => p);
  const ext = previewItem.ext || '';

  return (
    <div className="preview-file-info">
      <div
        className="preview-file-icon"
        dangerouslySetInnerHTML={{ __html: fileIconSvg(ext) }}
      />
      <div className="preview-file-name">{previewItem.title}</div>
      <div className="preview-file-ext">
        {ext.toUpperCase()} {t('desk.fileLabel')}
      </div>
      <button
        className="preview-file-open-btn"
        onClick={() => {
          if (previewItem.filePath) window.platform?.openFile?.(previewItem.filePath);
        }}
      >
        {t('desk.openWithDefault')}
      </button>
    </div>
  );
}

// ── PreviewRenderer ──

export function PreviewRenderer({ previewItem }: PreviewRendererProps) {
  if (previewItem.status === 'missing') {
    return <MissingPreviewTarget previewItem={previewItem} />;
  }

  switch (previewItem.type) {
    case 'html':
      return <HtmlPreview previewItem={previewItem} />;

    case 'markdown':
      return <MarkdownPreview previewItem={previewItem} />;

    case 'code':
      return (
        <pre className="preview-code">
          <code className={previewItem.language ? `language-${previewItem.language}` : undefined}>
            {previewItem.content}
          </code>
        </pre>
      );

    case 'csv':
      return <CsvPreview content={previewItem.content} />;

    // image / svg：旧类型 previewItem 的 fallback。新路径不再产生此类 previewItem，
    // 持久化或旧 session 恢复时可能命中。点击后按 owner 路由到统一的 MediaViewer。
    case 'image':
    case 'svg':
      return <LegacyMediaFallback previewItem={previewItem} />;

    case 'pdf':
      return <PdfPreview previewItem={previewItem} />;

    case 'docx':
      return (
        <div
          className="preview-docx md-content"
          dangerouslySetInnerHTML={{ __html: previewItem.content }}
        />
      );

    case 'xlsx':
      return (
        <div
          className="preview-csv"
          dangerouslySetInnerHTML={{ __html: previewItem.content }}
        />
      );

    case 'file-info':
      return <FileInfoPreview previewItem={previewItem} />;

    default:
      return (
        <pre className="preview-code">{previewItem.content}</pre>
      );
  }
}
