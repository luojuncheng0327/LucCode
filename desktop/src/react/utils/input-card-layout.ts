export interface InputCardLayoutMetrics {
  cardHeight: number;
  editorHeight: number;
  editorLineHeight: number;
  upperChromeHeight?: number;
}

function positiveFinite(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export function parseCssPixels(value: string, fallback: number): number {
  const parsed = Number.parseFloat(value);
  return positiveFinite(parsed) || positiveFinite(fallback);
}

export function calculateInputCardBottomInset(metrics: InputCardLayoutMetrics): number {
  const cardHeight = positiveFinite(metrics.cardHeight);
  const editorLineHeight = positiveFinite(metrics.editorLineHeight);
  const editorHeight = positiveFinite(metrics.editorHeight);
  const upperChromeHeight = positiveFinite(metrics.upperChromeHeight ?? 0);
  const editorExtraHeight = editorLineHeight > 0
    ? Math.max(0, editorHeight - editorLineHeight)
    : 0;
  const baseCardHeight = Math.max(0, cardHeight - editorExtraHeight);
  const upperChromeBandHeight = Math.min(upperChromeHeight, editorLineHeight);
  const pushHeight = Math.max(0, editorExtraHeight + upperChromeBandHeight - editorLineHeight);

  return baseCardHeight / 2 + pushHeight;
}
