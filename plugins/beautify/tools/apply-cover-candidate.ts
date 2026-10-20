import path from "node:path";
import { applyMarkdownCoverFromGeneratedFile } from "../lib/markdown-cover-service.ts";
import { isBeautifyEnabledForAgentConfig } from "../lib/availability.ts";
import { t } from "../../../lib/i18n.ts";

export const name = "apply-cover-candidate";
export const description = t("toolDef.applyCoverCandidate.description");

export { isBeautifyEnabledForAgentConfig as isEnabledForAgentConfig };

export const sessionPermission = {
  kind: "review",
  describeSideEffect: (input: any = {}) => ({
    kind: "workspace_write",
    summary: `Apply a selected cover candidate to Markdown file ${input.targetFilePath || "unknown"}.`,
    ruleId: "beautify-markdown-cover-write",
  }),
};

export const parameters = {
  type: "object",
  properties: {
    targetFilePath: { type: "string", description: t("toolDef.applyCoverCandidate.targetFilePathDesc") },
    generatedFilePath: { type: "string", description: t("toolDef.applyCoverCandidate.generatedFilePathDesc") },
    pixelWidth: { type: "number", description: t("toolDef.applyCoverCandidate.pixelWidthDesc") },
    pixelHeight: { type: "number", description: t("toolDef.applyCoverCandidate.pixelHeightDesc") },
  },
  required: ["targetFilePath", "generatedFilePath"],
};

export async function execute(input, ctx) {
  if (!input.targetFilePath || !path.isAbsolute(input.targetFilePath)) {
    return { content: [{ type: "text", text: t("toolDef.applyCoverCandidate.targetFilePathRequired") }] };
  }
  if (!input.generatedFilePath || !path.isAbsolute(input.generatedFilePath)) {
    return { content: [{ type: "text", text: t("toolDef.applyCoverCandidate.generatedFilePathRequired") }] };
  }

  try {
    const result = await applyMarkdownCoverFromGeneratedFile({
      markdownFilePath: input.targetFilePath,
      generatedFilePath: input.generatedFilePath,
      pixelWidth: input.pixelWidth,
      pixelHeight: input.pixelHeight,
      resourceIO: ctx?.resources,
      operationContext: {
        source: "plugin",
        reason: "plugin:beautify:apply-cover-candidate",
        sessionId: ctx?.sessionId || null,
        sessionPath: ctx?.sessionPath || null,
        principal: {
          kind: "plugin",
          pluginId: ctx?.pluginId || "beautify",
          userId: ctx?.userId || null,
          studioId: ctx?.studioId || null,
          sessionId: ctx?.sessionId || null,
          sessionPath: ctx?.sessionPath || null,
          connectionKind: ctx?.connectionKind || null,
          credentialKind: ctx?.credentialKind || null,
        },
      },
    });
    return {
      content: [{ type: "text", text: t("toolDef.applyCoverCandidate.applied") }],
      details: { beautifyCover: result },
    };
  } catch (err) {
    return { content: [{ type: "text", text: t("toolDef.applyCoverCandidate.failed", { error: err?.message || err }) }] };
  }
}
