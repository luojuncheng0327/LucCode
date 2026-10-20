import type { DeskFile, StudioWorkspace } from '../types';
import type { RightWorkspaceTab } from '../types';
import type { PreviewReadingPosition } from '../../../../shared/preview-reading-position.ts';

export interface CwdSkillInfo {
  name: string;
  description: string;
  source: string;
  filePath: string;
  baseDir: string;
  workspaceMountId?: string | null;
  sourceCategory?: 'standard' | 'compatible' | null;
  sourceIdentity?: Record<string, unknown> | null;
  active?: boolean;
  shadowed?: boolean;
  shadowedBy?: { source?: string; sourceIdentity?: Record<string, unknown> } | null;
  inactiveReason?: 'policy-disabled' | 'shadowed' | string | null;
}

export interface CwdSkillPolicy {
  discoverProjectSkills: boolean;
  discoverCompatibleProjectSkills: boolean;
}

export interface WorkspaceDeskState {
  deskCurrentPath: string;
  deskFiles: DeskFile[];
  deskTreeFilesByPath: Record<string, DeskFile[]>;
  deskExpandedPaths: string[];
  deskSelectedPath: string;
  deskJianContent: string | null;
  cwdSkills: CwdSkillInfo[];
  cwdSkillPolicy?: CwdSkillPolicy;
  cwdSkillsOpen: boolean;
  jianDrawerOpen: boolean;
  rightWorkspaceTab: RightWorkspaceTab;
  jianView: string;
  previewOpen: boolean;
  openTabs: string[];
  activeTabId: string | null;
  previewReadingPositions: Record<string, PreviewReadingPosition>;
}

export interface DeskSlice {
  deskFiles: DeskFile[];
  deskBasePath: string;
  deskCurrentPath: string;
  deskTreeFilesByPath: Record<string, DeskFile[]>;
  deskExpandedPaths: string[];
  deskDirtyTreePaths: string[];
  deskSelectedPath: string;
  deskJianContent: string | null;
  cwdSkills: CwdSkillInfo[];
  cwdSkillPolicy: CwdSkillPolicy;
  cwdSkillsOpen: boolean;
  homeFolder: string | null;
  selectedFolder: string | null;
  selectedWorkspaceMountId: string | null;
  selectedWorkspaceLabel: string | null;
  deskWorkspaceMountId: string | null;
  deskWorkspaceLabel: string | null;
  /**
   * 当前 mount 工作台的 native 绝对根路径（服务端按 principal 披露）。
   * 归属与 deskWorkspaceMountId 一致：仅在 mount 工作台激活时非空；
   * 远端/虚拟 mount 或未披露时为 null。
   */
  deskWorkspaceNativeRoot: string | null;
  studioWorkspaces: StudioWorkspace[];
  workspaceFolders: string[];
  cwdHistory: string[];
  workspaceDeskStateByRoot: Record<string, WorkspaceDeskState>;
  setCwdSkills: (skills: CwdSkillInfo[]) => void;
  setCwdSkillsOpen: (open: boolean) => void;
  toggleCwdSkillsOpen: () => void;
  setDeskFiles: (files: DeskFile[]) => void;
  setDeskBasePath: (path: string) => void;
  setDeskCurrentPath: (path: string) => void;
  setDeskTreeFiles: (subdir: string, files: DeskFile[]) => void;
  setDeskExpandedPaths: (paths: string[]) => void;
  markDeskTreeDirty: (subdir: string) => void;
  clearDeskTreeDirty: (subdirs: string[]) => void;
  setDeskSelectedPath: (path: string) => void;
  clearDeskTree: () => void;
  setDeskJianContent: (content: string | null) => void;
  setHomeFolder: (folder: string | null) => void;
  setSelectedFolder: (folder: string | null) => void;
  setSelectedWorkspaceMount: (mountId: string | null, label?: string | null) => void;
  setDeskWorkspaceMount: (mountId: string | null, label?: string | null, nativeRoot?: string | null) => void;
  setStudioWorkspaces: (workspaces: StudioWorkspace[]) => void;
  setWorkspaceFolders: (folders: string[]) => void;
  setCwdHistory: (history: string[]) => void;
  setWorkspaceDeskState: (root: string, state: WorkspaceDeskState) => void;
}

