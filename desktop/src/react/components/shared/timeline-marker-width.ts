export function measureTimelineMarkerWidthEm(promptLength: number): number {
  if (!Number.isFinite(promptLength) || promptLength <= 2) return 0.5;

  const normalized = Math.min(1, Math.log1p(promptLength - 2) / Math.log1p(80));
  return Number((0.5 + normalized * 0.5).toFixed(3));
}
