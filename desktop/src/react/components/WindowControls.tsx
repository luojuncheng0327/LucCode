/**
 * WindowControls.tsx — Windows/Linux 自绘窗口控制按钮（最小化、最大化、关闭）
 *
 * 共享组件，同时用于主窗口（App.tsx）和设置窗口（SettingsApp.tsx）。
 * macOS 和 Web 环境下不渲染。
 */

import type { MouseEvent } from 'react';
import { useEffect, useState, useCallback } from 'react';

export function WindowControls() {
  const t = window.t ?? ((p: string) => p);
  const [isWin, setIsWin] = useState(false);
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const p = window.platform;
    if (!p?.getPlatform) return;
    p.getPlatform().then((plat: string) => {
      if (plat !== 'darwin' && plat !== 'web') setIsWin(true);
    });
    if (p.onMaximizeChange) {
      p.onMaximizeChange((val: boolean) => setMaximized(val));
    }
    p.windowIsMaximized?.().then((val: boolean) => setMaximized(val));
  }, []);

  const minimize = useCallback(() => window.platform?.windowMinimize?.(), []);
  const maximize = useCallback(() => window.platform?.windowMaximize?.(), []);
  const close = useCallback(() => window.platform?.windowClose?.(), []);
  const preventFocus = useCallback((event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
  }, []);

  if (!isWin) return null;

  return (
    <div className="window-controls">
      <button className="wc-btn wc-minimize" type="button" tabIndex={-1} title={t('window.minimize')} onMouseDown={preventFocus} onClick={minimize}>
        <svg width="12" height="12" viewBox="0 0 12 12"><line x1="2" y1="6" x2="10" y2="6" stroke="currentColor" strokeWidth="1"/></svg>
      </button>
      <button className="wc-btn wc-maximize" type="button" tabIndex={-1} title={t('window.maximize')} onMouseDown={preventFocus} onClick={maximize}>
        <svg width="12" height="12" viewBox="0 0 12 12">
          {maximized
            ? <><rect x="3" y="1" width="7" height="7" fill="none" stroke="currentColor" strokeWidth="1"/><rect x="1" y="3" width="7" height="7" fill="none" stroke="currentColor" strokeWidth="1"/></>
            : <rect x="2" y="2" width="8" height="8" fill="none" stroke="currentColor" strokeWidth="1"/>
          }
        </svg>
      </button>
      <button className="wc-btn wc-close" type="button" tabIndex={-1} title={t('window.close')} onMouseDown={preventFocus} onClick={close}>
        <svg width="12" height="12" viewBox="0 0 12 12"><line x1="2" y1="2" x2="10" y2="10" stroke="currentColor" strokeWidth="1"/><line x1="10" y1="2" x2="2" y2="10" stroke="currentColor" strokeWidth="1"/></svg>
      </button>
    </div>
  );
}
