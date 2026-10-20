/**
 * sidebar-ui-slice — 侧边栏 UI 偏好（session 行高 + 项目视图折叠状态）
 *
 * 这份偏好属于整个侧边栏，不属于某一个组件实例：主侧栏和悬浮侧栏会各自挂载
 * SessionList，悬浮侧栏每次 hover 都是全新实例。偏好曾经是组件本地 state、
 * 挂载后才异步拉取，于是每次重挂载都会先按默认值渲染（双行）再跳回用户设置的
 * 单行，前端繁忙时这段窗口肉眼可见。状态提升到 store 后：加载只做一次，实例
 * 只读；store 初值同步取 localStorage 上次已知值，首帧就是对的。
 *
 * server 仍是唯一持久真相，localStorage 只是首帧缓存，不参与冲突仲裁。
 */

import { lucFetch } from '../hooks/use-luc-fetch';
import {
  normalizeSidebarUiPrefs,
  type SidebarUiPrefs,
} from '../../../../shared/sidebar-ui-state.ts';

export const SIDEBAR_UI_PREFS_CACHE_KEY = 'luc-sidebar-ui-prefs';

/** 首次加载失败后的重试节奏；三连败后放弃，等下一次连接变化再试。 */
const SIDEBAR_UI_PREF_RETRY_DELAYS_MS = [300, 600] as const;

export function readCachedSidebarUiPrefs(): SidebarUiPrefs {
  try {
    const raw = window.localStorage?.getItem(SIDEBAR_UI_PREFS_CACHE_KEY);
    if (!raw) return normalizeSidebarUiPrefs({});
    return normalizeSidebarUiPrefs(JSON.parse(raw));
  } catch {
    // 缓存损坏只影响首帧观感：回默认值并等 server，不影响 server 加载路径的报错。
    return normalizeSidebarUiPrefs({});
  }
}

export function writeCachedSidebarUiPrefs(prefs: SidebarUiPrefs): void {
  try {
    window.localStorage?.setItem(SIDEBAR_UI_PREFS_CACHE_KEY, JSON.stringify(prefs));
  } catch {
    // localStorage can be unavailable in tests or privacy modes.
  }
}

function normalizeSidebarUiResponse(data: unknown): SidebarUiPrefs {
  const raw = data && typeof data === 'object' && !Array.isArray(data)
    ? (data as { sidebarUi?: unknown })
    : {};
  return normalizeSidebarUiPrefs(raw.sidebarUi || data);
}

export interface SidebarUiSlice {
  sidebarUiPrefs: SidebarUiPrefs;
  sidebarUiPrefsLoaded: boolean;
  applySidebarUiPrefs: (data: unknown) => void;
  setSidebarProjectViewPrefs: (patch: {
    collapsedProjectIds?: string[];
    collapsedFolderIds?: string[];
    showAllProjectIds?: string[];
  }) => void;
}

export const createSidebarUiSlice = (
  set: (partial: Partial<SidebarUiSlice>) => void,
  get: () => Pick<SidebarUiSlice, 'sidebarUiPrefs'>,
): SidebarUiSlice => ({
  sidebarUiPrefs: readCachedSidebarUiPrefs(),
  sidebarUiPrefsLoaded: false,
  applySidebarUiPrefs: (data) => {
    const prefs = normalizeSidebarUiResponse(data);
    writeCachedSidebarUiPrefs(prefs);
    set({ sidebarUiPrefs: prefs, sidebarUiPrefsLoaded: true });
  },
  setSidebarProjectViewPrefs: (patch) => {
    const current = get().sidebarUiPrefs;
    const next = normalizeSidebarUiPrefs({
      ...current,
      projectView: {
        collapsedProjectIds: patch.collapsedProjectIds ?? current.projectView.collapsedProjectIds,
        collapsedFolderIds: patch.collapsedFolderIds ?? current.projectView.collapsedFolderIds,
        showAllProjectIds: patch.showAllProjectIds ?? current.projectView.showAllProjectIds,
      },
    });
    writeCachedSidebarUiPrefs(next);
    set({ sidebarUiPrefs: next });
    lucFetch('/api/preferences/sidebar-ui', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectView: next.projectView }),
    }).catch(err => console.warn('[sessions] persist sidebar UI prefs failed:', err));
  },
});

let inFlightLoad: Promise<void> | null = null;

function delay(ms: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, ms); });
}

/**
 * 从 server 拉一次侧边栏 UI 偏好并写入 store。
 * 并发调用只跑一趟；失败按 [300, 600]ms 重试两次，三连败后放弃，
 * 等下一次 activeServerConnection 变化时由 app-init 再调。
 */
export function loadSidebarUiPrefs(): Promise<void> {
  if (inFlightLoad) return inFlightLoad;

  const run = async (): Promise<void> => {
    // store 在这里动态取：index.ts 组装 store 时静态引入本文件，
    // 反向静态引入会让"先加载本文件"的入口拿到未初始化的 slice 工厂。
    const { useStore } = await import('./index');
    for (let attempt = 0; ; attempt += 1) {
      try {
        const res = await lucFetch('/api/preferences/sidebar-ui');
        const data = await res.json();
        useStore.getState().applySidebarUiPrefs(data);
        return;
      } catch (err) {
        const retryDelay = SIDEBAR_UI_PREF_RETRY_DELAYS_MS[attempt];
        if (retryDelay === undefined) {
          console.warn('[sessions] fetch sidebar UI prefs failed:', err);
          return;
        }
        await delay(retryDelay);
      }
    }
  };

  const pending = run().finally(() => {
    if (inFlightLoad === pending) inFlightLoad = null;
  });
  inFlightLoad = pending;
  return pending;
}
