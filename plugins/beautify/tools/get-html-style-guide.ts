import {
  HTML_STYLE_GUIDE_SECTIONS,
  HTML_STYLE_GUIDE_VERSION,
  REQUIRED_SECTIONS,
  buildHtmlStyleGuideRouter,
  buildHtmlStyleGuideSection,
  getReadSections,
  markSectionRead,
  missingRequiredSections,
  sessionTrackingKey,
} from "../lib/html-style-guide.ts";
import { isBeautifyEnabledForAgentConfig } from "../lib/availability.ts";
import { t } from "../../../lib/i18n.ts";

export const name = "get-html-style-guide";
export const description = t("toolDef.getHtmlStyleGuide.description");

export const promptGuidelines = [
  "Call beautify_get-html-style-guide BEFORE generating any full-page HTML (web page, landing page, report, typeset article) when the user has not specified a style.",
  "First call with no arguments to get the router, then fetch sections one by one: color and typography are mandatory, layout for full pages, others on demand.",
  "Do not generate HTML from the router text alone — it deliberately contains no concrete values.",
  "If the user explicitly specified a style / brand / palette, follow the user; this guide steps aside and only backstops readability.",
  "This tool serves standalone full-page HTML documents only. In-chat interactive cards are a separate feature — never mix the two.",
  "This tool only returns guidance text. Write and save the HTML yourself with regular file output; beautify does not generate or save HTML.",
].join("\n");

export { isBeautifyEnabledForAgentConfig as isEnabledForAgentConfig };

export const sessionPermission = { readOnly: true };

export const parameters = {
  type: "object",
  properties: {
    section: {
      type: "string",
      enum: HTML_STYLE_GUIDE_SECTIONS,
      description: t("toolDef.getHtmlStyleGuide.sectionDesc"),
    },
  },
};

function textResult(text: string, details: Record<string, any>): {
  content: Array<{ type: string; text: string }>;
  details: Record<string, any>;
} {
  return {
    content: [{ type: "text", text }],
    details: { version: HTML_STYLE_GUIDE_VERSION, ...details },
  };
}

export async function execute(input: any = {}, ctx?: any) {
  const trackingKey = sessionTrackingKey(ctx);
  const section = typeof input?.section === "string" ? input.section.trim() : "";

  if (!section) {
    return textResult(buildHtmlStyleGuideRouter(), { kind: "router" });
  }

  const text = buildHtmlStyleGuideSection(section);
  if (text === null) {
    return textResult(
      t("plugin.beautify.htmlStyleGuide.invalidSection", {
        section,
        valid: HTML_STYLE_GUIDE_SECTIONS.join(", "),
      }),
      { kind: "invalid-section", valid: HTML_STYLE_GUIDE_SECTIONS },
    );
  }

  const missing = missingRequiredSections(trackingKey);
  if (!REQUIRED_SECTIONS.includes(section) && missing.length > 0) {
    return textResult(
      t("plugin.beautify.htmlStyleGuide.mustReadFirst", {
        section,
        missing: missing.join(", "),
      }),
      { kind: "must-read-first", missingRequired: missing },
    );
  }

  markSectionRead(trackingKey, section);
  return textResult(text, {
    kind: "section",
    section,
    readSections: getReadSections(trackingKey),
  });
}
