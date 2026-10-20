/**
 * desk-actions.ts — 工作台文件操作（纯函数，不依赖 DOM）
 *
 * 从 desk-shim.ts 提取，供 React 组件直接调用。
 */

import { useStore } from './index';
import { lucFetch } from '../hooks/use-luc-fetch';
import { clearChat } from './agent-actions';
import type { DeskFile, DeskSearchResult, StudioWorkspace } from '../types';
import type { WorkspaceDeskState } from './desk-slice';
import {
  hydratePersistedPreviewItems,
  loadPersistedWorkspaceUiState,
  readingPositionsFromPersistedWorkspaceUiState,
  schedulePersistCurrentWorkspaceUiState,
} from './workspace-ui-state-actions';
import {
  hasServerConnection,
  isLocalOwnerConnection,
  resolveServerConnection,
} from '../services/server-connection';
import { isWebRuntime } from '../utils/platform-runtime';
import { mergeWorkspaceHistory, normalizeWorkspacePath, removeWorkspaceHistoryEntries } from '../../../../shared/workspace-history.ts';
import { pendingNewSessionIdentityPatch } from './session-actions';

/* eslint-disable @typescript-eslint/no-explicit-any -- store setState 回调及 IPC callback data */

const t = (key: string, vars?: Record<string, string | number>) => window.t?.(key, vars) ?? key;

let _deskLoadVersion = 0;
const _deskTreeLoadVersion = new Map<string, number>();

// ── 路径工具 ──

function normalizeFolder(value: string | null | undefined): string | null {
  return normalizeWorkspacePath(value);
}

function normalizeMountId(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function studioWorkspaceKey(mountId: string): string {
  return `studio:${mountId}`;
}

function deskStateRootKey(root: string | null | undefined, mountId: string | null | undefined): string | null {
  const normalizedMountId = normalizeMountId(mountId);
  if (normalizedMountId) return studioWorkspaceKey(normalizedMountId);
  return normalizeFolder(root);
}

function activeDeskMountId(s: ReturnType<typeof useStore.getState>, overrideMountId?: string | null): string | null {
  if (overrideMountId !== undefined) return normalizeMountId(overrideMountId);
  return normalizeMountId(s.deskWorkspaceMountId);
}

function canUseNativeDeskPath(s: ReturnType<typeof useStore.getState>): boolean {
  const connection = resolveServerConnection(s);
  return !connection || isLocalOwnerConnection(connection);
}

function shouldUseWorkbenchDeskAction(s: ReturnType<typeof useStore.getState>): boolean {
  return isWebRuntime() || !!activeDeskMountId(s) || !canUseNativeDeskPath(s);
}

function activeDeskRoot(s: ReturnType<typeof useStore.getState>, overrideDir?: string | null): string | undefined {
  return overrideDir !== undefined
    ? (overrideDir || undefined)
    : defaultDeskRoot(s);
}

function defaultDeskRoot(s: ReturnType<typeof useStore.getState>): string | undefined {
  return normalizeFolder(s.deskBasePath)
    || normalizeFolder(s.selectedFolder)
    || normalizeFolder(s.homeFolder)
    || undefined;
}

async function responseJsonOrEmpty(res: any): Promise<any> {
  if (!res || typeof res.json !== 'function') return {};
  try {
    return await res.json();
  } catch (err) {
    if (res.status === 404) return {};
    throw err;
  }
}

function routeErrorCode(data: any): string {
  if (!data || typeof data !== 'object') return '';
  if (typeof data.code === 'string') return data.code;
  const error = data.error;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    if (typeof error.code === 'string') return error.code;
    if (typeof error.message === 'string') return error.message;
  }
  return '';
}

function routeErrorMessage(data: any): string {
  if (!data || typeof data !== 'object') return 'desk request failed';
  if (typeof data.error === 'string') return data.error;
  if (data.error && typeof data.error === 'object') {
    if (typeof data.error.message === 'string') return data.error.message;
    if (typeof data.error.code === 'string') return data.error.code;
  }
  if (typeof data.message === 'string') return data.message;
  return 'desk request failed';
}

function isMissingLocalDeskRootResponse(res: any, data: any): boolean {
  if (res?.status === 403) return false;
  if (res?.status === 404) return true;
  return routeErrorCode(data) === 'resource_not_found';
}

async function pruneStaleLocalDeskRoot(dir: string): Promise<void> {
  const normalized = normalizeFolder(dir);
  if (!normalized) return;

  useStore.setState((state: any) => {
    const patch: Record<string, any> = {
      cwdHistory: removeWorkspaceHistoryEntries(state.cwdHistory, [normalized]),
    };
    if (normalizeFolder(state.selectedFolder) === normalized) {
      patch.selectedFolder = null;
    }
    if (normalizeFolder(state.deskBasePath) === normalized) {
      Object.assign(patch, {
        deskBasePath: '',
        deskCurrentPath: '',
        deskFiles: [],
        deskTreeFilesByPath: {},
        deskExpandedPaths: [],
        deskSelectedPath: '',
        deskWorkspaceMountId: null,
        deskWorkspaceLabel: null,
        deskWorkspaceNativeRoot: null,
      });
    }
    return patch;
  });

  const s = useStore.getState();
  if (!hasServerConnection(s)) return;
  const url = recentWorkspacesUrl(s);
  if (!url) {
    console.warn('[workspace] prune stale history skipped: no current agent to record it against');
    return;
  }
  try {
    const res = await lucFetch(url, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: normalized }),
    });
    const data = await responseJsonOrEmpty(res);
    if (Array.isArray(data.cwd_history)) {
      useStore.setState({
        cwdHistory: removeWorkspaceHistoryEntries(
          mergeWorkspaceHistory(data.cwd_history, []),
          [normalized],
        ),
      });
    }
  } catch (err) {
    console.error('[workspace] prune stale history failed:', err);
  }
}

function selectedDeskAgentId(s: ReturnType<typeof useStore.getState>): string | null {
  return typeof s.selectedAgentId === 'string' && s.selectedAgentId.trim()
    ? s.selectedAgentId.trim()
    : null;
}

/**
 * The agent whose recent-workspace list the desk is currently showing.
 *
 * `cwdHistory` in this store is never a mixed list: it is replaced wholesale
 * with the incoming agent's history by the same agent-switch handler that sets
 * `currentAgentId`, so the two always describe the same agent. Recording or
 * dropping a recent workspace therefore has to name that agent — otherwise the
 * server would pick one for us, and with two clients open on two agents it
 * would sometimes pick the other one.
 */
function deskHistoryAgentId(s: ReturnType<typeof useStore.getState>): string | null {
  return typeof s.currentAgentId === 'string' && s.currentAgentId.trim()
    ? s.currentAgentId.trim()
    : null;
}

/** Build a recent-workspace URL for one agent, or null when no agent is known yet. */
function recentWorkspacesUrl(s: ReturnType<typeof useStore.getState>, suffix = ''): string | null {
  const agentId = deskHistoryAgentId(s);
  if (!agentId) return null;
  return `/api/config/workspaces/recent${suffix}?agentId=${encodeURIComponent(agentId)}`;
}

