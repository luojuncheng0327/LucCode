export type PreviewReadingMode = "preview" | "edit";

export interface PreviewScrollSnapshot {
  scrollTop: number;
  scrollLeft?: number;
  scrollHeight?: number;
  clientHeight?: number;
  ratio?: number;
  anchorId?: string;
  anchorText?: string;
  contentHash?: string;
  updatedAt?: number;
}

export interface PreviewReadingPosition {
  preview?: PreviewScrollSnapshot;
  edit?: PreviewScrollSnapshot;
  currentHeadingId?: string;
  currentHeadingText?: string;
  contentHash?: string;
  updatedAt?: number;
}

const MAX_STRING = 512;
const MAX_SCROLL = 10_000_000;

function cleanString(value: unknown, max = MAX_STRING): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function cleanNumber(value: unknown, min: number, max: number): number | undefined {
  if (!Number.isFinite(value)) return undefined;
  return Math.min(max, Math.max(min, Number(value)));
}

function normalizeScrollSnapshot(raw: unknown): PreviewScrollSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const source = raw as Record<string, unknown>;
  const scrollTop = cleanNumber(source.scrollTop, 0, MAX_SCROLL);
  if (scrollTop === undefined) return null;
  const scrollLeft = cleanNumber(source.scrollLeft, 0, MAX_SCROLL);
  const scrollHeight = cleanNumber(source.scrollHeight, 0, MAX_SCROLL);
  const clientHeight = cleanNumber(source.clientHeight, 0, MAX_SCROLL);
  const ratio = cleanNumber(source.ratio, 0, 1);
  const anchorId = cleanString(source.anchorId, 256);
  const anchorText = cleanString(source.anchorText, 256);
  const contentHash = cleanString(source.contentHash, 128);
  const updatedAt = cleanNumber(source.updatedAt, 0, Number.MAX_SAFE_INTEGER);

  return {
    scrollTop,
    ...(scrollLeft ? { scrollLeft } : {}),
    ...(scrollHeight ? { scrollHeight } : {}),
    ...(clientHeight ? { clientHeight } : {}),
    ...(ratio !== undefined ? { ratio } : {}),
    ...(anchorId ? { anchorId } : {}),
    ...(anchorText ? { anchorText } : {}),
    ...(contentHash ? { contentHash } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
  };
}

export function normalizePreviewReadingPosition(raw: unknown): PreviewReadingPosition | null {
  if (!raw || typeof raw !== "object") return null;
  const source = raw as Record<string, unknown>;
  const preview = normalizeScrollSnapshot(source.preview);
  const edit = normalizeScrollSnapshot(source.edit);
  const currentHeadingId = cleanString(source.currentHeadingId, 256);
  const currentHeadingText = cleanString(source.currentHeadingText, 256);
  const contentHash = cleanString(source.contentHash, 128);
  const updatedAt = cleanNumber(source.updatedAt, 0, Number.MAX_SAFE_INTEGER);
  if (!preview && !edit && !currentHeadingId && !currentHeadingText && !contentHash) return null;
  return {
    ...(preview ? { preview } : {}),
    ...(edit ? { edit } : {}),
    ...(currentHeadingId ? { currentHeadingId } : {}),
    ...(currentHeadingText ? { currentHeadingText } : {}),
    ...(contentHash ? { contentHash } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
  };
}

export function normalizePreviewReadingPositions(
  raw: unknown,
  allowedIds?: Iterable<string>,
): Record<string, PreviewReadingPosition> {
  if (!raw || typeof raw !== "object") return {};
  const allowed = allowedIds ? new Set(allowedIds) : null;
  const out: Record<string, PreviewReadingPosition> = {};
  for (const [rawId, value] of Object.entries(raw as Record<string, unknown>)) {
    const id = cleanString(rawId, 256);
    if (!id || (allowed && !allowed.has(id))) continue;
    const normalized = normalizePreviewReadingPosition(value);
    if (normalized) out[id] = normalized;
  }
  return out;
}
