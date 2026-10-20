import { t } from "../../../lib/i18n.ts";

export const name = "list-capabilities";
export const description = t("toolDef.listCapabilities.description");

export { isBeautifyEnabledForAgentConfig as isEnabledForAgentConfig } from "../lib/availability.ts";

export const sessionPermission = { readOnly: true };

export const parameters = {
  type: "object",
  properties: {},
};

export async function execute() {
  return {
    content: [{
      type: "text",
      text: t("toolDef.listCapabilities.text"),
    }],
    details: {
      capabilities: [{
        id: "markdown-cover",
        target: "markdown",
        tools: ["beautify_get-cover-style-guide", "beautify_create-cover", "beautify_apply-cover-candidate"],
        imageRatio: "3:2",
        responsibility: "apply-existing-image",
      }, {
        id: "html-style-guide",
        target: "html",
        tools: ["beautify_get-html-style-guide"],
        responsibility: "style-guide-only",
      }],
    },
  };
}
