/**
 * BrowserViewerApp.tsx — 浏览器查看器工具栏
 *
 * 工具栏只负责按钮和标签页显示。
 * WebContentsView 由 main.cjs 管理，attach 在工具栏下方区域。
 */

import { useState, useEffect, useMemo, useRef, type WheelEvent } from 'react';
import type { BrowserViewerTab, BrowserViewerUpdate } from '../types';
import { initTheme } from '../bootstrap';

declare function t(key: string): string;
declare function setTheme(name: string): void;

initTheme();

function tr(key: string, fallback: string) {
  try {
    const value = typeof t === 'function' ? t(key) : '';
    return value && value !== key ? value : fallback;
  } catch {
    return fallback;
  }
}

function isThemePayload(value: unknown): value is { theme: string } {
  return typeof value === 'object'
    && value !== null
    && 'theme' in value
    && typeof value.theme === 'string';
}

function tabTitle(tab: BrowserViewerTab) {
  const title = tab.title?.trim();
  if (title) return title;
  if (tab.url) {
    try {
      return new URL(tab.url).hostname || tab.url;
    } catch {
      return tab.url;
    }
  }
  return tr('browser.newTab', 'New Tab');
}

export function BrowserViewerApp() {
  const [canBack, setCanBack] = useState(false);
  const [canForward, setCanForward] = useState(false);
  const [sessionPath, setSessionPath] = useState<string | null>(null);
  const [sessionTitle, setSessionTitle] = useState<string | null>(null);
  const [tabs, setTabs] = useState<BrowserViewerTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const tabListRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const luc = window.luc;

    // 监听主题切换
    luc?.onSettingsChanged?.((type: string, data: unknown) => {
      if (type === 'theme-changed' && isThemePayload(data)) setTheme(data.theme);
    });

    // 接收浏览器状态更新
    luc?.onBrowserUpdate?.((data: BrowserViewerUpdate) => {
      if (Array.isArray(data.tabs)) setTabs(data.tabs);
      if (data.activeTabId !== undefined) setActiveTabId(data.activeTabId);
      if (data.canGoBack !== undefined) setCanBack(data.canGoBack);
      if (data.canGoForward !== undefined) setCanForward(data.canGoForward);
      if (data.sessionPath !== undefined) setSessionPath(data.sessionPath || null);
      if (data.sessionTitle !== undefined) setSessionTitle(data.sessionTitle || null);
      if (data.running === false) {
        setCanBack(false);
        setCanForward(false);
        setTabs([]);
        setActiveTabId(null);
        setSessionPath(data.sessionPath || null);
        setSessionTitle(data.sessionTitle || null);
      }
    });

    // i18n
    window.i18n?.load?.(navigator.language || 'zh');
  }, []);

  const luc = window.luc;
  const activeTab = useMemo(
    () => tabs.find((tab) => tab.tabId === activeTabId) || tabs[0] || null,
    [tabs, activeTabId],
  );

  useEffect(() => {
    if (!activeTab) return;
    if (typeof activeTab.canGoBack === 'boolean') setCanBack(activeTab.canGoBack);
    if (typeof activeTab.canGoForward === 'boolean') setCanForward(activeTab.canGoForward);
  }, [activeTab]);

  const handleTabWheel = (event: WheelEvent<HTMLDivElement>) => {
    const el = tabListRef.current;
    if (!el) return;
    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY)
      ? event.deltaX
      : event.deltaY;
    if (!delta) return;
    el.scrollLeft += delta;
    event.preventDefault();
  };

  return (
    <>
      <div className="toolbar">
        <div className="toolbar-left">
          {/* Close */}
          <button
            className="tb-btn close-btn"
            title={tr('browser.closeBtn', 'Close')}
            onClick={() => luc?.closeBrowserViewer?.()}
          >
            <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round">
              <path d="M4 4l6 6M10 4l-6 6" />
            </svg>
          </button>

          {/* Emergency stop */}
          <button
            className="stop-btn"
            title={tr('browser.emergencyStop', 'Stop')}
            onClick={() => luc?.browserEmergencyStop?.(sessionPath)}
          >
            <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <rect x="3" y="3" width="8" height="8" rx="1" fill="currentColor" stroke="none" />
            </svg>
          </button>

          <div className="nav-sep" />

          {/* Back */}
          <button
            className={`tb-btn${canBack ? '' : ' disabled'}`}
            title={tr('browser.back', 'Back')}
            onClick={() => luc?.browserGoBack?.(sessionPath)}
          >
            <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="M8.5 2.5L4.5 7l4 4.5" />
            </svg>
          </button>

          {/* Forward */}
          <button
            className={`tb-btn${canForward ? '' : ' disabled'}`}
            title={tr('browser.forward', 'Forward')}
            onClick={() => luc?.browserGoForward?.(sessionPath)}
          >
            <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5.5 2.5L9.5 7l-4 4.5" />
            </svg>
          </button>

          {/* Reload */}
          <button
            className="tb-btn"
            title={tr('browser.reload', 'Reload')}
            onClick={() => luc?.browserReload?.(sessionPath)}
          >
            <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
              <path d="M11 7a4 4 0 1 1-4-4" />
              <path d="M11 3v2.5H8.5" />
            </svg>
          </button>
        </div>

        <div className="browser-tab-strip">
          {sessionTitle && (
            <span className="browser-session-label" title={sessionTitle}>
              {sessionTitle}
            </span>
          )}

          <div
            ref={tabListRef}
            className="browser-tab-list"
            onWheel={handleTabWheel}
          >
            {tabs.map((tab) => {
              const isActive = tab.tabId === (activeTab?.tabId || activeTabId);
              return (
                <button
                  key={tab.tabId}
                  className={`browser-tab${isActive ? ' active' : ''}`}
                  title={tabTitle(tab)}
                  onClick={() => luc?.browserSwitchTab?.(tab.tabId, sessionPath)}
                  onDoubleClick={() => luc?.browserCloseTab?.(tab.tabId, sessionPath)}
                >
                  <span className="browser-tab-title">{tabTitle(tab)}</span>
                  <span
                    className="browser-tab-close"
                    title={tr('browser.closeTab', 'Close tab')}
                    onClick={(event) => {
                      event.stopPropagation();
                      luc?.browserCloseTab?.(tab.tabId, sessionPath);
                    }}
                    onDoubleClick={(event) => event.stopPropagation()}
                  >
                    <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
                      <path d="M4.5 4.5l5 5M9.5 4.5l-5 5" />
                    </svg>
                  </span>
                </button>
              );
            })}
          </div>

          <button
            className="tb-btn new-tab-btn"
            title={tr('browser.newTab', 'New Tab')}
            onClick={() => luc?.browserNewTab?.(sessionPath)}
          >
            <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
              <path d="M7 3v8M3 7h8" />
            </svg>
          </button>
        </div>

        <div className="toolbar-drag" />
      </div>

      {/* Card shadow frame (WebContentsView sits on top) */}
      <div className="card-frame">
        {tabs.length === 0 && (
          <div className="browser-empty-state">
            <p className="browser-empty-text">{tr('browser.emptyWorkspace', 'No open tabs')}</p>
            <button
              className="browser-empty-action"
              onClick={() => luc?.browserNewTab?.(sessionPath)}
            >
              {tr('browser.newTab', 'New Tab')}
            </button>
          </div>
        )}
      </div>
    </>
  );
}
