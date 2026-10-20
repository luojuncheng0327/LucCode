/**
 * file-history-slice — 文件历史弹窗的开关与预选状态
 *
 * 弹窗是全局单例表面：工作区树、编辑器、命令面板都可能把它拉起来，且拉起时
 * 想直接定位到某个文件。所以"开没开 / 预选哪个文件"属于应用级 UI 状态，不属于
 * 任何一个触发组件。
 *
 * 预选一律以工作区相对路径（POSIX 分隔符）为准，与 server 端 file-history 路由
 * 的 relPath 契约一致。调用方手上只有绝对路径时走
 * openFileHistoryForAbsolutePath，由这里按当前工作区根换算；根未知或路径不在根内
 * 时只开弹窗、不预选，不猜测、不静默拼一个可能错的相对路径。
 */

import type { DeskSlice } from './desk-slice';

export interface FileHistoryModalState {
  open: boolean;
  /** 预选文件（工作区相对路径，POSIX 分隔符）；null = 不预选 */
  preselectRelPath: string | null;
}

export interface FileHistorySlice {
  fileHistoryModal: FileHistoryModalState;
  openFileHistoryModal: (preselectRelPath?: string | null) => void;
  /** 绝对路径入口：按当前工作区根换算相对路径后打开；根未知或不在根内时不预选 */
  openFileHistoryForAbsolutePath: (absPath: string) => void;
  closeFileHistoryModal: () => void;
}

function toRelPath(absPath: string, root: string | null | undefined): string | null {
  if (!root) return null;
  const normalizedRoot = root.replace(/\\/g, '/').replace(/\/+$/, '');
  const normalizedPath = absPath.replace(/\\/g, '/');
  const prefix = `${normalizedRoot}/`;
  return normalizedPath.startsWith(prefix) ? normalizedPath.slice(prefix.length) : null;
}

export const createFileHistorySlice = (
  set: (partial: Partial<FileHistorySlice>) => void,
  get: () => Pick<DeskSlice, 'deskWorkspaceNativeRoot' | 'deskBasePath'>,
): FileHistorySlice => ({
  fileHistoryModal: { open: false, preselectRelPath: null },

  openFileHistoryModal: (preselectRelPath = null) => set({
    fileHistoryModal: { open: true, preselectRelPath },
  }),

  openFileHistoryForAbsolutePath: (absPath) => {
    const state = get();
    const root = state.deskWorkspaceNativeRoot || state.deskBasePath || null;
    set({ fileHistoryModal: { open: true, preselectRelPath: toRelPath(absPath, root) } });
  },

  closeFileHistoryModal: () => set({
    fileHistoryModal: { open: false, preselectRelPath: null },
  }),
});
