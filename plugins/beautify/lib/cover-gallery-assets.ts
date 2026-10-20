import fs from "node:fs";
import path from "node:path";
import { fromRoot } from "../../../shared/luc-root.ts";
import { getCoverGalleryPreset } from "../../../shared/cover-gallery-presets.ts";

const COVER_GALLERY_ASSET_SEGMENTS = ["desktop", "src", "assets", "cover-gallery"];

function assertInsideDirectory(filePath, baseDir) {
  const resolvedFilePath = path.resolve(filePath);
  const resolvedBaseDir = path.resolve(baseDir);
  if (resolvedFilePath !== resolvedBaseDir && !resolvedFilePath.startsWith(resolvedBaseDir + path.sep)) {
    throw new Error("cover gallery preset resolved outside asset directory");
  }
}

export function resolveCoverGalleryPresetImagePath(presetId, { rootDir }: any = {}) {
  const preset = getCoverGalleryPreset(presetId);
  if (!preset) {
    throw new Error("unknown cover gallery preset");
  }
  const baseDir = rootDir
    ? path.join(rootDir, ...COVER_GALLERY_ASSET_SEGMENTS)
    : fromRoot(...COVER_GALLERY_ASSET_SEGMENTS);
  const imagePath = path.join(baseDir, preset.fileName);
  assertInsideDirectory(imagePath, baseDir);
  if (!fs.existsSync(imagePath)) {
    throw new Error("cover gallery preset image missing");
  }
  return imagePath;
}
