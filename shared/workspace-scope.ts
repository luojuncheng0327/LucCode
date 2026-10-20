import path from "path";

function cleanPath(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return path.resolve(trimmed);
}

export function normalizeWorkspaceScope({ primaryCwd, workspaceFolders }: { primaryCwd?: string; workspaceFolders?: string[] } = {}) {
  const primary = cleanPath(primaryCwd);
  const seen = new Set(primary ? [primary] : []);
  const folders = [];

  for (const raw of Array.isArray(workspaceFolders) ? workspaceFolders : []) {
    const folder = cleanPath(raw);
    if (!folder || seen.has(folder)) continue;
    seen.add(folder);
    folders.push(folder);
  }

  return {
    primaryCwd: primary,
    workspaceFolders: folders,
  };
}

export function workspaceRootsForSandbox(primaryCwd, workspaceFolders, authorizedFolders = []) {
  const scope = normalizeSessionFolderScope({ primaryCwd, workspaceFolders, authorizedFolders });
  return scope.sandboxFolders;
}

export function normalizeSessionFolderScope({ primaryCwd, workspaceFolders, authorizedFolders }: { primaryCwd?: string; workspaceFolders?: string[]; authorizedFolders?: string[] } = {}) {
  const workspaceScope = normalizeWorkspaceScope({ primaryCwd, workspaceFolders });
  const seen = new Set([
    workspaceScope.primaryCwd,
    ...workspaceScope.workspaceFolders,
  ].filter(Boolean));
  const authorized = [];

  for (const raw of Array.isArray(authorizedFolders) ? authorizedFolders : []) {
    const folder = cleanPath(raw);
    if (!folder || seen.has(folder)) continue;
    seen.add(folder);
    authorized.push(folder);
  }

  return {
    ...workspaceScope,
    authorizedFolders: authorized,
    sandboxFolders: [
      workspaceScope.primaryCwd,
      ...workspaceScope.workspaceFolders,
      ...authorized,
    ].filter(Boolean),
  };
}

export function formatWorkspaceScopePrompt({ primaryCwd, workspaceFolders, locale }: { primaryCwd?: string; workspaceFolders?: string[]; locale?: string } = {}) {
  const scope = normalizeWorkspaceScope({ primaryCwd, workspaceFolders });
  if (!scope.primaryCwd && scope.workspaceFolders.length === 0) return "";
  const isZh = String(locale || "").startsWith("zh");

  if (isZh) {
    const lines = [
      "## 工作区范围",
      "",
      scope.primaryCwd
        ? `主工作台：${scope.primaryCwd}`
        : "主工作台：未设置",
      "主工作台是本次会话处理项目文件时的主要工作区。",
    ];
    if (scope.workspaceFolders.length > 0) {
      lines.push("外部工作区文件夹（同属本次会话的项目范围）：");
      for (const folder of scope.workspaceFolders) lines.push(`- ${folder}`);
      lines.push("这些文件夹位于主工作台之外，各自保留独立的工作区边界。");
    }
    return lines.join("\n");
  }

  const lines = [
    "## Workspace Scope",
    "",
    scope.primaryCwd
      ? `Primary workbench: ${scope.primaryCwd}`
      : "Primary workbench: not set",
    "The primary workbench is the main workspace for project files in this session.",
  ];
  if (scope.workspaceFolders.length > 0) {
    lines.push("External workspace folders (also part of this session's project scope):");
    for (const folder of scope.workspaceFolders) lines.push(`- ${folder}`);
    lines.push("These folders are outside the primary workbench and keep their own workspace boundaries.");
  }
  return lines.join("\n");
}
