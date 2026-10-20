/**
 * DeskSection — 笺侧栏的工作台内容区（编排层）
 *
 * 替代旧 desk.js 的 renderDeskFiles / initJianEditor / updateDeskEmptyOverlay 逻辑。
 * 由 App.tsx 在 .jian-chat-content 容器内直接渲染。
 *
 * 子组件拆分至 ./desk/ 目录。
 */

import { useCallback, useEffect, useState } from 'react';
import { useStore } from '../stores';
import { loadDeskTreeFiles } from '../stores/desk-actions';
import { schedulePersistCurrentWorkspaceUiState } from '../stores/workspace-ui-state-actions';
import { ContextMenu } from '../ui';
import { DESK_SORT_KEY, type SortMode, type CtxMenuState, type FileTypeFilter } from './desk/desk-types';
import { DeskFilterButton, DeskOpenIconButton, DeskPreviewIconButton, DeskSearchBox, DeskSortButton } from './desk/DeskToolbar';
import { DeskTree, type InlineCreateKind, type InlineTreeEdit } from './desk/DeskTree';
import { DeskDropZone } from './desk/DeskDropZone';
import { DeskEmptyOverlay } from './desk/DeskEmptyOverlay';
import { DeskCwdSkillsButton, DeskCwdSkillsPanel } from './desk/DeskCwdSkills';
import s from './desk/Desk.module.css';
import { workspaceDisplayName } from '../../../../shared/workspace-history.ts';

const DESK_FILTER_KEY = 'luc-desk-type-filters';
const VALID_TYPE_FILTERS = new Set<FileTypeFilter>(['image', 'text', 'video']);

function normalizeSubdir(value: string): string {
  return (value || '').replace(/^\/+|\/+$/g, '');
}

function isWindowsWorkspacePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value);
}

function normalizeSubdirCompareKey(basePath: string, value: string): string {
  const normalized = normalizeSubdir(value).replace(/\\/g, '/');
  return isWindowsWorkspacePath(basePath) ? normalized.toLowerCase() : normalized;
}

function visibleDirtyTreeReloads(basePath: string, dirtyPaths: string[], expandedPaths: string[]): {
  reloadSubdirs: string[];
  clearSubdirs: string[];
} {
  const visibleByKey = new Map<string, string>();
  for (const subdir of ['', ...expandedPaths]) {
    visibleByKey.set(normalizeSubdirCompareKey(basePath, subdir), subdir);
  }
  const reloadSubdirs: string[] = [];
  const clearSubdirs: string[] = [];
  for (const dirtySubdir of dirtyPaths) {
    const visibleSubdir = visibleByKey.get(normalizeSubdirCompareKey(basePath, dirtySubdir));
    if (visibleSubdir === undefined) continue;
    reloadSubdirs.push(visibleSubdir);
    clearSubdirs.push(dirtySubdir);
  }
  return { reloadSubdirs, clearSubdirs };
}

function uniqueDraftName(baseName: string, files: Array<{ name: string }>): string {
  const existing = new Set(files.map(file => file.name));
  if (!existing.has(baseName)) return baseName;
  const dotIndex = baseName.lastIndexOf('.');
  const hasExtension = dotIndex > 0;
  const stem = hasExtension ? baseName.slice(0, dotIndex) : baseName;
  const ext = hasExtension ? baseName.slice(dotIndex) : '';
  let index = 2;
  while (existing.has(`${stem} ${index}${ext}`)) index += 1;
  return `${stem} ${index}${ext}`;
}

function getInitialTypeFilters(): FileTypeFilter[] {
  try {
    const raw = localStorage.getItem(DESK_FILTER_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is FileTypeFilter => VALID_TYPE_FILTERS.has(item));
  } catch {
    return [];
  }
}

