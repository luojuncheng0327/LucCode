const path = require("path");

// Electron 的 asar 补丁会让 fs.accessSync 对 .asar 文件本身抛 ENOENT，把归档误判为缺失；original-fs 绕过补丁，按真实文件系统判定。
function resolveRealFs(requireFn = require) {
  try {
    return requireFn("original-fs");
  } catch {
    return requireFn("fs");
  }
}

const fs = resolveRealFs();

function canRead(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function normalizeSlashes(value) {
  return String(value || "").replace(/\\/g, "/");
}

function direntType(entry) {
  if (entry.isDirectory()) return "directory";
  if (entry.isFile()) return "file";
  if (entry.isSymbolicLink()) return "symlink";
  return "other";
}

function inspectDirectoryEntries(dirPath, maxEntries = 40) {
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true })
      .map(entry => ({
        name: entry.name,
        type: direntType(entry),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return {
      entries: entries.slice(0, maxEntries),
      truncated: entries.length > maxEntries,
      entryCount: entries.length,
    };
  } catch (err) {
    return {
      entries: [],
      truncated: false,
      entryCount: null,
      error: {
        code: err?.code || null,
        message: err?.message || String(err),
      },
    };
  }
}

function inspectInstallPath({ filePath, relativePath, listEntries = false, maxEntries = 40 }) {
  const base = {
    relativePath,
    path: normalizeSlashes(filePath),
    exists: false,
    readable: false,
    type: "missing",
  };

  try {
    const stat = fs.statSync(filePath);
    const type = stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other";
    const result = {
      ...base,
      exists: true,
      readable: canRead(filePath),
      type,
      size: stat.isFile() ? stat.size : null,
    };
    if (listEntries && stat.isDirectory()) {
      return {
        ...result,
        ...inspectDirectoryEntries(filePath, maxEntries),
      };
    }
    return result;
  } catch (err) {
    return {
      ...base,
      error: err?.code || null,
    };
  }
}

function buildWindowsInstallSurfaceContext({ execPath, resourcesPath } = {}) {
  const executablePath = execPath || "";
  const appRoot = executablePath ? path.dirname(executablePath) : "";
  const resourcesRoot = resourcesPath || (appRoot ? path.join(appRoot, "resources") : "");
  return {
    appRoot: normalizeSlashes(appRoot),
    resourcesRoot: normalizeSlashes(resourcesRoot),
    appAsar: inspectInstallPath({
      filePath: path.join(resourcesRoot, "app.asar"),
      relativePath: "resources/app.asar",
    }),
    legacyAppDirectory: inspectInstallPath({
      filePath: path.join(resourcesRoot, "app"),
      relativePath: "resources/app",
      listEntries: true,
      maxEntries: 40,
    }),
    resourcesDirectory: inspectInstallPath({
      filePath: resourcesRoot,
      relativePath: "resources",
      listEntries: true,
      maxEntries: 80,
    }),
    seedDirectory: inspectInstallPath({
      filePath: path.join(resourcesRoot, "seed"),
      relativePath: "resources/seed",
      listEntries: true,
      maxEntries: 40,
    }),
  };
}

// 打包布局已从散装 resources/server/ 树改成 resources/seed/ 签名归档
// （server-*.tar.gz + renderer-*.tar.gz + seed-train-<platform>-<arch>.json + .sig），
// 首启时由 artifact-boot 解压到用户数据目录。这里只做"归档四件套是否落地"的浅
// 校验，箱内文件的完整性由解压时的签名与哈希机制负责，不在这一层重复。归档
// 文件名带版本号（server-<version>-<platform>-<arch>.tar.gz），manifest 文件名
// 带平台限定（seed-train-<platform>-<arch>.json，见 build-server-artifact.mjs
// 的 seedManifestFileName / artifact-boot.cjs 的同名函数），因此都用目录扫描
// + 前缀/后缀匹配定位，不硬编码版本号或平台名——这个检查只关心"seed 四件套
// 是否存在"，不关心是不是这台机器自己那份，真正的平台/内容一致性校验在
// artifact-boot.cjs 首启解压时做。
function findSeedFile(seedDir, prefix, suffix) {
  try {
    const entries = fs.readdirSync(seedDir, { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.startsWith(prefix) && entry.name.endsWith(suffix))
      .map(entry => entry.name)
      .sort();
    return entries.length > 0 ? path.join(seedDir, entries[0]) : null;
  } catch {
    return null;
  }
}

function findSeedArchive(seedDir, prefix) {
  return findSeedFile(seedDir, prefix, ".tar.gz");
}

// manifest 文件名以 ".json" 结尾，签名文件以 ".json.sig" 结尾——两者都以
// "seed-train-" 开头，用 endsWith(".json") 天然排除 ".json.sig"（不会误配）。
function findSeedManifest(seedDir) {
  return findSeedFile(seedDir, "seed-train-", ".json");
}

function findSeedManifestSignature(seedDir) {
  return findSeedFile(seedDir, "seed-train-", ".json.sig");
}

function buildWindowsInstallSurfaceChecks({ execPath, resourcesPath } = {}) {
  const executablePath = execPath || "";
  const appRoot = executablePath ? path.dirname(executablePath) : "";
  const resourcesRoot = resourcesPath || (appRoot ? path.join(appRoot, "resources") : "");
  const seedRoot = path.join(resourcesRoot, "seed");
  const seedManifestPath = findSeedManifest(seedRoot);
  const seedSignaturePath = findSeedManifestSignature(seedRoot);
  const seedServerArchivePath = findSeedArchive(seedRoot, "server-");
  const seedRendererArchivePath = findSeedArchive(seedRoot, "renderer-");
  const gitRoot = path.join(resourcesRoot, "git");
  const gitExe = path.join(gitRoot, "cmd", "git.exe");
  const appExecutableLabel = executablePath ? path.basename(executablePath) : "LucCode.exe";
  // MinGit 打包 usr/bin/sh.exe（sh-compatible POSIX shell）；bash.exe 是老 PortableGit
  // 安装面的遗留布局，升级半途的混合状态不应误报为损坏。任一存在即视为 POSIX shell 完整。
  const posixShellCandidates = [
    path.join(gitRoot, "usr", "bin", "sh.exe"),
    path.join(gitRoot, "bin", "bash.exe"),
    path.join(gitRoot, "usr", "bin", "bash.exe"),
  ];

  return [
    {
      id: "app-exe",
      label: appExecutableLabel,
      relativePath: appExecutableLabel,
      paths: [executablePath],
      exists: () => !!executablePath && canRead(executablePath),
    },
    {
      id: "app-asar",
      label: "resources/app.asar",
      relativePath: "resources/app.asar",
      paths: [path.join(resourcesRoot, "app.asar")],
    },
    {
      id: "app-update-yml",
      label: "resources/app-update.yml",
      relativePath: "resources/app-update.yml",
      paths: [path.join(resourcesRoot, "app-update.yml")],
    },
    {
      id: "seed-manifest",
      label: "resources/seed/seed-train-*.json",
      relativePath: "resources/seed/seed-train-*.json",
      // 找不到时展示扫描目录 + 通配模式作为诊断路径，而不是空字符串
      paths: [seedManifestPath || path.join(seedRoot, "seed-train-*.json")],
      exists: () => !!seedManifestPath && canRead(seedManifestPath),
    },
    {
      id: "seed-manifest-signature",
      label: "resources/seed/seed-train-*.json.sig",
      relativePath: "resources/seed/seed-train-*.json.sig",
      paths: [seedSignaturePath || path.join(seedRoot, "seed-train-*.json.sig")],
      exists: () => !!seedSignaturePath && canRead(seedSignaturePath),
    },
    {
      id: "seed-server-archive",
      label: "resources/seed/server-*.tar.gz",
      relativePath: "resources/seed/server-*.tar.gz",
      // 找不到时展示扫描目录 + 通配模式作为诊断路径，而不是空字符串
      paths: [seedServerArchivePath || path.join(seedRoot, "server-*.tar.gz")],
      exists: () => !!seedServerArchivePath && canRead(seedServerArchivePath),
    },
    {
      id: "seed-renderer-archive",
      label: "resources/seed/renderer-*.tar.gz",
      relativePath: "resources/seed/renderer-*.tar.gz",
      paths: [seedRendererArchivePath || path.join(seedRoot, "renderer-*.tar.gz")],
      exists: () => !!seedRendererArchivePath && canRead(seedRendererArchivePath),
    },
    {
      id: "bundled-git",
      label: "Bundled Git runtime (MinGit)",
      relativePath: "resources/git",
      paths: [gitExe, ...posixShellCandidates],
      exists: () => canRead(gitExe) && posixShellCandidates.some(canRead),
    },
  ];
}

function serializeCheck(item) {
  const exists = typeof item.exists === "function"
    ? item.exists()
    : item.paths.some(canRead);
  return {
    id: item.id,
    label: item.label,
    relativePath: item.relativePath,
    paths: item.paths.map(normalizeSlashes),
    exists,
  };
}

function checkWindowsInstallSurface(opts = {}) {
  const checked = buildWindowsInstallSurfaceChecks(opts).map(serializeCheck);
  const missing = checked.filter(item => !item.exists);
  return {
    ok: missing.length === 0,
    checked,
    missing,
    context: buildWindowsInstallSurfaceContext(opts),
  };
}

function writeLaunchDiagnostic({
  diagnosticsDir,
  fileName,
  event,
  payload,
  now = new Date(),
}) {
  if (!diagnosticsDir || !fileName) {
    throw new Error("writeLaunchDiagnostic: diagnosticsDir and fileName are required");
  }
  fs.mkdirSync(diagnosticsDir, { recursive: true });
  const filePath = path.join(diagnosticsDir, fileName);
  fs.writeFileSync(filePath, JSON.stringify({
    event,
    time: now instanceof Date ? now.toISOString() : String(now),
    payload,
  }, null, 2) + "\n", "utf-8");
  return filePath;
}

function appendLaunchLog({ diagnosticsDir, event, payload, now = new Date() }) {
  if (!diagnosticsDir) return null;
  fs.mkdirSync(diagnosticsDir, { recursive: true });
  const filePath = path.join(diagnosticsDir, "launch.log");
  fs.appendFileSync(filePath, JSON.stringify({
    event,
    time: now instanceof Date ? now.toISOString() : String(now),
    payload,
  }) + "\n", "utf-8");
  return filePath;
}

function formatInstallSurfaceError(result, diagnosticPath) {
  const missing = Array.isArray(result?.missing) ? result.missing : [];
  const lines = missing.map(item => `- ${item.relativePath}`);
  const diagnosticLine = diagnosticPath ? `\n\nDiagnostic file:\n${diagnosticPath}` : "";
  return [
    "LucCode installation is incomplete.",
    "",
    "Missing or unreadable files:",
    ...lines,
    diagnosticLine.trimEnd(),
  ].filter(Boolean).join("\n");
}

module.exports = {
  appendLaunchLog,
  buildWindowsInstallSurfaceContext,
  buildWindowsInstallSurfaceChecks,
  checkWindowsInstallSurface,
  formatInstallSurfaceError,
  resolveRealFs,
  writeLaunchDiagnostic,
};
