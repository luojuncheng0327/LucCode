import fs from "fs";
import path from "path";
import { saveImage } from "../media/download.ts";

export function normalizeBaseUrl(baseUrl, fallback) {
  return (baseUrl || fallback).replace(/\/+$/, "");
}

export function localImageToDataUrl(filePath) {
  const buf = fs.readFileSync(filePath);
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const mime = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
  }[ext] || "image/png";
  return `data:${mime};base64,${buf.toString("base64")}`;
}

export function normalizeImageInput(image) {
  if (!image) return [];
  const images = Array.isArray(image) ? image : [image];
  return images.map((item) => {
    if (typeof item === "string" && path.isAbsolute(item) && fs.existsSync(item)) {
      return localImageToDataUrl(item);
    }
    return item;
  }).filter(Boolean);
}

export async function saveBase64Images(images, mimeType, dataDir, filename = null) {
  const files = [];
  for (let i = 0; i < images.length; i++) {
    const customName = filename
      ? (images.length > 1 ? `${filename}-${i + 1}` : filename)
      : null;
    const { filename: saved } = await saveImage(Buffer.from(images[i], "base64"), mimeType, dataDir, customName);
    files.push(saved);
  }
  return files;
}

export async function downloadImageUrls(urls, dataDir, filename = null) {
  const files = [];
  for (let i = 0; i < urls.length; i++) {
    const res = await fetch(urls[i]);
    if (!res.ok) throw new Error(`download image failed ${res.status}`);
    const mimeType = res.headers?.get?.("content-type") || "image/png";
    const buffer = Buffer.from(await res.arrayBuffer());
    const customName = filename
      ? (urls.length > 1 ? `${filename}-${i + 1}` : filename)
      : null;
    const { filename: saved } = await saveImage(buffer, mimeType, dataDir, customName);
    files.push(saved);
  }
  return files;
}

export function createLocalTaskId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}