function addSelectedDeskAgentParam(params: URLSearchParams, s: ReturnType<typeof useStore.getState>): void {
  const agentId = selectedDeskAgentId(s);
  if (agentId) params.set('agentId', agentId);
}

function selectedDeskAgentBody(s: ReturnType<typeof useStore.getState>): { agentId?: string } {
  const agentId = selectedDeskAgentId(s);
  return agentId ? { agentId } : {};
}

function normalizeStudioWorkspace(value: any): StudioWorkspace | null {
  const mountId = normalizeMountId(value?.mountId);
  const workspaceId = typeof value?.workspaceId === 'string' && value.workspaceId.trim()
    ? value.workspaceId.trim()
    : mountId;
  if (!mountId || !workspaceId) return null;
  return {
    workspaceId,
    mountId,
    label: typeof value?.label === 'string' && value.label.trim() ? value.label.trim() : mountId,
    sourceKind: typeof value?.sourceKind === 'string' ? value.sourceKind : null,
    provider: typeof value?.provider === 'string' ? value.provider : null,
    presentation: typeof value?.presentation === 'string' ? value.presentation : null,
    capabilities: Array.isArray(value?.capabilities) ? value.capabilities.filter((cap: unknown): cap is string => typeof cap === 'string') : [],
    isDefault: value?.isDefault === true,
    nativeRootPath: normalizeFolder(value?.nativeRootPath),
  };
}

function normalizeMountNativeRoot(value: unknown): string | null {
  return normalizeFolder(typeof value === 'string' ? value : null);
}

export async function loadStudioWorkspaces(): Promise<StudioWorkspace[]> {
  const s = useStore.getState();
  if (!hasServerConnection(s)) return [];
  try {
    const res = await lucFetch('/api/studio/workspaces');
    const data = await res.json();
    if (data.error) throw new Error(String(data.error));
    const workspaces = (Array.isArray(data.workspaces) ? data.workspaces : [])
      .map(normalizeStudioWorkspace)
      .filter((workspace: StudioWorkspace | null): workspace is StudioWorkspace => !!workspace);
    useStore.getState().setStudioWorkspaces(workspaces);
    return workspaces;
  } catch (err) {
    console.error('[workspace] load studio workspaces failed:', err);
    return [];
  }
}

export async function createLocalStudioWorkspaceFromFolder(folder: string): Promise<StudioWorkspace | null> {
  const normalized = normalizeFolder(folder);
  const s = useStore.getState();
  if (!normalized || !hasServerConnection(s)) return null;
  try {
    const res = await lucFetch('/api/studio/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: normalized }),
    });
    const data = await res.json();
    if (data.error) throw new Error(String(data.error));
    const workspace = normalizeStudioWorkspace(data.workspace);
    if (!workspace) throw new Error('invalid workspace response');
    useStore.setState((state: any) => ({
      studioWorkspaces: [
        workspace,
        ...(state.studioWorkspaces || []).filter((item: StudioWorkspace) => item.mountId !== workspace.mountId),
      ],
    }));
    return workspace;
  } catch (err) {
    console.error('[workspace] create local studio workspace failed:', err);
    return null;
  }
}

export async function applyStudioWorkspace(workspace: Pick<StudioWorkspace, 'mountId' | 'label'> & Partial<Pick<StudioWorkspace, 'nativeRootPath'>>): Promise<void> {
  const mountId = normalizeMountId(workspace.mountId);
  if (!mountId) return;
  const label = typeof workspace.label === 'string' && workspace.label.trim() ? workspace.label.trim() : mountId;
  const nativeRootPath = normalizeMountNativeRoot(workspace.nativeRootPath);
  useStore.setState((s: any) => ({
    selectedWorkspaceMountId: mountId,
    selectedWorkspaceLabel: label,
    selectedFolder: null,
    workspaceFolders: s.workspaceFolders || [],
  }));
  void activateWorkspaceDesk(null, { mountId, label, nativeRootPath, reload: false });
  const s = useStore.getState();
  if (!s.pendingNewSession) {
    useStore.setState({ currentSessionPath: null, ...pendingNewSessionIdentityPatch() });
    clearChat();
    useStore.getState().requestInputFocus();
  }
  await loadDeskFiles('', null, mountId);
}

export async function removeStudioWorkspace(mountId: string): Promise<boolean> {
  const normalized = normalizeMountId(mountId);
  const s = useStore.getState();
  if (!normalized || !hasServerConnection(s)) return false;
  useStore.setState((state: any) => ({
    studioWorkspaces: (state.studioWorkspaces || [])
      .filter((workspace: StudioWorkspace) => workspace.mountId !== normalized),
  }));
  try {
    const res = await lucFetch(`/api/studio/workspaces/${encodeURIComponent(normalized)}`, {
      method: 'DELETE',
    });
    const data = await res.json();
    if (data.error) throw new Error(String(data.error));
    const nextWorkspaces = await loadStudioWorkspaces();
    const latest = useStore.getState();
    if (latest.selectedWorkspaceMountId === normalized || latest.deskWorkspaceMountId === normalized) {
      useStore.setState({
        selectedWorkspaceMountId: null,
        selectedWorkspaceLabel: null,
      });
      const defaultWorkspace = nextWorkspaces.find((workspace) => workspace.isDefault);
      if (defaultWorkspace && defaultWorkspace.nativeRootPath) {
        await activateWorkspaceDesk(defaultWorkspace.nativeRootPath, { mountId: null, reload: true });
      } else {
        await activateWorkspaceDesk(null, { mountId: null, reload: false });
      }
    }
    return true;
  } catch (err) {
    console.error('[workspace] remove studio workspace failed:', err);
    await loadStudioWorkspaces();
    return false;
  }
}

function buildWorkspaceDeskState(s: ReturnType<typeof useStore.getState>): WorkspaceDeskState {
  const openTabs = [...(s.openTabs || [])];
  const activeTabId = s.activeTabId && openTabs.includes(s.activeTabId)
    ? s.activeTabId
    : (openTabs[0] || null);
  const openTabSet = new Set(openTabs);
  const previewReadingPositions = Object.fromEntries(
    Object.entries(s.previewReadingPositions || {}).filter(([id]) => openTabSet.has(id)),
  );
  return {
    deskCurrentPath: '',
    deskFiles: [...(s.deskFiles || [])],
    deskTreeFilesByPath: { ...(s.deskTreeFilesByPath || {}) },
    deskExpandedPaths: [...(s.deskExpandedPaths || [])],
    deskSelectedPath: s.deskSelectedPath || '',
    deskJianContent: s.deskJianContent ?? null,
    cwdSkills: [...(s.cwdSkills || [])],
    cwdSkillsOpen: !!s.cwdSkillsOpen,
    jianDrawerOpen: !!s.jianDrawerOpen,
    rightWorkspaceTab: s.rightWorkspaceTab || 'workspace',
    jianView: s.jianView || 'desk',
    previewOpen: !!s.previewOpen,
    openTabs,
    activeTabId,
    previewReadingPositions,
  };
}

