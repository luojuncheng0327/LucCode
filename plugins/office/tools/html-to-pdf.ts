import { renderHtmlToPdf } from "../lib/html-to-pdf.ts";

export { isOfficeEnabledForAgentConfig as isEnabledForAgentConfig } from "../lib/availability.ts";

export const name = "html-to-pdf";

export const description = [
  "Export static HTML to a PDF file using the desktop Chromium print engine.",
  "Use when the user asks to convert HTML to PDF or generate a PDF from HTML/CSS.",
  "Provide exactly one of html or htmlPath. By default this writes a generated PDF into plugin data and returns it as a SessionFile.",
  "Luc's bundled fonts (EB Garamond / Noto Serif SC / JetBrains Mono) are injected during rendering, so pages whose font stacks reference them get the real fonts embedded in the PDF; pages that don't reference them are unaffected.",
  "This tool has file-writing side effects. It fails explicitly when the desktop Chromium helper is unavailable; it does not silently downgrade to a text-only PDF.",
].join(" ");

export const sessionPermission = {
  kind: "review",
  describeSideEffect: (input: any = {}) => ({
    kind: input.outputPath ? "workspace_write" : "plugin_output",
    summary: input.outputPath
      ? `Export HTML to the requested PDF path: ${input.outputPath}`
      : "Export HTML to plugin data and register the PDF as a SessionFile.",
    ruleId: "office-html-to-pdf",
  }),
};

export const parameters = {
  type: "object",
  properties: {
    html: {
      type: "string",
      description: "Inline HTML string. Mutually exclusive with htmlPath.",
    },
    htmlPath: {
      type: "string",
      description: "Absolute path to an HTML file. Mutually exclusive with html.",
    },
    filename: {
      type: "string",
      description: "Suggested PDF filename when outputPath is omitted.",
    },
    outputPath: {
      type: "string",
      description: "Optional absolute PDF output path. Existing files are rejected unless overwrite is true.",
    },
    overwrite: {
      type: "boolean",
      description: "Allow replacing outputPath when it already exists. Default false.",
    },
    pageSize: {
      type: "string",
      description: "PDF page size understood by Electron printToPDF, for example A4 or Letter. Default A4.",
    },
    landscape: {
      type: "boolean",
      description: "Print in landscape orientation. Default false.",
    },
    printBackground: {
      type: "boolean",
      description: "Include CSS backgrounds. Default true.",
    },
    preferCSSPageSize: {
      type: "boolean",
      description: "Honor CSS @page size when present. Default true.",
    },
    margins: {
      type: "object",
      description: "Optional Electron printToPDF margins object.",
    },
    viewportWidth: {
      type: "number",
      description: "Hidden Chromium viewport width before printing. Default 1280.",
    },
    viewportHeight: {
      type: "number",
      description: "Hidden Chromium viewport height before printing. Default 900.",
    },
    allowJavaScript: {
      type: "boolean",
      description: "Allow page JavaScript while rendering. Default false.",
    },
    settleMs: {
      type: "number",
      description: "Extra wait after page load before printing. Default 250ms.",
    },
    timeoutMs: {
      type: "number",
      description: "Maximum helper runtime. Default 60000ms.",
    },
  },
};

export async function execute(input, ctx) {
  try {
    const result = await renderHtmlToPdf(input, ctx);
    return {
      content: [{
        type: "text",
        text: `HTML exported to PDF: ${result.outputPath}`,
      }],
      details: {
        office: {
          kind: "html-to-pdf",
          engine: result.engine,
          outputPath: result.outputPath,
          htmlPath: result.htmlPath,
          size: result.size,
          sessionFile: result.sessionFile,
        },
        ...(result.mediaItem ? { media: { items: [result.mediaItem] } } : {}),
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{
        type: "text",
        text: `Office HTML to PDF failed: ${message}`,
      }],
      details: {
        error: {
          code: "OFFICE_HTML_TO_PDF_FAILED",
          message,
        },
      },
    };
  }
}
