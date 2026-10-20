import { getYuanVisual, moodLabelForYuan } from "../shared/yuan-visuals.ts";

export const ansi = Object.freeze({
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  italic: "\x1b[3m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
  gray: "\x1b[90m",
});

export function color(hex) {
  const value = String(hex || "").replace("#", "");
  if (!/^[0-9a-f]{6}$/i.test(value)) return "";
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return `\x1b[38;2;${r};${g};${b}m`;
}

export function createTerminalTheme(yuan) {
  const visual = getYuanVisual(yuan);
  const accent = color(visual.accent);
  return {
    yuan: visual.yuan,
    symbol: visual.symbol,
    moodLabel: moodLabelForYuan(visual.yuan),
    accentColor: visual.accent,
    accent,
    reset: ansi.reset,
    dim: ansi.dim,
    bold: ansi.bold,
    italic: ansi.italic,
    red: ansi.red,
    yellow: ansi.yellow,
    green: ansi.green,
    gray: ansi.gray,
  };
}

export function paint(theme, text) {
  return `${theme.accent}${text}${ansi.reset}`;
}