function activePreviewTabId(openTabs: string[], activeTabId: string | null | undefined): string | null {
  return activeTabId && openTabs.includes(activeTabId)
    ? activeTabId
    : (openTabs[0] || null);
}

export function captureCurrentWorkspaceDeskState(root?: string | null): void {
  const s = useStore.getState();
  const key = deskStateRootKey(root ?? s.deskBasePath, s.deskWorkspaceMountId);
  if (!key) return;
  s.setWorkspaceDeskState(key, buildWorkspaceDeskState(s));
  schedulePersistCurrentWorkspaceUiState(key);
}

export async function activateWorkspaceDesk(root: string | null | undefined, options: {
  reload?: boolean;
  mountId?: string | null;
  label?: string | null;
  nativeRootPath?: string | null;
} = {}): Promise<void> {
  // Any workspace activation owns the visible desk state. Invalidate older file
  // loads even when the caller delays the reload until after another step
  // such as persisting workspace history.
  _deskLoadVersion += 1;

  const mountId = normalizeMountId(options.mountId);
  const normalized = mountId ? null : normalizeFolder(root);
  const workspaceKey = deskStateRootKey(normalized, mountId);
  const s = useStore.getState();
  const currentRoot = deskStateRootKey(s.deskBasePath, s.deskWorkspaceMountId);

  if (currentRoot) {
    captureCurrentWorkspaceDeskState(currentRoot);
  }

  if (!workspaceKey) {
    useStore.setState({
      deskBasePath: '',
      deskWorkspaceMountId: null,
      deskWorkspaceLabel: null,
      deskWorkspaceNativeRoot: null,
      deskCurrentPath: '',
      deskFiles: [],
      deskTreeFilesByPath: {},
      deskExpandedPaths: [],
      deskDirtyTreePaths: [],
      deskSelectedPath: '',
      deskJianContent: null,
      cwdSkills: [],
      cwdSkillsOpen: false,
      jianDrawerOpen: false,
      rightWorkspaceTab: 'workspace',
      jianView: 'desk',
      previewOpen: false,
      openTabs: [],
      activeTabId: null,
      previewReadingPositions: {},
    });
    updateDeskContextBtn();
    return;
  }

  const latest = useStore.getState();
  const saved = latest.workspaceDeskStateByRoot?.[workspaceKey] || null;
  const savedOpenTabs = saved?.openTabs || [];

  useStore.setState({
    deskBasePath: normalized || workspaceKey,
    deskWorkspaceMountId: mountId,
    deskWorkspaceLabel: options.label || null,
    // 种子值来自调用方携带的服务端披露（如 applyStudioWorkspace 的 workspace 对象）；
    // 后续 loadDeskFiles 的 mount 响应是同一来源的权威刷新。
    deskWorkspaceNativeRoot: mountId ? normalizeMountNativeRoot(options.nativeRootPath) : null,
    deskCurrentPath: '',
    deskFiles: [],
    deskTreeFilesByPath: saved?.deskTreeFilesByPath || {},
    deskExpandedPaths: saved?.deskExpandedPaths || [],
    deskDirtyTreePaths: [],
    deskSelectedPath: saved?.deskSelectedPath || '',
    deskJianContent: null,
    cwdSkills: saved?.cwdSkills || [],
    cwdSkillsOpen: saved?.cwdSkillsOpen || false,
    jianDrawerOpen: saved?.jianDrawerOpen ?? false,
    rightWorkspaceTab: saved?.rightWorkspaceTab || 'workspace',
    jianView: saved?.jianView || 'desk',
    previewOpen: saved?.previewOpen ?? false,
    openTabs: savedOpenTabs,
    activeTabId: activePreviewTabId(savedOpenTabs, saved?.activeTabId),
    previewReadingPositions: saved?.previewReadingPositions || {},
  });
  updateDeskContextBtn();

  if (!saved) {
    const persisted = await loadPersistedWorkspaceUiState(workspaceKey);
    const restoredPreviewItems = mountId ? [] : await hydratePersistedPreviewItems(workspaceKey, persisted);
    const restoredPreviewItemsById = new Map(restoredPreviewItems.map(item => [item.id, item]));
    const restoredOpenTabs = persisted?.openTabs?.filter(id => restoredPreviewItemsById.has(id)) || [];
    const restoredActiveTabId = activePreviewTabId(restoredOpenTabs, persisted?.activeTabId);
    const restoredReadingPositions = readingPositionsFromPersistedWorkspaceUiState(persisted, restoredOpenTabs);
    if (persisted && deskStateRootKey(useStore.getState().deskBasePath, useStore.getState().deskWorkspaceMountId) === workspaceKey) {
      useStore.setState((state: any) => ({
        deskCurrentPath: '',
        deskExpandedPaths: persisted.deskExpandedPaths || [],
        deskSelectedPath: persisted.deskSelectedPath || '',
        rightWorkspaceTab: persisted.rightWorkspaceTab || 'workspace',
        jianView: persisted.jianView || 'desk',
        jianDrawerOpen: persisted.jianDrawerOpen ?? false,
        previewOpen: !!persisted.previewOpen,
        openTabs: restoredOpenTabs,
        activeTabId: restoredActiveTabId,
        previewReadingPositions: restoredReadingPositions,
        ...(restoredPreviewItems.length > 0
          ? {
              previewItems: [
                ...state.previewItems.filter((item: any) => !restoredPreviewItemsById.has(item.id)),
                ...restoredPreviewItems,
              ],
            }
          : {}),
      }));
    }
  }

  if (options.reload === false) return;
  await loadDeskFiles('', normalized, mountId);
  const expandedPaths = useStore.getState().deskExpandedPaths || [];
  for (const subdir of expandedPaths) {
    await loadDeskTreeFiles(subdir, { force: true, overrideDir: normalized, overrideMountId: mountId });
  }
}

/**
 * 当前工作台根的 native 绝对路径。普通文件夹工作台即 deskBasePath；
 * mount 工作台用服务端披露的 deskWorkspaceNativeRoot（local_fs + local owner），
 * 远端/虚拟 mount 没有 native 路径，返回 null。
 */
export function deskNativeRootDir(s: Pick<ReturnType<typeof useStore.getState>, 'deskBasePath' | 'deskWorkspaceMountId' | 'deskWorkspaceNativeRoot'>): string | null {
  if (s.deskWorkspaceMountId) return s.deskWorkspaceNativeRoot || null;
  return s.deskBasePath || null;
}

export function deskFullPath(name: string): string | null {
  const root = deskNativeRootDir(useStore.getState());
  return root ? root + '/' + name : null;
}

export function deskCurrentDir(): string | null {
  return deskNativeRootDir(useStore.getState());
}

// ── 文件操作 ──

