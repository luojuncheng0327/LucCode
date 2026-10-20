import { useStore } from './index';
import { sessionScopedKey, sessionScopedValue, type SessionLocatorState } from './session-slice';

export interface BrowserSessionState {
  running: boolean;
  url: string | null;
  thumbnail: string | null;
  thumbnailCapturedAt?: number | null;
  thumbnailUrl?: string | null;
  thumbnailFresh?: boolean;
  /** 聊天区浮动卡片被用户收起。纯前端展示状态，不影响浏览器本身是否运行。 */
  collapsed?: boolean;
}

export interface BrowserSlice {
  /** 按 session identity 存储的 browser 状态。legacy path key 只做读时兼容。 */
  browserBySession: Record<string, BrowserSessionState>;
}

export const createBrowserSlice = (
  set: (partial: Partial<BrowserSlice>) => void
): BrowserSlice => ({
  browserBySession: {},
});

// ── Selector hook ──

const DEFAULT_BROWSER_STATE = {
  running: false,
  url: null as string | null,
  thumbnail: null as string | null,
  thumbnailCapturedAt: null as number | null,
  thumbnailUrl: null as string | null,
  thumbnailFresh: false,
  collapsed: false,
};

export function browserStateForPath(
  state: SessionLocatorState & Pick<BrowserSlice, 'browserBySession'>,
  sessionPath?: string | null,
): BrowserSessionState {
  const sp = sessionPath ?? state.currentSessionPath;
  if (!sp) return DEFAULT_BROWSER_STATE;
  return sessionScopedValue(state, state.browserBySession, sp) || DEFAULT_BROWSER_STATE;
}

export function setBrowserStateForPath(
  sessionPath: string,
  value: BrowserSessionState,
): void {
  useStore.setState((state) => {
    const key = sessionScopedKey(state, sessionPath) || sessionPath;
    const browserBySession = { ...(state.browserBySession || {}), [key]: value };
    if (key !== sessionPath) delete browserBySession[sessionPath];
    return { browserBySession };
  });
}

/**
 * 收起 / 展开聊天区的浏览器浮动卡片。合并写：只改 collapsed，其它字段沿用当前记录，
 * 这样"收起卡片"不会顺带擦掉 url / 缩略图等运行时状态。
 */
export function setBrowserCardCollapsed(sessionPath: string, collapsed: boolean): void {
  useStore.setState((state) => {
    const key = sessionScopedKey(state, sessionPath) || sessionPath;
    const prev = sessionScopedValue(state, state.browserBySession, sessionPath) || DEFAULT_BROWSER_STATE;
    const browserBySession = { ...(state.browserBySession || {}), [key]: { ...prev, collapsed } };
    if (key !== sessionPath) delete browserBySession[sessionPath];
    return { browserBySession };
  });
}

export function clearBrowserStateForPath(sessionPath: string): void {
  useStore.setState((state) => {
    const key = sessionScopedKey(state, sessionPath) || sessionPath;
    const browserBySession = { ...(state.browserBySession || {}) };
    delete browserBySession[key];
    if (key !== sessionPath) delete browserBySession[sessionPath];
    return { browserBySession };
  });
}

/** 获取指定 session 的浏览器状态。组件中使用此 hook 替代全局 browserRunning/browserUrl/browserThumbnail */
export function useBrowserState(sessionPath?: string | null) {
  return useStore(st => {
    return browserStateForPath(st, sessionPath);
  });
}

/** 判断是否有任何 session 的浏览器正在运行 */
export function useAnyBrowserRunning() {
  return useStore(st => Object.values(st.browserBySession).some(b => b.running));
}
