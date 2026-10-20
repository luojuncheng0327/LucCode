import { extOfName, isImageOrSvgExt } from './file-kind';

export const ATTACHMENT_DIR_NAME = '文本附件';

export interface MarkdownAttachmentPlanInput {
  markdownFilePath: string;
  originalName: string;
  mimeType?: string | null;
  uniqueSuffix?: string;
  index?: number;
}

export interface MarkdownAttachmentPlan {
  attachmentPath: string;
  relativePath: string;
  storedName: string;
  markdown: string;
  isImage: boolean;
}

const MIME_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'application/pdf': 'pdf',
  'text/html': 'html',
};

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function formatAttachmentTimestamp(date = new Date()): string {
  return [
    date.getUTCFullYear(),
    pad2(date.getUTCMonth() + 1),
    pad2(date.getUTCDate()),
    '-',
    pad2(date.getUTCHours()),
    pad2(date.getUTCMinutes()),
    pad2(date.getUTCSeconds()),
  ].join('');
}

function normalizePathSeparators(value: string): string {
  return value.replace(/\\/g, '/');
}

function dirnamePortable(filePath: string): string {
  const normalized = normalizePathSeparators(filePath);
  const slash = normalized.lastIndexOf('/');
  if (slash < 0) return '';
  if (slash === 0) return '/';
  return normalized.slice(0, slash);
}

function joinPortable(base: string, ...segments: string[]): string {
  const cleaned = segments
    .map(segment => normalizePathSeparators(segment).replace(/^\/+|\/+$/g, ''))
    .filter(Boolean);
  if (base === '/') return `/${cleaned.join('/')}`;
  return [base.replace(/\/+$/g, ''), ...cleaned].filter(Boolean).join('/');
}

function basenamePortable(value: string): string {
  const normalized = normalizePathSeparators(value);
  const slash = normalized.lastIndexOf('/');
  return slash >= 0 ? normalized.slice(slash + 1) : normalized;
}

function sanitizeNamePart(value: string, fallback: string): string {
  const cleaned = Array.from(value, char => {
    const code = char.charCodeAt(0);
    return code <= 0x1f || '<>:"/\\|?*'.includes(char) ? ' ' : char;
  })
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+|\.+$/g, '');
  return cleaned || fallback;
}

function extensionFromMime(mimeType?: string | null): string {
  if (!mimeType) return '';
  return MIME_EXTENSIONS[mimeType.toLowerCase()] || '';
}

function splitAttachmentName(originalName: string, mimeType?: string | null): { base: string; ext: string } {
  const basename = sanitizeNamePart(basenamePortable(originalName), 'attachment');
  const detectedExt = extOfName(basename) || extensionFromMime(mimeType);
  const ext = sanitizeNamePart(detectedExt.toLowerCase(), '');
  if (!ext) return { base: sanitizeNamePart(basename, 'attachment'), ext: '' };

  const suffix = `.${ext}`;
  const base = basename.toLowerCase().endsWith(suffix)
    ? basename.slice(0, -suffix.length)
    : basename;
  return {
    base: sanitizeNamePart(base, 'attachment'),
    ext,
  };
}

function attachmentSuffix(uniqueSuffix?: string, index = 0): string {
  const suffix = uniqueSuffix || formatAttachmentTimestamp();
  return index > 0 ? `${suffix}-${index + 1}` : suffix;
}

function markdownDestination(relativePath: string): string {
  return `<${relativePath.replace(/>/g, '%3E')}>`;
}

function markdownLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/([\[\]])/g, '\\$1');
}

export function buildMarkdownAttachmentPlan(input: MarkdownAttachmentPlanInput): MarkdownAttachmentPlan {
  const { base, ext } = splitAttachmentName(input.originalName, input.mimeType);
  const suffix = attachmentSuffix(input.uniqueSuffix, input.index ?? 0);
  const storedName = `${base}-${suffix}${ext ? `.${ext}` : ''}`;
  const markdownDir = dirnamePortable(input.markdownFilePath);
  const relativePath = `${ATTACHMENT_DIR_NAME}/${storedName}`;
  const attachmentPath = joinPortable(markdownDir, ATTACHMENT_DIR_NAME, storedName);
  const isImage = Boolean(input.mimeType?.toLowerCase().startsWith('image/')) || isImageOrSvgExt(ext);
  const destination = markdownDestination(relativePath);
  const markdown = isImage
    ? `![${markdownLabel(base)}](${destination})`
    : `[${markdownLabel(basenamePortable(input.originalName) || storedName)}](${destination})`;

  return {
    attachmentPath,
    relativePath,
    storedName,
    markdown,
    isImage,
  };
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}
