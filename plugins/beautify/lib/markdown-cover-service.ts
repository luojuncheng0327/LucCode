import fs from "node:fs";
import path from "node:path";
import YAML from "js-yaml";
import { atomicWriteSync } from "../../../shared/safe-fs.ts";
import { t } from "../../../lib/i18n.ts";

export const MARKDOWN_ATTACHMENT_DIR_NAME = t("plugin.beautify.attachmentDirName");

const FRONT_MATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const SUPPORTED_IMAGE_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".webp", ".gif",
  ".bmp", ".avif", ".svg", ".tif", ".tiff", ".heic", ".heif",
]);

function assertAbsoluteFilePath(label, filePath) {
  if (typeof filePath !== "string" || !path.isAbsolute(filePath)) {
    throw new Error(`${label} must be an absolute file path`);
  }
}

function splitFrontMatter(markdown) {
  const match = markdown.match(FRONT_MATTER_RE);
  if (!match) return { data: {}, body: markdown };
  const raw = match[1] || "";
  const parsed = raw.trim() ? YAML.load(raw) : {};
  if (parsed !== null && (typeof parsed !== "object" || Array.isArray(parsed))) {
    throw new Error("markdown frontmatter must be an object");
  }
  return { data: parsed || {}, body: markdown.slice(match[0].length) };
}

function safeBaseName(filePath) {
  const parsed = path.parse(filePath);
  return (parsed.name || "document")
    .replace(/[^\p{L}\p{N}_-]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    || "document";
}

function timestampForName(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join("");
}

function uniqueAttachmentPath(markdownFilePath, generatedFilePath, now) {
  const docDir = path.dirname(markdownFilePath);
  const attachmentDir = path.join(docDir, MARKDOWN_ATTACHMENT_DIR_NAME);
  const ext = path.extname(generatedFilePath) || ".png";
  const base = `${safeBaseName(markdownFilePath)}-cover-${timestampForName(now)}`;
  let index = 0;
  while (true) {
    const fileName = index === 0 ? `${base}${ext}` : `${base}-${index + 1}${ext}`;
    const absPath = path.join(attachmentDir, fileName);
    if (!fs.existsSync(absPath)) {
      return {
        attachmentDir,
        absolutePath: absPath,
        relativePath: path.posix.join(MARKDOWN_ATTACHMENT_DIR_NAME, fileName),
      };
    }
    index += 1;
  }
}

function gcd(a, b) {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y) {
    const t = y;
    y = x % y;
    x = t;
  }
  return x || 1;
}

function ratioFromDimensions(width, height) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  const divisor = gcd(Math.round(width), Math.round(height));
  return `${Math.round(width) / divisor}:${Math.round(height) / divisor}`;
}

function readImageDimensionsFromHeader(filePath) {
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(64 * 1024);
    const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
    return parseImageDimensions(buf.subarray(0, bytesRead));
  } finally {
    fs.closeSync(fd);
  }
}

function parseImageDimensions(buf) {
  if (buf.length < 12) return null;

  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    if (buf.length < 24) return null;
    return {
      width: buf.readUInt32BE(16),
      height: buf.readUInt32BE(20),
    };
  }

  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buf.length) {
      if (buf[offset] !== 0xff) break;
      const marker = buf[offset + 1];
      if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
        return {
          height: buf.readUInt16BE(offset + 5),
          width: buf.readUInt16BE(offset + 7),
        };
      }
      const segLen = buf.readUInt16BE(offset + 2);
      if (!Number.isFinite(segLen) || segLen <= 0) break;
      offset += 2 + segLen;
    }
  }

  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
    const type = buf.toString("ascii", 12, 16);
    if (type === "VP8X" && buf.length >= 30) {
      return {
        width: 1 + buf.readUIntLE(24, 3),
        height: 1 + buf.readUIntLE(27, 3),
      };
    }
    if (type === "VP8 " && buf.length >= 30) {
      return {
        width: buf.readUInt16LE(26) & 0x3fff,
        height: buf.readUInt16LE(28) & 0x3fff,
      };
    }
    if (type === "VP8L" && buf.length >= 25) {
      const bits = buf.readUInt32LE(21);
      return {
        width: (bits & 0x3fff) + 1,
        height: ((bits >> 14) & 0x3fff) + 1,
      };
    }
  }

  if (buf.toString("ascii", 0, 6) === "GIF87a" || buf.toString("ascii", 0, 6) === "GIF89a") {
    if (buf.length < 10) return null;
    return {
      width: buf.readUInt16LE(6),
      height: buf.readUInt16LE(8),
    };
  }

  return null;
}

