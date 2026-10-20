import fs from "fs";
import path from "path";
import { loadAnydoc, type AnydocApi } from "./anydoc-loader.ts";
import type { ExtractResult } from "./types.ts";

export type { AnydocApi } from "./anydoc-loader.ts";
export type { ExtractFailure, ExtractFailureReason, ExtractResult, ExtractSuccess } from "./types.ts";

/** 单个文档的输入上限。超过这个体量的文件转成 Markdown 已经没法喂进模型上下文了。 */
export const MAX_INPUT_BYTES = 50 * 1024 * 1024;

/** 报错时告诉调用方哪些文档类型走得通，避免对方靠猜。 */
const SUPPORTED_FORMAT_HINT = "docx, pdf, xlsx, pptx, odt, ods, odp, rtf, epub, csv, html";

// 扫描版 PDF 只有图片没有文字层，转换会直接失败。上游没有给出稳定的错误码，只能按错误文案
// 归类，好让调用方知道"这份文件需要 OCR"而不是"文件坏了"。
const SCANNED_PDF_MESSAGE = /scan|image[- ]only|ocr|unsupported/i;

export interface ExtractInput {
  buffer?: Buffer;
  filePath?: string;
  filename?: string;
}

export interface ExtractDeps {
  loadApi?: () => Promise<AnydocApi>;
}

function tooLarge(size: number): ExtractResult {
  return {
    ok: false,
    reason: "too-large",
    message: `document is ${size} bytes, above the ${MAX_INPUT_BYTES} byte extraction limit`,
  };
}

/** 扩展名统一去掉前导点、转小写后再交给上游查表。 */
function formatFromName(api: AnydocApi, name: string | null): string | null {
  if (!name) return null;
  const ext = path.extname(name).replace(/^\./, "").toLowerCase();
  if (!ext) return null;
  return api.formatFromExtension(ext) || null;
}

/**
 * 把一份文档转成 Markdown 文本。
 *
 * 只认字节，不碰 engine / session，任何调用方喂 buffer 或本地路径都能用；
 * 授权校验属于调用方的责任，这里不做路径判断。
 *
 * 读盘失败（文件不存在、没权限）会原样抛出，不会伪装成解析失败——那是调用方传错了路径，
 * 不是文档本身的问题。文档层面的问题一律用 ExtractResult 表达。
 */
export async function extractDocument(input: ExtractInput, deps: ExtractDeps = {}): Promise<ExtractResult> {
  const { buffer, filePath, filename } = input ?? {};
  if (!buffer && !filePath) throw new Error("extractDocument requires buffer or filePath");

  let bytes: Buffer;
  if (buffer) {
    if (buffer.length > MAX_INPUT_BYTES) return tooLarge(buffer.length);
    bytes = buffer;
  } else {
    // 先 stat 再读：超大文件不该被整个装进内存才发现装不下。
    const stat = await fs.promises.stat(filePath!);
    if (stat.size > MAX_INPUT_BYTES) return tooLarge(stat.size);
    bytes = await fs.promises.readFile(filePath!);
  }

  const api = await (deps.loadApi ? deps.loadApi() : loadAnydoc());
  const format = api.formatFromBytes(bytes) || formatFromName(api, filename ?? filePath ?? null);
  if (!format) {
    return {
      ok: false,
      reason: "unsupported",
      message: `could not identify the document format from its bytes or filename; supported formats include ${SUPPORTED_FORMAT_HINT}`,
    };
  }

  try {
    const markdown = await api.toMarkdownBytes(bytes, format);
    const text = typeof markdown === "string" ? markdown : "";
    const warnings = text.trim() ? [] : ["document parsed successfully but contained no text"];
    return { ok: true, markdown: text, format, warnings };
  } catch (err) {
    const message = (err as any)?.message || String(err);
    if (format === "pdf" && SCANNED_PDF_MESSAGE.test(message)) {
      return { ok: false, reason: "scanned-pdf", message };
    }
    return { ok: false, reason: "parse-failed", message };
  }
}