export async function loadDeskFiles(subdir?: string, overrideDir?: string | null, overrideMountId?: string | null): Promise<void> {
  const s = useStore.getState();
  if (!hasServerConnection(s)) return;
  if (subdir !== undefined) s.setDeskCurrentPath('');
  const myVersion = ++_deskLoadVersion;
  try {
    const params = new URLSearchParams();
    const mountId = activeDeskMountId(s, overrideMountId);
    // overrideDir 是显式调用契约：string 表示指定根目录，null 表示不复用旧 deskBasePath。
    // undefined 才走 store 中已有 deskBasePath，避免普通刷新丢失当前根目录。
    const dir = mountId ? undefined : activeDeskRoot(s, overrideDir);
    if (mountId) {
      params.set('mountId', mountId);
    } else if (dir) {
      params.set('dir', dir);
    }
    if (!mountId) {
      addSelectedDeskAgentParam(params, s);
    }
    const curPath = '';
    if (curPath) params.set('subdir', curPath);
    const qs = params.toString() ? `?${params}` : '';
    const res = await lucFetch(`${mountId ? '/api/workbench/files' : '/api/desk/files'}${qs}`);
    const data = await responseJsonOrEmpty(res);
    if (myVersion !== _deskLoadVersion) return;
    if (!mountId && dir && isMissingLocalDeskRootResponse(res, data)) {
      await pruneStaleLocalDeskRoot(dir);
      updateDeskContextBtn();
      return;
    }
    if (data.error) throw new Error(routeErrorMessage(data));
    const st = useStore.getState();
    st.setDeskFiles(data.files || []);
    st.setDeskTreeFiles('', data.files || []);
    st.setDeskSelectedPath('');
    if (mountId) {
      st.setDeskWorkspaceMount(
        data.mountId || mountId,
        data.mount?.label || st.deskWorkspaceLabel || null,
        normalizeMountNativeRoot(data.mount?.nativeRootPath),
      );
      st.setDeskBasePath(studioWorkspaceKey(data.mountId || mountId));
    } else {
      st.setDeskWorkspaceMount(null);
      if (data.basePath) st.setDeskBasePath(data.basePath);
    }
    loadJianContent();
    updateDeskContextBtn();
  } catch (err) {
    console.error('[jian-desk] load failed:', err);
    if (myVersion !== _deskLoadVersion) return;
    updateDeskContextBtn();
  }
}

function deskTreeLoadKey(root: string | undefined, subdir: string): string {
  return `${root || ''}\n${subdir}`;
}

function normalizeSubdir(value: string | null | undefined): string {
  return (value || '').replace(/^\/+|\/+$/g, '');
}

function childSubdir(parent: string, name: string): string {
  const normalized = normalizeSubdir(parent);
  return normalized ? `${normalized}/${name}` : name;
}

function ancestorSubdirs(pathValue: string): string[] {
  const normalized = normalizeSubdir(pathValue);
  if (!normalized) return [];
  const parts = normalized.split('/').filter(Boolean);
  const result: string[] = [];
  for (let i = 1; i <= parts.length; i++) {
    result.push(parts.slice(0, i).join('/'));
  }
  return result;
}

function normalizeWorkspaceComparePath(value: string | null | undefined): string {
  return (normalizeFolder(value) || '').replace(/\\/g, '/').replace(/\/+$/g, '');
}

