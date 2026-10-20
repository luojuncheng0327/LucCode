import fs from "fs";
import fsp from "fs/promises";
import path from "path";

export function canonicalFilesystemPathSync(filePath) {
  const resolved = path.resolve(filePath);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    try {
      return fs.realpathSync(resolved);
    } catch {
      return resolved;
    }
  }
}

export function filesystemIdentityKeySync(filePath) {
  const canonical = canonicalFilesystemPathSync(filePath);
  return process.platform === "win32" ? canonical.toLocaleLowerCase("en-US") : canonical;
}

function direntPath(directory, entry) {
  return path.join(directory, entry.name);
}

export function direntTargetKindSync(directory, entry) {
  if (entry?.isDirectory?.()) return "directory";
  if (entry?.isFile?.()) return "file";
  if (!entry?.isSymbolicLink?.() && process.platform !== "win32") return null;

  try {
    const stat = fs.statSync(direntPath(directory, entry));
    if (stat.isDirectory()) return "directory";
    if (stat.isFile()) return "file";
  } catch {
    return null;
  }
  return null;
}

export async function direntTargetKind(directory, entry) {
  if (entry?.isDirectory?.()) return "directory";
  if (entry?.isFile?.()) return "file";
  if (!entry?.isSymbolicLink?.() && process.platform !== "win32") return null;

  try {
    const stat = await fsp.stat(direntPath(directory, entry));
    if (stat.isDirectory()) return "directory";
    if (stat.isFile()) return "file";
  } catch {
    return null;
  }
  return null;
}

export function isDirectoryLikeDirentSync(directory, entry) {
  return direntTargetKindSync(directory, entry) === "directory";
}

export function isFileLikeDirentSync(directory, entry) {
  return direntTargetKindSync(directory, entry) === "file";
}

export function readDirectoryLikeDirentsSync(directory, opts: any = {}) {
  const dedupeRealpath = opts.dedupeRealpath !== false;
  const seen = new Set();
  const out = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!isDirectoryLikeDirentSync(directory, entry)) continue;
    if (dedupeRealpath) {
      const key = filesystemIdentityKeySync(direntPath(directory, entry));
      if (seen.has(key)) continue;
      seen.add(key);
    }
    out.push(entry);
  }
  return out;
}

export function readFileLikePathsSync(directory, opts: any = {}) {
  const extension = typeof opts.extension === "string" ? opts.extension : null;
  const dedupeRealpath = opts.dedupeRealpath !== false;
  const seen = new Set();
  const out = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (extension && !entry.name.endsWith(extension)) continue;
    if (!isFileLikeDirentSync(directory, entry)) continue;
    const filePath = direntPath(directory, entry);
    if (dedupeRealpath) {
      const key = filesystemIdentityKeySync(filePath);
      if (seen.has(key)) continue;
      seen.add(key);
    }
    out.push(filePath);
  }
  return out;
}

export async function readFileLikePaths(directory, opts: any = {}) {
  const extension = typeof opts.extension === "string" ? opts.extension : null;
  const dedupeRealpath = opts.dedupeRealpath !== false;
  const seen = new Set();
  const entries = await fsp.readdir(directory, { withFileTypes: true });
  const out = [];
  for (const entry of entries) {
    if (extension && !entry.name.endsWith(extension)) continue;
    if ((await direntTargetKind(directory, entry)) !== "file") continue;
    const filePath = direntPath(directory, entry);
    if (dedupeRealpath) {
      const key = filesystemIdentityKeySync(filePath);
      if (seen.has(key)) continue;
      seen.add(key);
    }
    out.push(filePath);
  }
  return out;
}
