import {
  dispatchCoverNotice,
  type MarkdownCoverTargetInput,
  requestMarkdownCoverGeneration,
} from './markdown-cover-generation';

export function isExternalCoverImagePath(imagePath: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(imagePath);
}

function localBasename(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  return normalized.slice(normalized.lastIndexOf('/') + 1) || 'cover.png';
}

function joinLocalPath(dirPath: string, fileName: string): string {
  const sep = dirPath.includes('\\') && !dirPath.includes('/') ? '\\' : '/';
  return `${dirPath.replace(/[\\/]+$/, '')}${sep}${fileName}`;
}

export async function saveMarkdownCoverImage(imagePath: string | null | undefined): Promise<void> {
  if (!imagePath || isExternalCoverImagePath(imagePath)) {
    dispatchCoverNotice('当前 cover 不是本地图片，无法直接保存。', 'error');
    return;
  }
  const folder = await window.platform?.selectFolder?.();
  if (!folder || !window.platform?.copyFile) return;
  const ok = await window.platform.copyFile(imagePath, joinLocalPath(folder, localBasename(imagePath)));
  dispatchCoverNotice(ok ? 'Cover 图片已保存。' : 'Cover 图片保存失败。', ok ? 'success' : 'error');
}

export async function regenerateMarkdownCoverWithPrompt(input: string | null | undefined | MarkdownCoverTargetInput): Promise<void> {
  if (!input) return;
  const targetInput = typeof input === 'string' ? { filePath: input } : input;
  const prompt = window.prompt('这张 cover 想往哪个方向调整？');
  if (prompt === null) return;
  const result = await requestMarkdownCoverGeneration({
    ...targetInput,
    userGuidance: prompt,
  });
  // 显式判别收窄：tsconfig.test.json（strictNullChecks: false）的编译闭包自 viewer 入口
  // 测试引入后覆盖到本文件，非严格模式下真值三元不收窄联合，=== false 两种模式都成立。
  if (result.ok === false) {
    dispatchCoverNotice(`Cover 生成失败：${result.error}`, 'error');
    return;
  }
  dispatchCoverNotice('已提交新的 cover 生成任务。', 'success');
}
