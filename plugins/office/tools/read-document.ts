import { readOfficeDocument } from "../lib/read-document.ts";

export { isOfficeEnabledForAgentConfig as isEnabledForAgentConfig } from "../lib/availability.ts";

export const name = "read-document";

export const description = [
  "Read supported Office/text documents into structured text for the Agent.",
  "Use for .docx, .xlsx, .xlsm, .pdf, .txt, .md, .csv, .tsv, and .html files.",
  "PDF output is Markdown text with 1-based pageRange continuation metadata; OCR for scanned/image-only PDFs is not supported.",
  "Use resource for user workspace or mount files. filePath remains accepted for legacy local-only callers.",
  "Does not modify files. Unsupported legacy formats such as .doc, .xls, .ppt, and .pptx fail explicitly.",
].join(" ");

export const sessionPermission = { readOnly: true };

export const parameters = {
  type: "object",
  properties: {
    resource: {
      type: "object",
      description: "ResourceIO ResourceRef to read. Prefer this for workspace, mount, or remote resources.",
    },
    filePath: {
      type: "string",
      description: "Legacy absolute local path to the document to read.",
    },
    outputFormat: {
      type: "string",
      enum: ["text", "markdown", "html", "json"],
      description: "text by default. pdf returns markdown text; docx also supports html; xlsx also supports json.",
    },
    maxChars: {
      type: "number",
      description: "Maximum characters returned for text/markdown/html output. PDF stops at page boundaries when possible. Default 20000.",
    },
    pageRange: {
      type: "string",
      description: "pdf only. 1-based pages/ranges to read, such as \"1-3,8\". Use nextPageRange from a truncated PDF result to continue.",
    },
    maxPages: {
      type: "number",
      description: "pdf only. Maximum selected pages to inspect in one call. Default 25.",
    },
    sheetLimit: {
      type: "number",
      description: "xlsx only. Maximum sheets to read. Default 8.",
    },
    rowLimit: {
      type: "number",
      description: "xlsx only. Maximum rows per sheet. Default 200.",
    },
    columnLimit: {
      type: "number",
      description: "xlsx only. Maximum columns per sheet. Default 50.",
    },
  },
};

export async function execute(input, ctx: any = {}) {
  try {
    const result = await readOfficeDocument(input, {
      resources: ctx?.resources,
    });
    const text = result.format === "json"
      ? JSON.stringify(result.workbook, null, 2)
      : result.content;
    return {
      content: [{
        type: "text",
        text,
      }],
      details: {
        office: result,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{
        type: "text",
        text: `Office read failed: ${message}`,
      }],
      details: {
        error: {
          code: "OFFICE_READ_FAILED",
          message,
        },
      },
    };
  }
}
