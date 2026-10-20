import fs from "fs/promises";

const DEFAULT_MAX_PAGES = 25;
const MAX_PAGE_LIMIT = 500;
const PDF_MATH_HINT_RE = /(?:[=^_<>]|[+\-*/]|\\(?:frac|sqrt|sum|int|lim|alpha|beta|gamma|theta)|\b(?:sin|cos|tan|log|ln|lim|sqrt)\b)/i;

type PdfReadInput = {
  maxChars?: unknown;
  maxPages?: unknown;
  pageRange?: unknown;
};

function asPositiveInt(value, fallback, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

function parsePageRange(value, totalPages) {
  if (typeof value !== "string" || !value.trim()) {
    return Array.from({ length: totalPages }, (_, index) => index + 1);
  }

  const pages = new Set<number>();
  for (const rawPart of value.split(",")) {
    const part = rawPart.trim();
    if (!part) continue;

    const match = part.match(/^(\d+)(?:-(\d+))?$/);
    if (!match) {
      throw new Error(`invalid PDF pageRange "${value}"; use 1-based pages like "1-3,8"`);
    }

    const start = Number(match[1]);
    const end = Number(match[2] ?? match[1]);
    if (start < 1 || end < 1 || start > end || start > totalPages || end > totalPages) {
      throw new Error(`PDF pageRange "${value}" is outside 1-${totalPages}`);
    }

    for (let page = start; page <= end; page += 1) {
      pages.add(page);
    }
  }

  if (!pages.size) {
    throw new Error(`invalid PDF pageRange "${value}"; no pages selected`);
  }

  return [...pages].sort((a, b) => a - b);
}

function limitPages(pages, maxPages) {
  return pages.slice(0, maxPages);
}

function toNextPageRange(selectedPages, nextPageIndex) {
  const rest = selectedPages.slice(nextPageIndex);
  if (!rest.length) return undefined;

  const ranges = [];
  let start = rest[0];
  let previous = rest[0];
  for (const page of rest.slice(1)) {
    if (page === previous + 1) {
      previous = page;
      continue;
    }
    ranges.push(start === previous ? String(start) : `${start}-${previous}`);
    start = page;
    previous = page;
  }
  ranges.push(start === previous ? String(start) : `${start}-${previous}`);
  return ranges.join(",");
}

function normalizeTextItems(items) {
  const lines = [];
  let currentLine = "";

  for (const item of items) {
    if (typeof item?.str !== "string") continue;

    const text = item.str.replace(/\s+/g, " ").trim();
    if (text) {
      currentLine = currentLine ? `${currentLine} ${text}` : text;
    }

    if (item.hasEOL) {
      if (currentLine) {
        lines.push(currentLine);
      }
      currentLine = "";
    }
  }

  if (currentLine) {
    lines.push(currentLine);
  }

  return lines.join("\n").trim();
}

async function getPageText(pdf, pageNumber) {
  const page = await pdf.getPage(pageNumber);
  const content = await page.getTextContent();
  return normalizeTextItems(content.items ?? []);
}

function maybeTruncateFirstBlock(block, maxChars) {
  if (block.length <= maxChars) return { block, truncatedWithinPage: false };
  const suffix = "\n[PDF page text truncated within the first selected page.]";
  return {
    block: block.slice(0, Math.max(0, maxChars - suffix.length)) + suffix,
    truncatedWithinPage: true,
  };
}

export async function readPdfDocument(filePath: string, input: PdfReadInput = {}) {
  const buffer = await fs.readFile(filePath);
  const data = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const { getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(data);

  try {
    const totalPages = pdf.numPages;
    const maxPages = asPositiveInt(input.maxPages, DEFAULT_MAX_PAGES, MAX_PAGE_LIMIT);
    const requestedPages = parsePageRange(input.pageRange, totalPages);
    const selectedPages = limitPages(requestedPages, maxPages);
    const maxChars = asPositiveInt(input.maxChars, 20000, 200000);
    const blocks = [];
    const emittedPages = [];
    let totalChars = 0;
    let truncated = false;
    let nextRequestedIndex = selectedPages.length;
    let sawAnyText = false;
    let sawMathLikeText = false;

    for (let index = 0; index < selectedPages.length; index += 1) {
      const pageNumber = selectedPages[index];
      const pageText = await getPageText(pdf, pageNumber);
      if (!pageText) continue;

      sawAnyText = true;
      sawMathLikeText ||= PDF_MATH_HINT_RE.test(pageText);

      const rawBlock = `## Page ${pageNumber}\n\n${pageText}`;
      const separatorChars = blocks.length ? 2 : 0;
      if (blocks.length && totalChars + separatorChars + rawBlock.length > maxChars) {
        truncated = true;
        nextRequestedIndex = index;
        break;
      }

      let block = rawBlock;
      if (!blocks.length && rawBlock.length > maxChars) {
        const truncatedFirst = maybeTruncateFirstBlock(rawBlock, maxChars);
        block = truncatedFirst.block;
        truncated = truncatedFirst.truncatedWithinPage;
        nextRequestedIndex = index + 1;
      }

      blocks.push(block);
      emittedPages.push(pageNumber);
      totalChars += separatorChars + block.length;

      if (truncated) break;
    }

    if (!sawAnyText) {
      throw new Error("PDF has no extractable text; it may be scanned or image-only. OCR is not supported by the Office JS reader.");
    }

    if (!truncated && requestedPages.length > selectedPages.length) {
      truncated = true;
      nextRequestedIndex = selectedPages.length;
    }

    const nextPageRange = truncated ? toNextPageRange(requestedPages, nextRequestedIndex) : undefined;
    const contentParts = [...blocks];
    if (truncated && nextPageRange && emittedPages.length) {
      contentParts.push(`[PDF read truncated at page ${emittedPages.at(-1)}; continue with pageRange="${nextPageRange}".]`);
    }

    return {
      kind: "pdf",
      format: "markdown",
      content: contentParts.join("\n\n"),
      totalPages,
      pages: emittedPages,
      requestedPages: selectedPages,
      totalRequestedPages: requestedPages.length,
      truncated,
      nextPageRange,
      warnings: sawMathLikeText ? ["math_may_be_degraded"] : [],
    };
  } finally {
    await pdf.destroy?.();
  }
}
