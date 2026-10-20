/**
 * file-preview.ts — 文件预览工具函数
 *
 * 从 file-cards-shim.ts 提取，供 React 组件直接 import。
 */

import type { PreviewItem } from '../types';
import { openPreview } from '../stores/preview-actions';
import { inferKindByExt, isMediaKind } from './file-kind';
import { openMediaViewerFromContext } from './open-media-viewer';
import {
  PREVIEWABLE_EXTS,
  BINARY_PREVIEW_TYPES,
  readFileForPreview,
  readFileForPreviewWithVersion,
} from './preview-file-content';
import { showError } from './ui-helpers';

export { PREVIEWABLE_EXTS, BINARY_PREVIEW_TYPES, readFileForPreview };

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface SkillPreviewSource {
  skillName?: unknown;
  baseDir?: unknown;
  filePath?: unknown;
  installed?: unknown;
}

function nonEmptyString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function inferSkillBaseDir(filePath: string): string {
  const normalized = filePath.trim().replace(/[\\/]+$/, '');
  const lastSeparator = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'));
  if (lastSeparator < 0) return '';

  const fileName = normalized.slice(lastSeparator + 1).toLowerCase();
  if (fileName !== 'skill.md') return '';

  return lastSeparator === 0 ? normalized.slice(0, 1) : normalized.slice(0, lastSeparator);
}

/**
 * 打开文件预览：读取文件内容 → 创建 PreviewItem → 打开预览面板
 *
 * @param context 调用上下文。media 类型（image/svg/video）会按 context 分流到 MediaViewer；
 *   其它类型走 Preview 面板。context 必须由调用方显式提供，不从 store 推导。
 */
export async function openFilePreview(
  filePath: string,
  label: string,
  ext: string,
  context?: {
    origin?: 'desk' | 'session';
    sessionPath?: string;
    messageId?: string;
    fileId?: string;
    blockIdx?: number;
    sourceRootPath?: string;
  },
): Promise<void> {
  const fileName = label || filePath.split('/').pop() || filePath;
  const normalizedExt = ext.replace(/^\./, '').toLowerCase();

  try {
    if (normalizedExt === 'skill') {
      // .skill 文件可能是纯文本也可能是 zip，先尝试读取内容在预览面板展示
      const name = fileName.replace(/\.skill$/, '');
      const content = await window.platform?.readFile?.(filePath);
      if (content != null) {
        const body = content.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, '');
        const previewItem: PreviewItem = {
          id: `skill-${name}`,
          type: 'markdown',
          title: name,
          content: body,
        };
        openPreview(previewItem);
        return;
      }
      // 读取失败（可能是 zip 格式），尝试 skill viewer
      window.platform?.openSkillViewer?.({ skillPath: filePath });
      return;
    }

    // Media 类型（image / svg / video）分流到 MediaViewer，不经过 Preview 面板。
    const mediaKind = inferKindByExt(normalizedExt);
    if (isMediaKind(mediaKind)) {
      openMediaViewerFromContext({
        ext: normalizedExt,
        filePath,
        label: fileName,
        kind: mediaKind,
        origin: context?.origin,
        sessionPath: context?.sessionPath,
        messageId: context?.messageId,
        fileId: context?.fileId,
        blockIdx: context?.blockIdx,
      });
      return;
    }

    const canPreview = normalizedExt in PREVIEWABLE_EXTS;
    if (canPreview) {
      const readResult = await readFileForPreviewWithVersion(filePath, normalizedExt);
      if (readResult != null) {
        const previewType = PREVIEWABLE_EXTS[normalizedExt];
        const previewItem: PreviewItem = {
          id: `file-${filePath}`,
          type: previewType,
          title: fileName,
          content: readResult.content,
          filePath,
          ext: normalizedExt,
          sourceUrl: readResult.sourceUrl,
          sourceRootPath: context?.sourceRootPath,
          fileVersion: readResult.fileVersion,
          language: previewType === 'code' ? normalizedExt : undefined,
        };
        openPreview(previewItem);
        return;
      }
    }

    // 无法预览的文件类型
    const previewItem: PreviewItem = {
      id: `file-${filePath}`,
      type: 'file-info',
      title: fileName,
      content: '',
      filePath,
      ext: normalizedExt,
    };
    openPreview(previewItem);
  } catch (err) {
    console.error('[file-preview] open preview failed:', err);
    showError(getErrorMessage(err));
  }
}

/**
 * 打开 Skill 预览：交给既有 Skill Viewer overlay，避免把 SKILL.md 当普通 markdown tab。
 */
export async function openSkillPreview(
  skillName: string,
  skillFilePath: string,
  source?: SkillPreviewSource | null,
): Promise<void> {
  try {
    const sourceFilePath = nonEmptyString(source?.filePath);
    const filePath = sourceFilePath || nonEmptyString(skillFilePath);
    const baseDir = nonEmptyString(source?.baseDir) || inferSkillBaseDir(filePath);

    if (!baseDir) {
      showError('skill preview path missing');
      return;
    }

    if (!window.platform?.openSkillViewer) {
      showError('skill viewer unavailable');
      return;
    }

    window.platform.openSkillViewer({
      name: nonEmptyString(source?.skillName) || nonEmptyString(skillName) || 'Skill',
      baseDir,
      filePath: filePath || undefined,
      installed: typeof source?.installed === 'boolean' ? source.installed : true,
    });
  } catch (err) {
    console.error('[file-preview] open skill preview failed:', err);
    showError(getErrorMessage(err));
  }
}