function assertSupportedImageFilePath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (!SUPPORTED_IMAGE_EXTS.has(ext)) {
    throw new Error("generatedFilePath must point to a supported image file");
  }
}

function serializeFrontMatter(data, body) {
  const yaml = YAML.dump(data, {
    lineWidth: 1000,
    noRefs: true,
    sortKeys: false,
  }).trimEnd();
  return `---\n${yaml}\n---\n${body}`;
}

export async function applyMarkdownCoverFromGeneratedFile({
  markdownFilePath,
  generatedFilePath,
  actualRatio,
  pixelWidth,
  pixelHeight,
  now = new Date(),
  resourceIO = null,
  operationContext = {},
}: any = {}) {
  assertAbsoluteFilePath("markdownFilePath", markdownFilePath);
  assertAbsoluteFilePath("generatedFilePath", generatedFilePath);
  assertSupportedImageFilePath(generatedFilePath);

  const io = isResourceIO(resourceIO) ? resourceIO : null;
  const markdownRef = { kind: "local-file", path: markdownFilePath };
  const generatedRef = { kind: "local-file", path: generatedFilePath };
  if (io) {
    const markdownStat = await io.stat(markdownRef);
    if (!markdownStat?.exists || markdownStat?.isDirectory) throw new Error("markdownFilePath must point to a file");
    const generatedStat = await io.stat(generatedRef);
    if (!generatedStat?.exists || generatedStat?.isDirectory) throw new Error("generatedFilePath must point to a file");
  } else {
    const markdownStat = fs.statSync(markdownFilePath);
    if (!markdownStat.isFile()) throw new Error("markdownFilePath must point to a file");
    const generatedStat = fs.statSync(generatedFilePath);
    if (!generatedStat.isFile()) throw new Error("generatedFilePath must point to a file");
  }

  const target = uniqueAttachmentPath(markdownFilePath, generatedFilePath, now);
  if (io) {
    await io.mkdir({ kind: "local-file", path: target.attachmentDir }, { ...operationContext, emit: false });
    await io.copy(generatedRef, { kind: "local-file", path: target.absolutePath }, operationContext);
  } else {
    fs.mkdirSync(target.attachmentDir, { recursive: true });
    fs.copyFileSync(generatedFilePath, target.absolutePath);
  }

  const rawMarkdown = io
    ? bufferToUtf8((await io.read(markdownRef)).content)
    : fs.readFileSync(markdownFilePath, "utf-8");
  const { data, body } = splitFrontMatter(rawMarkdown);
  const detectedDimensions = (
    Number.isFinite(pixelWidth) && Number.isFinite(pixelHeight)
      ? null
      : readImageDimensionsFromHeader(generatedFilePath)
  );
  const resolvedPixelWidth = Number.isFinite(pixelWidth) ? Math.round(pixelWidth) : detectedDimensions?.width;
  const resolvedPixelHeight = Number.isFinite(pixelHeight) ? Math.round(pixelHeight) : detectedDimensions?.height;
  const cover = {
    image: target.relativePath,
    actualRatio: actualRatio || ratioFromDimensions(resolvedPixelWidth, resolvedPixelHeight) || null,
    pixelWidth: Number.isFinite(resolvedPixelWidth) ? resolvedPixelWidth : null,
    pixelHeight: Number.isFinite(resolvedPixelHeight) ? resolvedPixelHeight : null,
    displayWidth: 100,
    displayHeight: 320,
    positionX: 50,
    positionY: 50,
  };

  for (const key of Object.keys(cover)) {
    if (cover[key] === null || cover[key] === undefined || cover[key] === "") {
      delete cover[key];
    }
  }

  const nextMarkdown = serializeFrontMatter({ ...data, cover }, body);
  if (io) {
    await io.write(markdownRef, nextMarkdown, operationContext);
  } else {
    atomicWriteSync(markdownFilePath, nextMarkdown);
  }
  return {
    cover,
    markdownFilePath,
    attachmentPath: target.absolutePath,
  };
}

function isResourceIO(value) {
  return value
    && typeof value.stat === "function"
    && typeof value.read === "function"
    && typeof value.write === "function"
    && typeof value.copy === "function"
    && typeof value.mkdir === "function";
}

function bufferToUtf8(content) {
  return Buffer.isBuffer(content)
    ? content.toString("utf-8")
    : Buffer.from(content || "").toString("utf-8");
}
