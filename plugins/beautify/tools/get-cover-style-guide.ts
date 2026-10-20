import {
  COVER_STYLE_GUIDE_VERSION,
  buildCoverStyleGuideForAgent,
} from "../lib/cover-style-guide.ts";
import { isBeautifyEnabledForAgentConfig } from "../lib/availability.ts";
import { t } from "../../../lib/i18n.ts";

export const name = "get-cover-style-guide";
export const description = t("toolDef.getCoverStyleGuide.description");

export { isBeautifyEnabledForAgentConfig as isEnabledForAgentConfig };

export const sessionPermission = { readOnly: true };

export const parameters = {
  type: "object",
  properties: {
    themeTone: {
      type: "string",
      enum: ["light", "dark"],
      description: t("toolDef.getCoverStyleGuide.themeToneDesc"),
    },
    userGuidance: {
      type: "string",
      description: t("toolDef.getCoverStyleGuide.userGuidanceDesc"),
    },
  },
};

export async function execute( input: any = {}) {
  const themeTone = input.themeTone === "dark" ? "dark" : "light";
  const userGuidance = typeof input.userGuidance === "string" ? input.userGuidance.trim() : "";
  return {
    content: [{
      type: "text",
      text: buildCoverStyleGuideForAgent({ themeTone, userGuidance }),
    }],
    details: {
      version: COVER_STYLE_GUIDE_VERSION,
      themeTone,
      workflow: [
        t("toolDef.getCoverStyleGuide.workflow.step1"),
        t("toolDef.getCoverStyleGuide.workflow.step2"),
        t("toolDef.getCoverStyleGuide.workflow.step3"),
        t("toolDef.getCoverStyleGuide.workflow.step4"),
        t("toolDef.getCoverStyleGuide.workflow.step5"),
      ],
    },
  };
}