function workspaceCompareKey(value: string): string {
  return (/^[A-Za-z]:\//.test(value) || value.startsWith('//'))
    ? value.toLowerCase()
    : value;
}

function relativeSubdirForWorkspacePath(root: string | null | undefined, targetPath: string | null | undefined): string | null {
  const normalizedRoot = normalizeWorkspaceComparePath(root);
  const normalizedTarget = normalizeWorkspaceComparePath(targetPath);
  if (!normalizedRoot || !normalizedTarget) return null;
  const rootKey = workspaceCompareKey(normalizedRoot);
  const targetKey = workspaceCompareKey(normalizedTarget);
  if (targetKey === rootKey) return '';
  const prefixKey = rootKey.endsWith('/') ? rootKey : `${rootKey}/`;
  if (!targetKey.startsWith(prefixKey)) return null;
  const prefixLength = normalizedRoot.endsWith('/') ? normalizedRoot.length : normalizedRoot.length + 1;
  return normalizeSubdir(normalizedTarget.slice(prefixLength));
}

function replaceSubdirPrefix(value: string, oldPrefix: string, newPrefix: string): string {
  if (value === oldPrefix) return newPrefix;
  if (value.startsWith(`${oldPrefix}/`)) return `${newPrefix}${value.slice(oldPrefix.length)}`;
  return value;
}

function removeSubdirPrefix(value: string, prefix: string): boolean {
  return value === prefix || value.startsWith(`${prefix}/`);
}

function isPlainFileName(value: string): boolean {
  return !!value && !value.includes('/') && !value.includes('\\') && value !== '.' && value !== '..';
}

function uniqueNameForSubdir(subdir: string, baseName: string): string {
  const s = useStore.getState();
  const normalizedSubdir = normalizeSubdir(subdir);
  const files = s.deskTreeFilesByPath?.[normalizedSubdir]
    || (!normalizedSubdir ? s.deskFiles : []);
  const existing = new Set((files || []).map((f: { name: string }) => f.name));
  if (!existing.has(baseName)) return baseName;

  const dotIndex = baseName.lastIndexOf('.');
  const hasExtension = dotIndex > 0;
  const stem = hasExtension ? baseName.slice(0, dotIndex) : baseName;
  const ext = hasExtension ? baseName.slice(dotIndex) : '';
  let index = 2;
  while (existing.has(`${stem} ${index}${ext}`)) index += 1;
  return `${stem} ${index}${ext}`;
}

function joinDeskPath(basePath: string, subdir: string, name: string): string {
  const separator = basePath.includes('\\') && !basePath.includes('/') ? '\\' : '/';
  const base = basePath.replace(/[\\/]+$/g, '');
  const parts = normalizeSubdir(subdir).split('/').filter(Boolean);
  return [base, ...parts, name].join(separator);
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

export async function loadDeskTreeFiles(subdir = '', options: { force?: boolean; overrideDir?: string | null; overrideMountId?: string | null } = {}): Promise<boolean> {
  const s = useStore.getState();
  if (!hasServerConnection(s)) return false;
  const mountId = activeDeskMountId(s, options.overrideMountId);
  const dir = mountId ? undefined : activeDeskRoot(s, options.overrideDir);
  const normalizedSubdir = normalizeSubdir(subdir);
  const cached = s.deskTreeFilesByPath?.[normalizedSubdir];
  if (cached && !options.force) return true;

  const key = deskTreeLoadKey(mountId ? studioWorkspaceKey(mountId) : dir, normalizedSubdir);
  const myVersion = (_deskTreeLoadVersion.get(key) || 0) + 1;
  _deskTreeLoadVersion.set(key, myVersion);

  try {
    const params = new URLSearchParams();
    if (mountId) {
      params.set('mountId', mountId);
    } else if (dir) {
      params.set('dir', dir);
    }
    if (normalizedSubdir) params.set('subdir', normalizedSubdir);
    if (!mountId) addSelectedDeskAgentParam(params, s);
    const qs = params.toString() ? `?${params}` : '';
    const res = await lucFetch(`${mountId ? '/api/workbench/files' : '/api/desk/files'}${qs}`);
    const data = await res.json();
    if (_deskTreeLoadVersion.get(key) !== myVersion) return false;
    if (data.error) throw new Error(String(data.error));
    const st = useStore.getState();
    if (mountId) {
      st.setDeskWorkspaceMount(
        data.mountId || mountId,
        data.mount?.label || st.deskWorkspaceLabel || null,
        normalizeMountNativeRoot(data.mount?.nativeRootPath),
      );
      st.setDeskBasePath(studioWorkspaceKey(data.mountId || mountId));
    } else {
      st.setDeskWorkspaceMount(null);
      if (data.basePath) st.setDeskBasePath(data.basePath);
    }
    st.setDeskTreeFiles(normalizedSubdir, data.files || []);
    if (!normalizedSubdir) st.setDeskFiles(data.files || []);
    return true;
  } catch (err) {
    console.error('[desk-tree] load failed:', err);
    if (_deskTreeLoadVersion.get(key) !== myVersion) return false;
    return false;
  }
}

export async function searchDeskFiles(query: string): Promise<DeskSearchResult[]> {
  const s = useStore.getState();
  if (!hasServerConnection(s)) return [];
  const trimmed = query.trim();
  if (!trimmed) return [];
  try {
    const params = new URLSearchParams();
    const mountId = activeDeskMountId(s);
    const dir = mountId ? undefined : defaultDeskRoot(s);
    if (mountId) {
      params.set('mountId', mountId);
    } else if (dir) {
      params.set('dir', dir);
    }
    if (!mountId) addSelectedDeskAgentParam(params, s);
    params.set('q', trimmed);
    const res = await lucFetch(`${mountId ? '/api/workbench/search' : '/api/desk/search-files'}?${params}`);
    const data = await res.json();
    if (data.error) throw new Error(String(data.error));
    return Array.isArray(data.results) ? data.results : [];
  } catch (err) {
    console.error('[desk] search failed:', err);
    return [];
  }
}

export async function jumpToDeskSearchResult(result: DeskSearchResult): Promise<void> {
  const target = normalizeSubdir(result.relativePath);
  if (!target) return;
  const parent = normalizeSubdir(result.parentSubdir);
  const foldersToExpand = result.isDir
    ? ancestorSubdirs(target)
    : ancestorSubdirs(parent);
  useStore.setState((s: any) => ({
    deskExpandedPaths: Array.from(new Set([...(s.deskExpandedPaths || []), ...foldersToExpand])),
    deskSelectedPath: target,
  }));
  schedulePersistCurrentWorkspaceUiState();
  for (const subdir of foldersToExpand) {
    await loadDeskTreeFiles(subdir);
  }
  useStore.getState().setDeskSelectedPath(target);
}

export async function revealDeskDirectory(directoryPath: string): Promise<boolean> {
  const s = useStore.getState();
  if (!hasServerConnection(s)) return false;
  if (s.deskWorkspaceMountId) return false;
  const root = normalizeFolder(s.deskBasePath) || defaultDeskRoot(s);
  const target = relativeSubdirForWorkspacePath(root, directoryPath);
  if (target == null) return false;

  const foldersToExpand = ancestorSubdirs(target);
  useStore.setState((state: any) => ({
    deskCurrentPath: '',
    rightWorkspaceTab: 'workspace',
    deskExpandedPaths: Array.from(new Set([...(state.deskExpandedPaths || []), ...foldersToExpand])),
    deskSelectedPath: target,
  }));
  schedulePersistCurrentWorkspaceUiState(root);

  await loadDeskTreeFiles('', { force: true, overrideDir: root });
  for (const subdir of foldersToExpand) {
    await loadDeskTreeFiles(subdir, { force: true, overrideDir: root });
  }

  useStore.setState((state: any) => ({
    deskCurrentPath: '',
    rightWorkspaceTab: 'workspace',
    deskExpandedPaths: Array.from(new Set([...(state.deskExpandedPaths || []), ...foldersToExpand])),
    deskSelectedPath: target,
  }));
  schedulePersistCurrentWorkspaceUiState(root);
  return true;
}

export async function loadJianContent(): Promise<void> {
  const s = useStore.getState();
  if (!hasServerConnection(s)) return;
  try {
    const params = new URLSearchParams();
    const mountId = activeDeskMountId(s);
    if (mountId) {
      params.set('mountId', mountId);
      params.set('name', 'jian.md');
    } else if (s.deskBasePath) {
      params.set('dir', s.deskBasePath);
      addSelectedDeskAgentParam(params, s);
    } else {
      addSelectedDeskAgentParam(params, s);
    }
    const qs = params.toString() ? `?${params}` : '';
    const res = await lucFetch(`${mountId ? '/api/workbench/content' : '/api/desk/jian'}${qs}`);
    if (mountId) {
      if (res.status === 404) {
        useStore.getState().setDeskJianContent(null);
        return;
      }
      if (!res.ok) throw new Error(`jian.md load failed: ${res.status}`);
      useStore.getState().setDeskJianContent(await res.text() || null);
      return;
    }
    const data = await res.json();
    useStore.getState().setDeskJianContent(data.content || null);
  } catch (err) {
    console.error('[jian] load jian.md failed:', err);
    useStore.getState().setDeskJianContent(null);
  }
}

export async function saveJianContent(content?: string): Promise<void> {
  const s = useStore.getState();
  if (!hasServerConnection(s)) return;
  const text = content ?? s.deskJianContent ?? '';
  try {
    const mountId = activeDeskMountId(s);
    await lucFetch(mountId ? '/api/workbench/actions' : '/api/desk/jian', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(mountId
        ? { action: 'writeText', mountId, subdir: '', name: 'jian.md', content: text }
        : { ...selectedDeskAgentBody(s), dir: s.deskBasePath || undefined, subdir: '', content: text }),
    });
    useStore.getState().setDeskJianContent(text || null);
    const st2 = useStore.getState();
    const params = new URLSearchParams();
    const activeMountId = activeDeskMountId(st2);
    if (activeMountId) {
      params.set('mountId', activeMountId);
    } else if (st2.deskBasePath) {
      params.set('dir', st2.deskBasePath);
      addSelectedDeskAgentParam(params, st2);
    }
    const qs = params.toString() ? `?${params}` : '';
    const res2 = await lucFetch(`${activeMountId ? '/api/workbench/files' : '/api/desk/files'}${qs}`);
    const data2 = await res2.json();
    const st = useStore.getState();
    st.setDeskFiles(data2.files || []);
    st.setDeskTreeFiles('', data2.files || []);
  } catch (err) {
    console.error('[jian] save jian.md failed:', err);
  }
}

export async function deskUploadFiles(paths: string[]): Promise<void> {
  const s = useStore.getState();
  try {
    const res = await lucFetch('/api/desk/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...selectedDeskAgentBody(s), action: 'upload', dir: s.deskBasePath || undefined, subdir: '', paths }),
    });
    const data = await res.json();
    if (data.files) {
      const st = useStore.getState();
      st.setDeskFiles(data.files);
      st.setDeskTreeFiles('', data.files);
    }
  } catch (err) {
    console.error('[jian-desk] upload failed:', err);
  }
}

