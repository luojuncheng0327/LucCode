import { t } from "../../../lib/i18n.ts";

export const COVER_STYLE_GUIDE_VERSION = "2026-05-26";

export const COVER_STYLE_GUIDE = t("plugin.beautify.coverStyleGuide");

export function themeToneGuidance(themeTone) {
  return themeTone === "dark"
    ? t("plugin.beautify.themeTone.dark")
    : t("plugin.beautify.themeTone.light");
}

export function buildCoverStyleGuideForAgent({ themeTone = "light", userGuidance = "" } = {}) {
  return [
    COVER_STYLE_GUIDE,
    "",
    themeToneGuidance(themeTone),
    userGuidance ? t("plugin.beautify.userGuidancePrefix", { guidance: userGuidance }) : "",
  ].filter(Boolean).join("\n");
}
