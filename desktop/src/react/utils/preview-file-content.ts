import type { PreviewItem } from '../types';

export const PREVIEWABLE_EXTS: Record<string, string> = {
  html: 'html', htm: 'html',
  md: 'markdown', markdown: 'markdown',
  js: 'code', ts: 'code', jsx: 'code', tsx: 'code',
  py: 'code', css: 'code', json: 'code', yaml: 'code', yml: 'code',
  xml: 'code', sql: 'code', sh: 'code', bash: 'code',
  txt: 'code',
  c: 'code', cpp: 'code', h: 'code', java: 'code',
  rs: 'code', go: 'code', rb: 'code', php: 'code',
  csv: 'csv', pdf: 'pdf',
  docx: 'docx', xlsx: 'xlsx', xls: 'xlsx',
};

export const BINARY_PREVIEW_TYPES = new Set(['pdf']);

export interface PreviewReadResult {
  content: string;
  sourceUrl?: string;
  fileVersion?: PreviewItem['fileVersion'];
}

export async function readFileForPreviewType(filePath: string, previewType: string): Promise<PreviewReadResult | null> {
  const p = window.platform;
  if (!p) return null;
  if (previewType === 'file-info') return { content: '' };
  if (previewType === 'docx') {
    const content = await p.readDocxHtml?.(filePath);
    return content == null ? null : { content };
  }
  if (previewType === 'xlsx') {
    const content = await p.readXlsxHtml?.(filePath);
    return content == null ? null : { content };
  }
  if (BINARY_PREVIEW_TYPES.has(previewType)) {
    const sourceUrl = p.getFileUrl?.(filePath);
    if (sourceUrl) return { content: '', sourceUrl };
    const content = await p.readFileBase64?.(filePath);
    return content == null ? null : { content };
  }

  const snapshot = await p.readFileSnapshot?.(filePath);
  if (snapshot) return { content: snapshot.content, fileVersion: snapshot.version };

  const content = await p.readFile?.(filePath);
  return content == null ? null : { content };
}

export async function readFileForPreviewWithVersion(filePath: string, ext: string): Promise<PreviewReadResult | null> {
  const normalizedExt = ext.replace(/^\./, '').toLowerCase();
  const previewType = PREVIEWABLE_EXTS[normalizedExt];
  if (!previewType) return null;
  return readFileForPreviewType(filePath, previewType);
}

export async function readFileForPreview(filePath: string, ext: string): Promise<string | null> {
  return (await readFileForPreviewWithVersion(filePath, ext))?.content ?? null;
}