export async function deskUploadFilesToSubdir(paths: string[], subdir: string): Promise<void> {
  const s = useStore.getState();
  const normalizedSubdir = subdir.replace(/^\/+|\/+$/g, '');
  try {
    const res = await lucFetch('/api/desk/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...selectedDeskAgentBody(s), action: 'upload', dir: s.deskBasePath || undefined, subdir: normalizedSubdir, paths }),
    });
    const data = await res.json();
    if (data.files) {
      const st = useStore.getState();
      st.setDeskTreeFiles(normalizedSubdir, data.files);
      if (!normalizedSubdir) st.setDeskFiles(data.files);
    }
  } catch (err) {
    console.error('[jian-desk] upload to tree failed:', err);
  }
}

export async function deskUploadBrowserFilesToSubdir(files: File[], subdir: string): Promise<boolean> {
  const s = useStore.getState();
  const normalizedSubdir = normalizeSubdir(subdir);
  const mountId = activeDeskMountId(s) || 'default';
  if (!s.deskBasePath || files.length === 0) return false;
  try {
    const payloadFiles = await Promise.all(files.map(async file => ({
      name: file.name,
      type: file.type || '',
      contentBase64: await blobToBase64(file),
    })));
    const res = await lucFetch('/api/workbench/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mountId,
        subdir: normalizedSubdir,
        files: payloadFiles,
      }),
    });
    const data = await res.json();
    if (data.error || data.ok === false) {
      console.error('[jian-desk] workbench upload error:', data.error || data.results);
      return false;
    }
    if (data.files) applyFilesForSubdir(normalizedSubdir, data.files);
    return true;
  } catch (err) {
    console.error('[jian-desk] workbench upload failed:', err);
    return false;
  }
}

function applyFilesForSubdir(subdir: string, files: DeskFile[]): void {
  const normalizedSubdir = normalizeSubdir(subdir);
  const st = useStore.getState();
  st.setDeskTreeFiles(normalizedSubdir, files);
  if (!normalizedSubdir) st.setDeskFiles(files);
}

export async function deskCreateFileInSubdir(subdir: string, name: string, text: string): Promise<boolean> {
  const s = useStore.getState();
  const normalizedSubdir = normalizeSubdir(subdir);
  const trimmed = name.trim();
  if (!isPlainFileName(trimmed)) return false;
  const mountId = activeDeskMountId(s);
  try {
    const res = await lucFetch(mountId ? '/api/workbench/actions' : '/api/desk/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(mountId
        ? { action: 'create', mountId, subdir: normalizedSubdir, name: trimmed, content: text }
        : {
            ...selectedDeskAgentBody(s),
            action: 'create',
            dir: s.deskBasePath || undefined,
            subdir: normalizedSubdir,
            name: trimmed,
            content: text,
          }),
    });
    const data = await res.json();
    if (data.error) { console.error('[desk] create file error:', data.error); return false; }
    if (data.files) applyFilesForSubdir(normalizedSubdir, data.files);
    return true;
  } catch (err) {
    console.error('[jian-desk] create failed:', err);
    return false;
  }
}

export async function deskCreateFile(text: string): Promise<void> {
  const d = new Date();
  const ts = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const locale = window.i18n?.locale || 'zh';
  const prefix = locale.startsWith('zh') ? '备注' : locale.startsWith('ja') ? 'メモ' : locale.startsWith('ko') ? '메모' : 'note';
  const name = uniqueNameForSubdir('', `${ts}-${prefix}.md`);
  await deskCreateFileInSubdir('', name, text);
}

export async function deskMoveFiles(names: string[], destFolder: string): Promise<void> {
  const s = useStore.getState();
  const mountId = activeDeskMountId(s);
  try {
    if (mountId) {
      for (const name of names) {
        if (!isPlainFileName(name)) continue;
        const res = await lucFetch('/api/workbench/actions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'move', mountId, subdir: '', name, destSubdir: destFolder }),
        });
        const data = await res.json();
        if (data.error) throw new Error(String(data.error));
        if (data.files) {
          const st = useStore.getState();
          st.setDeskFiles(data.files);
          st.setDeskTreeFiles('', data.files);
        }
      }
      return;
    }
    const res = await lucFetch('/api/desk/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...selectedDeskAgentBody(s), action: 'move', dir: s.deskBasePath || undefined, subdir: '', names, destFolder }),
    });
    const data = await res.json();
    if (data.files) {
      const st = useStore.getState();
      st.setDeskFiles(data.files);
      st.setDeskTreeFiles('', data.files);
    }
  } catch (err) {
    console.error('[jian-desk] move failed:', err);
  }
}

export interface DeskTreeMoveItem {
  sourceSubdir: string;
  name: string;
  isDirectory?: boolean;
}

function applyRenamedDirectoryCache(oldSubdir: string, newSubdir: string): void {
  useStore.setState((s: any) => {
    const nextTree: Record<string, DeskFile[]> = {};
    for (const [key, files] of Object.entries(s.deskTreeFilesByPath || {})) {
      const nextKey = replaceSubdirPrefix(key, oldSubdir, newSubdir);
      nextTree[nextKey] = files as DeskFile[];
    }
    return {
      deskTreeFilesByPath: nextTree,
      deskExpandedPaths: (s.deskExpandedPaths || []).map((path: string) => replaceSubdirPrefix(path, oldSubdir, newSubdir)),
      deskSelectedPath: replaceSubdirPrefix(s.deskSelectedPath || '', oldSubdir, newSubdir),
      deskCurrentPath: '',
    };
  });
  schedulePersistCurrentWorkspaceUiState();
}

function pruneRemovedDirectoryCache(removedSubdirs: string[]): void {
  if (removedSubdirs.length === 0) return;
  useStore.setState((s: any) => {
    const nextTree: Record<string, DeskFile[]> = {};
    for (const [key, files] of Object.entries(s.deskTreeFilesByPath || {})) {
      if (removedSubdirs.some(prefix => removeSubdirPrefix(key, prefix))) continue;
      nextTree[key] = files as DeskFile[];
    }
    return {
      deskTreeFilesByPath: nextTree,
      deskExpandedPaths: (s.deskExpandedPaths || []).filter((path: string) => !removedSubdirs.some(prefix => removeSubdirPrefix(path, prefix))),
      deskSelectedPath: removedSubdirs.some(prefix => removeSubdirPrefix(s.deskSelectedPath || '', prefix)) ? '' : s.deskSelectedPath,
    };
  });
  schedulePersistCurrentWorkspaceUiState();
}