export function DeskSection({
  framed = true,
  showHeader = true,
  rightWorkspaceLayout = false,
}: {
  framed?: boolean;
  showHeader?: boolean;
  rightWorkspaceLayout?: boolean;
}) {
  const deskBasePath = useStore(st => st.deskBasePath);
  const deskExpandedPaths = useStore(st => st.deskExpandedPaths);
  const deskTreeFilesByPath = useStore(st => st.deskTreeFilesByPath);
  const deskDirtyTreePaths = useStore(st => st.deskDirtyTreePaths);
  const setDeskExpandedPaths = useStore(st => st.setDeskExpandedPaths);
  const selectedFolder = useStore(st => st.selectedFolder);
  const deskWorkspaceMountId = useStore(st => st.deskWorkspaceMountId);
  const deskWorkspaceLabel = useStore(st => st.deskWorkspaceLabel);
  const homeFolder = useStore(st => st.homeFolder);

  const [sortMode, setSortMode] = useState<SortMode>(
    () => (localStorage.getItem(DESK_SORT_KEY) as SortMode) || 'mtime-desc',
  );
  const [typeFilters, setTypeFilters] = useState<FileTypeFilter[]>(getInitialTypeFilters);
  const [inlineEdit, setInlineEdit] = useState<InlineTreeEdit>(null);
  const t = window.t ?? ((p: string) => p);

  useEffect(() => {
    if (!deskBasePath || deskDirtyTreePaths.length === 0) return;
    const { reloadSubdirs, clearSubdirs } = visibleDirtyTreeReloads(deskBasePath, deskDirtyTreePaths, deskExpandedPaths);
    if (reloadSubdirs.length === 0) return;
    for (let index = 0; index < reloadSubdirs.length; index += 1) {
      const subdir = reloadSubdirs[index];
      const dirtySubdir = clearSubdirs[index];
      void loadDeskTreeFiles(subdir, { force: true }).then((ok) => {
        if (ok !== false) useStore.getState().clearDeskTreeDirty([dirtySubdir]);
      });
    }
  }, [deskBasePath, deskDirtyTreePaths, deskExpandedPaths]);

  // ── 共享 context menu 状态 ──
  const [ctxMenu, setCtxMenu] = useState<CtxMenuState | null>(null);

  const handleShowMenu = useCallback((state: CtxMenuState) => {
    setCtxMenu(state);
  }, []);

  const handleCloseMenu = useCallback(() => {
    setCtxMenu(null);
  }, []);

  const handleStartCreate = useCallback(async (parentSubdir: string, kind: InlineCreateKind) => {
    const normalizedParent = normalizeSubdir(parentSubdir);
    if (normalizedParent && !deskExpandedPaths.includes(normalizedParent)) {
      setDeskExpandedPaths([...deskExpandedPaths, normalizedParent]);
      schedulePersistCurrentWorkspaceUiState();
    }
    if (normalizedParent && !deskTreeFilesByPath[normalizedParent]) {
      await loadDeskTreeFiles(normalizedParent);
    }
    const latest = useStore.getState();
    const siblings = latest.deskTreeFilesByPath?.[normalizedParent]
      || (normalizedParent === '' ? latest.deskFiles : []);
    const baseName = kind === 'markdown'
      ? t('desk.newMarkdownFileName')
      : t('desk.newFolder');
    setInlineEdit({
      mode: 'create',
      parentSubdir: normalizedParent,
      kind,
      draftName: uniqueDraftName(baseName, siblings || []),
      content: '',
      phase: 'editing',
    });
  }, [deskExpandedPaths, deskTreeFilesByPath, setDeskExpandedPaths, t]);

  const handleTypeFiltersChange = useCallback((filters: FileTypeFilter[]) => {
    localStorage.setItem(DESK_FILTER_KEY, JSON.stringify(filters));
    setTypeFilters(filters);
  }, []);

  const rootName = deskWorkspaceMountId
    ? (deskWorkspaceLabel || deskWorkspaceMountId)
    : workspaceDisplayName(deskBasePath || selectedFolder || homeFolder, t('desk.title'));
  const workspaceTitle = t('desk.workspaceTitle');
  const title = `${workspaceTitle} · ${rootName}`;
  const titlePath = deskWorkspaceMountId ? rootName : (deskBasePath || selectedFolder || homeFolder || undefined);

  return (
    <>
      <DeskDropZone
        onShowMenu={handleShowMenu}
        onStartCreate={handleStartCreate}
        framed={framed}
        rightWorkspaceLayout={rightWorkspaceLayout}
      >
        {showHeader && (
          <div className={s.header}>
            <div className={`jian-section-title ${s.sectionTitle}`} title={titlePath}>
              {title}
            </div>
            <DeskCwdSkillsButton />
          </div>
        )}
        {showHeader && <DeskCwdSkillsPanel />}
        <DeskSearchBox />
        <div className={s.toolbar}>
          <div className={s.toolbarActions}>
            <DeskPreviewIconButton />
            <DeskOpenIconButton />
            <DeskFilterButton filters={typeFilters} onFiltersChange={handleTypeFiltersChange} onShowMenu={handleShowMenu} />
            <DeskSortButton sortMode={sortMode} onSort={setSortMode} onShowMenu={handleShowMenu} />
          </div>
        </div>
        <DeskTree
          sortMode={sortMode}
          typeFilters={typeFilters}
          onShowMenu={handleShowMenu}
          inlineEdit={inlineEdit}
          onInlineEditChange={setInlineEdit}
          onStartCreate={handleStartCreate}
        />
        <DeskEmptyOverlay />
      </DeskDropZone>
      {ctxMenu && (
        <ContextMenu
          items={ctxMenu.items}
          position={ctxMenu.position}
          onClose={handleCloseMenu}
        />
      )}
    </>
  );
}
