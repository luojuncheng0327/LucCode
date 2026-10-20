import {
  clearAppFileDragPayload,
  readAppFileDragPayload,
  type AppDraggedFile,
} from './app-file-drag';
import { extOfName, isImageOrSvgExt } from './file-kind';
import {
  applyMarkdownCoverImage,
  dispatchCoverNotice,
  type MarkdownCoverTargetInput,
  type WorkbenchMarkdownCoverTarget,
} from './markdown-cover-generation';
import {
  refreshPreviewDocumentTarget,
  type PreviewDocumentTarget,
} from './preview-document-refresh';
import { encodeWorkbenchContentPath } from './remote-file-preview';
import type { RemoteWorkbenchContentRef } from '../types';

function draggedFileIsImage(file: AppDraggedFile): boolean {
  if (file.isDirectory || !file.path) return false;
  const mime = file.mimeType?.toLowerCase() || '';
  if (mime.startsWith('image/')) return true;
  return isImageOrSvgExt(extOfName(file.name) || extOfName(file.path));
}

export function getMarkdownCoverDropImagePath(dataTransfer?: DataTransfer | null): string | null {
  const payload = readAppFileDragPayload(dataTransfer);
  const file = payload?.files.find(draggedFileIsImage);
  if (file?.path) return file.path;
  const browserFile = getMarkdownCoverDropImageFile(dataTransfer);
  return browserFile ? window.platform?.getFilePath?.(browserFile) || null : null;
}

export function hasMarkdownCoverDropImage(dataTransfer?: DataTransfer | null): boolean {
  return Boolean(getMarkdownCoverDropImagePath(dataTransfer) || getMarkdownCoverDropImageFile(dataTransfer));
}

function dataTransferFiles(dataTransfer?: DataTransfer | null): File[] {
  if (!dataTransfer) return [];
  const files = Array.from(dataTransfer.files || []);
  if (files.length > 0) return files;
  return Array.from(dataTransfer.items || [])
    .filter(item => item.kind === 'file')
    .map(item => item.getAsFile())
    .filter((file): file is File => !!file);
}

function browserFileIsImage(file: File): boolean {
  const mime = file.type?.toLowerCase() || '';
  if (mime.startsWith('image/')) return true;
  return isImageOrSvgExt(extOfName(file.name));
}

function getMarkdownCoverDropImageFile(dataTransfer?: DataTransfer | null): File | null {
  return dataTransferFiles(dataTransfer).find(browserFileIsImage) || null;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error('failed to read cover image'));
    reader.onload = () => {
      const result = String(reader.result || '');
      resolve(result.includes(',') ? result.split(',').pop() || '' : result);
    };
    reader.readAsDataURL(file);
  });
}

function coverTargetInput(filePath: string | null | undefined, target?: WorkbenchMarkdownCoverTarget | RemoteWorkbenchContentRef | null): MarkdownCoverTargetInput | null {
  if (filePath) return { filePath };
  if (target) return { target };
  return null;
}

function previewDocumentTargetFromCoverInput(input: MarkdownCoverTargetInput): PreviewDocumentTarget {
  if ('filePath' in input && input.filePath) {
    return { kind: 'local-file', filePath: input.filePath };
  }
  if (!('target' in input) || !input.target) {
    throw new Error('markdown cover target is required');
  }
  const target = input.target;
  const mountId = target.mountId || target.rootId || 'default';
  const rootId = target.rootId || mountId;
  const subdir = target.subdir || '';
  const name = target.name;
  return {
    kind: 'workbench-file',
    target: {
      kind: 'workbench-file',
      mountId,
      rootId,
      subdir,
      name,
      contentPath: encodeWorkbenchContentPath({ mountId, rootId, subdir, name }),
    },
  };
}

export async function applyMarkdownCoverImageDrop({
  filePath,
  target,
  dataTransfer,
}: {
  filePath?: string | null;
  target?: WorkbenchMarkdownCoverTarget | RemoteWorkbenchContentRef | null;
  dataTransfer?: DataTransfer | null;
}): Promise<boolean> {
  const targetInput = coverTargetInput(filePath, target);
  if (!targetInput) return false;
  const payload = readAppFileDragPayload(dataTransfer);
  const imageFilePath = getMarkdownCoverDropImagePath(dataTransfer);
  const imageFile = getMarkdownCoverDropImageFile(dataTransfer);
  if (!imageFilePath && !imageFile) return false;

  try {
    const useUpload = Boolean(target) && imageFile;
    const result = useUpload
      ? await applyMarkdownCoverImage({
        ...targetInput,
        image: {
          filename: imageFile.name || 'cover.png',
          contentBase64: await fileToBase64(imageFile),
        },
      })
      : await applyMarkdownCoverImage({
        ...targetInput,
        imageFilePath: imageFilePath!,
      });
    // 显式判别收窄（=== false）：见 markdown-cover-actions.ts 同型注释，
    // 兼容 tsconfig.test.json 的非严格编译闭包。
    if (result.ok === false) {
      dispatchCoverNotice(`Cover 更新失败：${result.error}`, 'error');
      return true;
    }

    try {
      await refreshPreviewDocumentTarget(previewDocumentTargetFromCoverInput(targetInput));
      dispatchCoverNotice('Cover 已更新。', 'success');
    } catch (refreshErr) {
      const message = refreshErr instanceof Error ? refreshErr.message : String(refreshErr);
      dispatchCoverNotice(`Cover 已更新，但刷新失败：${message}`, 'error');
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    dispatchCoverNotice(`Cover 更新失败：${message}`, 'error');
  } finally {
    if (payload) clearAppFileDragPayload(payload.dragId);
  }

  return true;
}