export async function deskMoveTreeFiles(items: DeskTreeMoveItem[], destSubdir: string): Promise<void> {
  const s = useStore.getState();
  if (items.length === 0) return;
  const normalizedDest = destSubdir.replace(/^\/+|\/+$/g, '');
  const mountId = activeDeskMountId(s);
  try {
    const res = await lucFetch(mountId ? '/api/workbench/actions' : '/api/desk/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(mountId
        ? {
            action: 'movePaths',
            mountId,
            items: items.map(item => ({
              sourceSubdir: item.sourceSubdir.replace(/^\/+|\/+$/g, ''),
              name: item.name,
              isDirectory: !!item.isDirectory,
            })),
            destSubdir: normalizedDest,
            currentSubdir: '',
          }
        : {
            ...selectedDeskAgentBody(s),
            action: 'movePaths',
            dir: s.deskBasePath || undefined,
            items: items.map(item => ({
              sourceSubdir: item.sourceSubdir.replace(/^\/+|\/+$/g, ''),
              name: item.name,
              isDirectory: !!item.isDirectory,
            })),
            destSubdir: normalizedDest,
            currentSubdir: '',
          }),
    });
    const data = await res.json();
    const st = useStore.getState();
    if (data.filesByPath && typeof data.filesByPath === 'object') {
      for (const [subdir, files] of Object.entries(data.filesByPath)) {
        st.setDeskTreeFiles(subdir, files as DeskFile[]);
        if (normalizeSubdir(subdir) === '') st.setDeskFiles(files as DeskFile[]);
      }
    }
    if (data.files && !data.filesByPath) {
      st.setDeskFiles(data.files);
      st.setDeskTreeFiles('', data.files);
    }
  } catch (err) {
    console.error('[jian-desk] tree move failed:', err);
  }
}

export async function deskRenameTreeItem(sourceSubdir: string, oldName: string, newName: string, isDirectory = false): Promise<boolean> {
  const s = useStore.getState();
  const normalizedSource = normalizeSubdir(sourceSubdir);
  const trimmed = newName.trim();
  if (!isPlainFileName(oldName) || !isPlainFileName(trimmed)) return false;
  if (oldName === trimmed) return true;
  const mountId = activeDeskMountId(s);
  try {
    const res = await lucFetch(mountId ? '/api/workbench/actions' : '/api/desk/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(mountId
        ? { action: 'rename', mountId, subdir: normalizedSource, oldName, newName: trimmed }
        : {
            ...selectedDeskAgentBody(s),
            action: 'rename',
            dir: s.deskBasePath || undefined,
            subdir: normalizedSource,
            oldName,
            newName: trimmed,
          }),
    });
    const data = await res.json();
    if (data.error) { console.error('[desk] tree rename error:', data.error); return false; }
    if (isDirectory) {
      applyRenamedDirectoryCache(childSubdir(normalizedSource, oldName), childSubdir(normalizedSource, trimmed));
    }
    if (data.files) {
      const st = useStore.getState();
      st.setDeskTreeFiles(normalizedSource, data.files);
      if (!normalizedSource) st.setDeskFiles(data.files);
    }
    return true;
  } catch (err) {
    console.error('[desk] tree rename failed:', err);
    return false;
  }
}

export async function deskTrashTreeItems(items: DeskTreeMoveItem[]): Promise<boolean> {
  const s = useStore.getState();
  if (shouldUseWorkbenchDeskAction(s)) {
    return deskSafeDeleteMobileWorkbenchItems(items);
  }
  const trashItem = window.platform?.trashItem;
  if (!trashItem) {
    console.error('[desk] system trash is not available');
    return false;
  }
  if (!s.deskBasePath || items.length === 0) return false;

  const affectedParents = new Set<string>();
  const removedDirs: string[] = [];
  const paths = items.map(item => ({
    ...item,
    sourceSubdir: normalizeSubdir(item.sourceSubdir),
    path: joinDeskPath(s.deskBasePath, item.sourceSubdir, item.name),
  }));

  let trashedCount = 0;
  try {
    for (const item of paths) {
      if (!isPlainFileName(item.name)) break;
      const ok = await trashItem(item.path);
      if (!ok) break;
      trashedCount += 1;
      affectedParents.add(item.sourceSubdir);
      if (item.isDirectory) removedDirs.push(childSubdir(item.sourceSubdir, item.name));
    }
  } catch (err) {
    console.error('[desk] tree trash failed:', err);
  } finally {
    pruneRemovedDirectoryCache(removedDirs);
    for (const parent of affectedParents) {
      await loadDeskTreeFiles(parent, { force: true });
    }
  }
  return trashedCount === paths.length;
}

async function deskSafeDeleteMobileWorkbenchItems(items: DeskTreeMoveItem[]): Promise<boolean> {
  const s = useStore.getState();
  if (!s.deskBasePath || items.length === 0) return false;
  const mountId = activeDeskMountId(s) || 'default';

  const paths = items.map(item => ({
    ...item,
    sourceSubdir: normalizeSubdir(item.sourceSubdir),
  }));
  const removedDirs: string[] = [];
  let deletedCount = 0;

  try {
    for (const item of paths) {
      if (!isPlainFileName(item.name)) break;
      const res = await lucFetch('/api/workbench/actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'safeDelete',
          mountId,
          subdir: item.sourceSubdir,
          name: item.name,
        }),
      });
      const data = await res.json();
      if (data.error || data.ok === false) break;
      deletedCount += 1;
      if (data.files) applyFilesForSubdir(item.sourceSubdir, data.files);
      if (item.isDirectory) removedDirs.push(childSubdir(item.sourceSubdir, item.name));
    }
  } catch (err) {
    console.error('[desk] workbench safe delete failed:', err);
  } finally {
    pruneRemovedDirectoryCache(removedDirs);
  }

  return deletedCount === paths.length;
}

export async function deskRemoveFile(name: string): Promise<void> {
  const s = useStore.getState();
  const mountId = activeDeskMountId(s);
  try {
    const res = await lucFetch(mountId ? '/api/workbench/actions' : '/api/desk/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(mountId
        ? { action: 'safeDelete', mountId, subdir: '', name }
        : { ...selectedDeskAgentBody(s), action: 'remove', dir: s.deskBasePath || undefined, subdir: '', name }),
    });
    const data = await res.json();
    if (data.files) {
      const st = useStore.getState();
      st.setDeskFiles(data.files);
      st.setDeskTreeFiles('', data.files);
    }
  } catch (err) {
    console.error('[jian-desk] remove failed:', err);
  }
}

/**
 * deskMkdir — 新建文件夹，并返回新文件夹名（供调用者触发 rename）。
 */
export async function deskMkdir(): Promise<string | null> {
  const name = uniqueNameForSubdir('', t('desk.newFolder'));
  return await deskMkdirInSubdir('', name) ? name : null;
}

