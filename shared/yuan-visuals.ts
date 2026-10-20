export interface YuanVisual {
  yuan: string;
  symbol: string;
  moodLabel: string;
  accent: string;
  avatar: string;
}

const FALLBACK_YUAN = "luc";

export const YUAN_VISUALS: Readonly<Record<string, Readonly<YuanVisual>>> = Object.freeze({
  luc: Object.freeze({
    yuan: "luc",
    symbol: "✿",
    moodLabel: "MOOD",
    accent: "#537D96",
    avatar: "Luc.png",
  }),
  butter: Object.freeze({
    yuan: "butter",
    symbol: "❊",
    moodLabel: "PULSE",
    accent: "#5BA88C",
    avatar: "Butter.png",
  }),
  ming: Object.freeze({
    yuan: "ming",
    symbol: "◈",
    moodLabel: "REFLECT",
    accent: "#8BA4B4",
    avatar: "Ming.png",
  }),
});

export function normalizeYuan(yuan?: string | null): string {
  const key = String(yuan || "").trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(YUAN_VISUALS, key) ? key : FALLBACK_YUAN;
}

export function getYuanVisual(yuan?: string | null): Readonly<YuanVisual> {
  return YUAN_VISUALS[normalizeYuan(yuan)];
}

export function moodLabelForYuan(yuan?: string | null): string {
  const visual = getYuanVisual(yuan);
  return `${visual.symbol} ${visual.moodLabel}`;
}
