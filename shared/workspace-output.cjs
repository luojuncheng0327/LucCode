const path = require("path");

const WORKSPACE_OUTPUT_ROOT_DIRNAME = "OH-Works";

const WINDOWS_RESERVED_CHARS = new Set(["<", ">", ":", "\"", "/", "\\", "|", "?", "*"]);
const WINDOWS_RESERVED_DEVICE_NAMES = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  "com1",
  "com2",
  "com3",
  "com4",
  "com5",
  "com6",
  "com7",
  "com8",
  "com9",
  "lpt1",
  "lpt2",
  "lpt3",
  "lpt4",
  "lpt5",
  "lpt6",
  "lpt7",
  "lpt8",
  "lpt9",
]);

const OUTPUT_DIR_LABELS = Object.freeze({
  screenshots: Object.freeze({
    zh: "截图",
    "zh-TW": "截圖",
    ja: "スクリーンショット",
    ko: "스크린샷",
    en: "Screenshots",
  }),
  diary: Object.freeze({
    zh: "日记",
    "zh-TW": "日記",
    ja: "日記",
    ko: "일기",
    en: "Diary",
  }),
});

const PATROL_DIR_FORMAT = Object.freeze({
  zh: { prefix: "", suffix: "的巡检" },
  "zh-TW": { prefix: "", suffix: "的巡檢" },
  ja: { prefix: "", suffix: "の巡回" },
  ko: { prefix: "", suffix: "의 순찰" },
  en: { prefix: "", suffix: " Patrol" },
});

function localeKey(locale) {
  const value = typeof locale === "string" ? locale : "";
  if (!value) return "zh";
  if (value === "zh-TW" || value === "zh-Hant") return "zh-TW";
  if (value.startsWith("zh")) return "zh";
  if (value.startsWith("ja")) return "ja";
  if (value.startsWith("ko")) return "ko";
  return "en";
}

function isControlCodePoint(codePoint) {
  return (codePoint >= 0x00 && codePoint <= 0x1f) || (codePoint >= 0x80 && codePoint <= 0x9f);
}

function truncateUtf8Bytes(value, maxBytes) {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let result = "";
  let used = 0;
  for (const char of value) {
    const bytes = Buffer.byteLength(char, "utf8");
    if (used + bytes > maxBytes) break;
    result += char;
    used += bytes;
  }
  return result;
}

function sanitizeWorkspaceOutputSegment(value, fallback = "Agent") {
  let cleaned = "";
  if (typeof value === "string") {
    for (const char of value) {
      const codePoint = char.codePointAt(0);
      if (codePoint == null || isControlCodePoint(codePoint)) continue;
      if (WINDOWS_RESERVED_CHARS.has(char)) continue;
      cleaned += char;
    }
  }
  cleaned = cleaned.replace(/\s+/g, " ").trim().replace(/[ .]+$/u, "");
  if (!cleaned || cleaned === "." || cleaned === "..") {
    cleaned = fallback;
  }
  if (WINDOWS_RESERVED_DEVICE_NAMES.has(cleaned.toLowerCase())) {
    cleaned = `agent-${cleaned}`;
  }
  return truncateUtf8Bytes(cleaned, 80) || fallback;
}

function assertWorkspacePath(cwd) {
  if (typeof cwd !== "string" || !cwd.trim()) {
    throw new Error("workspace output path requires a workspace cwd");
  }
}

function labelForKind(kind, locale) {
  const labels = OUTPUT_DIR_LABELS[kind];
  if (!labels) throw new Error(`unknown workspace output kind: ${kind}`);
  const key = localeKey(locale);
  return labels[key] || labels.en;
}

function resolveWorkspaceOutputRoot(cwd) {
  assertWorkspacePath(cwd);
  return path.join(cwd, WORKSPACE_OUTPUT_ROOT_DIRNAME);
}

function resolveWorkspaceOutputDir(cwd, kind, locale) {
  return path.join(resolveWorkspaceOutputRoot(cwd), labelForKind(kind, locale));
}

function patrolDirName(agentSegment, locale) {
  const format = PATROL_DIR_FORMAT[localeKey(locale)] || PATROL_DIR_FORMAT.en;
  return `${format.prefix}${agentSegment}${format.suffix}`;
}

function resolveAgentWorkspaceOutputDirs(cwd, agentName, locale) {
  const agentSegment = sanitizeWorkspaceOutputSegment(agentName, "Agent");
  const root = resolveWorkspaceOutputRoot(cwd);
  return {
    patrolDir: path.join(root, patrolDirName(agentSegment, locale)),
    activityDir: path.join(root, `${agentSegment}-activity`),
    agentSegment,
  };
}

function workspaceOutputRelativePath(...segments) {
  return [WORKSPACE_OUTPUT_ROOT_DIRNAME, ...segments]
    .filter((segment) => typeof segment === "string" && segment.length > 0)
    .join("/");
}

function resolveAgentWorkspaceOutputRelativeDirs(agentName, locale) {
  const agentSegment = sanitizeWorkspaceOutputSegment(agentName, "Agent");
  return {
    patrolDir: workspaceOutputRelativePath(patrolDirName(agentSegment, locale)),
    activityDir: workspaceOutputRelativePath(`${agentSegment}-activity`),
    patrolLog: workspaceOutputRelativePath(patrolDirName(agentSegment, locale), "patrol-log.md"),
    agentSegment,
  };
}

module.exports = {
  WORKSPACE_OUTPUT_ROOT_DIRNAME,
  localeKey,
  resolveAgentWorkspaceOutputDirs,
  resolveAgentWorkspaceOutputRelativeDirs,
  resolveWorkspaceOutputDir,
  resolveWorkspaceOutputRoot,
  sanitizeWorkspaceOutputSegment,
  workspaceOutputRelativePath,
};
