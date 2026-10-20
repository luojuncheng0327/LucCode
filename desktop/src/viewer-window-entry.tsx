/**
 * viewer-window-entry.tsx — 派生 Viewer 窗口的 React 入口
 *
 * 语义：
 * - 派生出的只读副本窗口，展示主面板某个 tab 对应的本地文件
 * - 只读：viewer 读取启动时传入的本地文件内容
 * - 与主面板 preview **不通信**（不 dock、不回写、不共享 zustand store）
 * - 仅支持可编辑文本类型（markdown / code / csv），其他类型的 tab 在主面板不提供「在新窗口查看」入口
 *
 * 生命周期：
 *   主进程 spawn BrowserWindow → 渲染侧挂载后主动 IPC `viewer-request-load` 拉取文件元信息
 *   → readFile → 渲染 PreviewEditor(readOnly)
 *   → 窗口 close → 主进程广播 `viewer-closed` 给主 renderer 清 store
 *
 * 拉取而非推送：主进程曾在 did-finish-load 时一次性 `send('viewer-load', ...)` 推送，
 * 渲染侧在 useEffect 里注册监听（晚于 commit+paint）。推送早于注册会导致 payload
 * 永久丢失，窗口卡死在 Loading（冷启动下 V8 首编译 + splash 抢 CPU 几乎必现）。
 * 拉取契约下 payload 常驻主进程 Map，渲染侧任何时候发起请求都能拿到。
 */

import { createRoot } from 'react-dom/client';
import { useEffect, useState } from 'react';
import { PreviewEditor } from './react/components/PreviewEditor';
import { retainViewerLocalFileResourceWatch } from './viewer-resource-events';

type ViewerMode = 'markdown' | 'code' | 'csv';

interface ViewerLoadPayload {
  filePath: string;
  title: string;
  type: string;
  language?: string | null;
  windowId: number;
}

function typeToMode(type: string): ViewerMode {
  if (type === 'markdown') return 'markdown';
  if (type === 'csv') return 'csv';
  return 'code';
}

// Subset of the renderer-side `window.platform` we use in the viewer.
interface ViewerPlatform {
  getServerPort?(): Promise<string | number | null | undefined>;
  getServerToken?(): Promise<string | null | undefined>;
  readFile(path: string): Promise<string | null>;
  viewerRequestLoad?(): Promise<ViewerLoadPayload | null>;
  viewerClose?(): void;
}

function getPlatform(): ViewerPlatform | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- window.platform is injected by preload
  return (window as any).platform ?? null;
}

function fileUnavailableError(payload: ViewerLoadPayload): Error {
  return new Error(`File is no longer available: ${payload.title || payload.filePath}`);
}

export function ViewerApp() {
  const [payload, setPayload] = useState<ViewerLoadPayload | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [requestFailed, setRequestFailed] = useState(false);

  // 1. 挂载后主动拉取文件元信息（显式请求，不依赖主进程推送时机）
  useEffect(() => {
    let cancelled = false;
    const platform = getPlatform();
    if (!platform?.viewerRequestLoad) {
      setRequestFailed(true);
      return;
    }
    platform.viewerRequestLoad()
      .then((data) => {
        if (cancelled) return;
        if (!data) {
          setRequestFailed(true);
          return;
        }
        setPayload(data);
        setLoadError(null);
        document.title = data.title || 'Viewer';
      })
      .catch((err) => {
        if (cancelled) return;
        console.error('[viewer] viewer-request-load failed:', err);
        setRequestFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 2. 初始读取 + 后端 ResourceEvent live reload
  useEffect(() => {
    if (!payload?.filePath) return;
    const platform = getPlatform();
    if (!platform) return;

    let cancelled = false;

    const fail = (err: unknown) => {
      if (cancelled) return;
      const message = err instanceof Error ? err.message : String(err);
      console.error('[viewer] live file load failed:', err);
      setLoadError(message);
    };

    const reload = () => {
      platform.readFile(payload.filePath)
        .then((c) => {
          if (cancelled) return;
          if (c == null) {
            fail(fileUnavailableError(payload));
            return;
          }
          setLoadError(null);
          setContent(c);
        })
        .catch(fail);
    };

    reload();
    const watch = retainViewerLocalFileResourceWatch(payload.filePath, platform, {
      onChanged: reload,
    });
    watch.ready.catch((err) => {
      if (cancelled) return;
      console.warn('[viewer] ResourceIO live reload unavailable:', err);
    });

    return () => {
      cancelled = true;
      watch.release();
    };
  }, [payload?.filePath]);

  const handleClose = () => getPlatform()?.viewerClose?.();

  if (requestFailed) {
    return (
      <div style={{ padding: 20, color: 'var(--text-muted)', fontSize: 13 }}>
        Failed to load viewer content: no payload available for this window.
      </div>
    );
  }

  if (!payload) {
    return (
      <div style={{ padding: 20, color: 'var(--text-muted)', fontSize: 13 }}>
        Loading…
      </div>
    );
  }

  if (loadError) {
    return (
      <div style={{ padding: 20, color: 'var(--text-muted)', fontSize: 13 }}>
        Failed to load file: {loadError}
      </div>
    );
  }

  const mode = typeToMode(payload.type);

  return (
    <>
      <div className="viewer-toolbar">
        <div className="viewer-title">{payload.title}</div>
        <button className="viewer-close-btn" onClick={handleClose} title="Close">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
      <div className="viewer-body">
        {content != null && (
          <PreviewEditor
            content={content}
            filePath={payload.filePath}
            mode={mode}
            language={payload.language}
            readOnly
          />
        )}
      </div>
      <div className="viewer-readonly-badge">只读 · live</div>
    </>
  );
}

// Mount
const rootEl = document.getElementById('react-root');
if (rootEl) {
  createRoot(rootEl).render(<ViewerApp />);
}
