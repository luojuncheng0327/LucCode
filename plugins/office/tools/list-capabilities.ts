export { isOfficeEnabledForAgentConfig as isEnabledForAgentConfig } from "../lib/availability.ts";

export const name = "list-capabilities";

export const description = [
  "List the built-in Office tool capabilities. Use this before Office work when the user asks what formats are supported.",
  "This tool has no side effects.",
].join(" ");

export const sessionPermission = { readOnly: true };

export const parameters = {
  type: "object",
  properties: {},
};

export async function execute() {
  return {
    content: [{
      type: "text",
      text: "Office tools are available: read .docx/.xlsx/.xlsm/.pdf/text-like documents, and export static HTML to PDF with the desktop Chromium print engine. PDF reading supports pageRange continuation for long documents, but OCR for scanned/image-only PDFs is not supported. Editing docx/xlsx/pptx/pdf is intentionally left as future extension surface.",
    }],
    details: {
      capabilities: [
        {
          id: "read-document",
          tool: "office_read-document",
          supportedInputs: [".docx", ".xlsx", ".xlsm", ".pdf", ".txt", ".md", ".csv", ".tsv", ".html"],
          outputs: ["text", "markdown/text for pdf", "html for docx", "json for xlsx"],
          pdf: {
            pageRange: true,
            maxPages: true,
            ocr: false,
            math: "best-effort text extraction; formulas may degrade",
          },
          limitations: [
            "pptx reading is not supported by the built-in Office tool",
            "docx/xlsx/xlsm/pptx/pdf editing is not supported by the built-in Office tool",
            "PDF tables are returned only as best-effort text, not structured table data",
            "scanned/image-only PDF OCR is not supported",
          ],
          sideEffects: false,
        },
        {
          id: "html-to-pdf",
          tool: "office_html-to-pdf",
          supportedInputs: ["inline html", "absolute htmlPath"],
          output: ".pdf SessionFile",
          engine: "Electron Chromium printToPDF",
          sideEffects: true,
        },
      ],
    },
  };
}