export async function deskMkdirInSubdir(subdir: string, name: string): Promise<boolean> {
  const s = useStore.getState();
  const normalizedSubdir = normalizeSubdir(subdir);
  const trimmed = name.trim();
  if (!isPlainFileName(trimmed)) return false;
  const mountId = activeDeskMountId(s);
  try {
    const res = await lucFetch(mountId ? '/api/workbench/actions' : '/api/desk/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(mountId
        ? { action: 'mkdir', mountId, subdir: normalizedSubdir, name: trimmed }
        : {
            ...selectedDeskAgentBody(s),
            action: 'mkdir',
            dir: s.deskBasePath || undefined,
            subdir: normalizedSubdir,
            name: trimmed,
          }),
    });
    const data = await res.json();
    if (data.error) { console.error('[desk] mkdir error:', data.error); return false; }
    if (data.files) applyFilesForSubdir(normalizedSubdir, data.files);
    return true;
  } catch (err) {
    console.error('[desk] mkdir failed:', err);
    return false;
  }
}

export async function deskRenameFile(oldName: string, newName: string): Promise<boolean> {
  const s = useStore.getState();
  const mountId = activeDeskMountId(s);
  try {
    const res = await lucFetch(mountId ? '/api/workbench/actions' : '/api/desk/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(mountId
        ? { action: 'rename', mountId, subdir: '', oldName, newName }
        : { ...selectedDeskAgentBody(s), action: 'rename', dir: s.deskBasePath || undefined, subdir: '', oldName, newName }),
    });
    const data = await res.json();
    if (data.error) { console.error('[desk] rename error:', data.error); return false; }
    if (data.files) {
      const st = useStore.getState();
      st.setDeskFiles(data.files);
      st.setDeskTreeFiles('', data.files);
    }
    return true;
  } catch (err) { console.error('[desk] rename failed:', err); return false; }
}

// ── 状态工具 ──

export function toggleMemory(): void {
  useStore.setState((s: any) => ({ memoryEnabled: !s.memoryEnabled }));
}

export async function applyFolder(folder: string): Promise<void> {
  const normalized = normalizeFolder(folder);
  if (!normalized) return;
  useStore.setState((s: any) => ({
    selectedFolder: normalized,
    selectedWorkspaceMountId: null,
    selectedWorkspaceLabel: null,
    cwdHistory: mergeWorkspaceHistory(s.cwdHistory, [normalized]),
    workspaceFolders: (s.workspaceFolders || []).filter((p: string) => normalizeFolder(p) !== normalized),
  }));
  void activateWorkspaceDesk(normalized, { mountId: null, reload: false });
  const s = useStore.getState();
  if (!s.pendingNewSession) {
    useStore.setState({ currentSessionPath: null, ...pendingNewSessionIdentityPatch() });
    clearChat();
    useStore.getState().requestInputFocus();
  }
  await persistWorkspaceHistory(normalized);
  await loadDeskFiles('', normalized);
}

async function persistWorkspaceHistory(folder: string): Promise<void> {
  const s = useStore.getState();
  if (!hasServerConnection(s)) return;
  const url = recentWorkspacesUrl(s);
  if (!url) {
    console.warn('[workspace] persist history skipped: no current agent to record it against');
    return;
  }
  try {
    const res = await lucFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: folder }),
    });
    const data = await res.json();
    if (data.error) throw new Error(String(data.error));
    if (Array.isArray(data.cwd_history)) {
      useStore.setState({ cwdHistory: mergeWorkspaceHistory(data.cwd_history, []) });
    }
  } catch (err) {
    console.error('[workspace] persist history failed:', err);
  }
}

export async function removeRecentWorkspace(folder: string): Promise<void> {
  const normalized = normalizeFolder(folder);
  if (!normalized) return;
  useStore.setState((s: any) => ({
    cwdHistory: removeWorkspaceHistoryEntries(s.cwdHistory, [normalized]),
  }));
  const s = useStore.getState();
  if (!hasServerConnection(s)) return;
  const url = recentWorkspacesUrl(s);
  if (!url) {
    console.warn('[workspace] remove recent history skipped: no current agent to record it against');
    return;
  }
  try {
    const res = await lucFetch(url, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: normalized }),
    });
    const data = await res.json();
    if (data.error) throw new Error(String(data.error));
    if (Array.isArray(data.cwd_history)) {
      useStore.setState({ cwdHistory: mergeWorkspaceHistory(data.cwd_history, []) });
    }
  } catch (err) {
    console.error('[workspace] remove recent history failed:', err);
  }
}

export async function clearRecentWorkspaces(): Promise<void> {
  useStore.setState({ cwdHistory: [] });
  const s = useStore.getState();
  if (!hasServerConnection(s)) return;
  const url = recentWorkspacesUrl(s, '/all');
  if (!url) {
    console.warn('[workspace] clear recent history skipped: no current agent to clear it for');
    return;
  }
  try {
    const res = await lucFetch(url, {
      method: 'DELETE',
    });
    const data = await res.json();
    if (data.error) throw new Error(String(data.error));
    if (Array.isArray(data.cwd_history)) {
      useStore.setState({ cwdHistory: mergeWorkspaceHistory(data.cwd_history, []) });
    }
  } catch (err) {
    console.error('[workspace] clear recent history failed:', err);
  }
}

export function addWorkspaceFolder(folder: string): void {
  const normalized = normalizeFolder(folder);
  if (!normalized) return;
  useStore.setState((s: any) => {
    const primary = normalizeFolder(s.selectedFolder) || normalizeFolder(s.homeFolder);
    if (normalized === primary) return {};
    if ((s.workspaceFolders || []).includes(normalized)) return {};
    return { workspaceFolders: [...(s.workspaceFolders || []), normalized] };
  });
}

export function removeWorkspaceFolder(folder: string): void {
  const normalized = normalizeFolder(folder);
  if (!normalized) return;
  useStore.setState((s: any) => ({
    workspaceFolders: (s.workspaceFolders || []).filter((p: string) => p !== normalized),
  }));
}

export function updateDeskContextBtn(): void {
  const s = useStore.getState();
  const available = !!s.deskBasePath && s.deskFiles.length > 0;
  if (!available && s.deskContextAttached) {
    s.setDeskContextAttached(false);
  }
}

export function toggleJianSidebar(forceOpen?: boolean): void {
  const s = useStore.getState();
  const newOpen = forceOpen !== undefined ? forceOpen : !s.jianOpen;
  s.setJianOpen(newOpen);
  localStorage.setItem('luc-jian', newOpen ? 'open' : 'closed');
  if (forceOpen === undefined) s.setJianAutoCollapsed(false);
}

export function initJian(): void {
  const legacy = localStorage.getItem('luc-jian');
  const savedJian = legacy ?? localStorage.getItem('luc-jian-chat');
  if (savedJian !== null && legacy === null) {
    localStorage.setItem('luc-jian', savedJian);
  }
  if (savedJian !== null) useStore.getState().setJianOpen(savedJian !== 'closed');
  const s = useStore.getState();
  void activateWorkspaceDesk(s.selectedFolder || s.homeFolder || null);
}