export const createDeskSlice = (
  set: (partial: Partial<DeskSlice> | ((s: DeskSlice) => Partial<DeskSlice>)) => void,
): DeskSlice => ({
  deskFiles: [],
  deskBasePath: '',
  deskCurrentPath: '',
  deskTreeFilesByPath: {},
  deskExpandedPaths: [],
  deskDirtyTreePaths: [],
  deskSelectedPath: '',
  deskJianContent: null,
  cwdSkills: [],
  cwdSkillPolicy: {
    discoverProjectSkills: true,
    discoverCompatibleProjectSkills: false,
  },
  cwdSkillsOpen: false,
  homeFolder: null,
  selectedFolder: null,
  selectedWorkspaceMountId: null,
  selectedWorkspaceLabel: null,
  deskWorkspaceMountId: null,
  deskWorkspaceLabel: null,
  deskWorkspaceNativeRoot: null,
  studioWorkspaces: [],
  workspaceFolders: [],
  cwdHistory: [],
  workspaceDeskStateByRoot: {},
  setCwdSkills: (skills) => set({ cwdSkills: skills }),
  setCwdSkillsOpen: (open) => set({ cwdSkillsOpen: open }),
  toggleCwdSkillsOpen: () => set((s) => ({ cwdSkillsOpen: !s.cwdSkillsOpen })),
  setDeskFiles: (files) => set({ deskFiles: files }),
  setDeskBasePath: (path) => set({ deskBasePath: path }),
  setDeskCurrentPath: (path) => set({ deskCurrentPath: path }),
  setDeskTreeFiles: (subdir, files) => set((s) => ({
    deskTreeFilesByPath: {
      ...s.deskTreeFilesByPath,
      [subdir]: files,
    },
  })),
  setDeskExpandedPaths: (paths) => set({ deskExpandedPaths: paths }),
  markDeskTreeDirty: (subdir) => set((s) => {
    const normalized = (subdir || '').replace(/^\/+|\/+$/g, '');
    return s.deskDirtyTreePaths.includes(normalized)
      ? {}
      : { deskDirtyTreePaths: [...s.deskDirtyTreePaths, normalized] };
  }),
  clearDeskTreeDirty: (subdirs) => set((s) => {
    const clearSet = new Set(subdirs.map(subdir => (subdir || '').replace(/^\/+|\/+$/g, '')));
    if (clearSet.size === 0) return {};
    const next = s.deskDirtyTreePaths.filter(subdir => !clearSet.has(subdir));
    return next.length === s.deskDirtyTreePaths.length ? {} : { deskDirtyTreePaths: next };
  }),
  setDeskSelectedPath: (path) => set({ deskSelectedPath: path }),
  clearDeskTree: () => set({
    deskTreeFilesByPath: {},
    deskExpandedPaths: [],
    deskDirtyTreePaths: [],
    deskSelectedPath: '',
  }),
  setDeskJianContent: (content) => set({ deskJianContent: content }),
  setHomeFolder: (folder) => set({ homeFolder: folder }),
  setSelectedFolder: (folder) => set({ selectedFolder: folder }),
  setSelectedWorkspaceMount: (mountId, label = null) => set({
    selectedWorkspaceMountId: mountId,
    selectedWorkspaceLabel: label ?? null,
  }),
  setDeskWorkspaceMount: (mountId, label = null, nativeRoot = null) => set({
    deskWorkspaceMountId: mountId,
    deskWorkspaceLabel: mountId ? (label ?? null) : null,
    deskWorkspaceNativeRoot: mountId ? (nativeRoot ?? null) : null,
  }),
  setStudioWorkspaces: (workspaces) => set({ studioWorkspaces: workspaces }),
  setWorkspaceFolders: (folders) => set({ workspaceFolders: folders }),
  setCwdHistory: (history) => set({ cwdHistory: history }),
  setWorkspaceDeskState: (root, state) => set((s) => ({
    workspaceDeskStateByRoot: {
      ...s.workspaceDeskStateByRoot,
      [root]: state,
    },
  })),
});
