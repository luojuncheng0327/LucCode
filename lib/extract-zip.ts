/**
 * extract-zip.js — 跨平台 zip 解压
 *
 * 直接使用应用自带的 JS 解压能力，避免桌面/服务端把核心安装链路外包给
 * 系统环境里的 unzip / PowerShell。
 *
 * 安全约束：拒绝任何带 symlink entry 的 zip。extract-zip@2.0.1 创建 symlink
 * 时不校验 link target 的边界，且后续同名 file entry 会沿 symlink 解引用
 * 写穿到任意可写路径（zip-slip via symlink）。本项目的所有合法解压用例
 * （角色卡、插件、技能、desk skill）都不需要 symlink entry。
 */

import extractZipImpl from "extract-zip";

const IFMT = 0o170000;
const IFLNK = 0o120000;

export function isSymlinkEntry(entry) {
  if (!entry || typeof entry.externalFileAttributes !== "number") return false;
  const mode = (entry.externalFileAttributes >> 16) & 0xFFFF;
  return (mode & IFMT) === IFLNK;
}

function rejectSymlinkEntries(entry) {
  if (isSymlinkEntry(entry)) {
    const name = entry?.fileName || "<unnamed>";
    throw new Error(`extract-zip: symlink entry is not allowed (entry: ${name})`);
  }
}

export async function extractZip(zipPath, destDir) {
  await extractZipImpl(zipPath, {
    dir: destDir,
    onEntry: rejectSymlinkEntries,
  });
}
