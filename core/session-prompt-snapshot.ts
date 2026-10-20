import { resolveSessionSkillsForRuntime } from "../lib/skills/session-skill-snapshot.ts";

export const SESSION_PROMPT_SNAPSHOT_VERSION = 1;

function jsonClone(value, fallback) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return fallback;
  }
}

export function normalizeStringArray(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}

export function freezeSkillsResult(value) {
  const next = {
    skills: Array.isArray(value?.skills) ? value.skills : [],
    diagnostics: Array.isArray(value?.diagnostics) ? value.diagnostics : [],
  };
  return jsonClone(next, { skills: [], diagnostics: [] });
}

export function freezeAgentsFilesResult(value) {
  const next = {
    agentsFiles: Array.isArray(value?.agentsFiles) ? value.agentsFiles : [],
  };
  return jsonClone(next, { agentsFiles: [] });
}

export function buildSessionPromptSnapshot({
  systemPrompt = "",
  appendSystemPrompt = [],
  skillsResult = null,
  agentsFilesResult = null,
} = {}) {
  return {
    version: SESSION_PROMPT_SNAPSHOT_VERSION,
    systemPrompt: String(systemPrompt || ""),
    appendSystemPrompt: normalizeStringArray(appendSystemPrompt),
    skillsResult: freezeSkillsResult(skillsResult),
    agentsFilesResult: freezeAgentsFilesResult(agentsFilesResult),
  };
}

export function normalizeSessionPromptSnapshot(value) {
  if (!value || typeof value !== "object") return null;
  if (value.version !== SESSION_PROMPT_SNAPSHOT_VERSION) return null;
  if (typeof value.systemPrompt !== "string") return null;
  return {
    version: SESSION_PROMPT_SNAPSHOT_VERSION,
    systemPrompt: value.systemPrompt,
    appendSystemPrompt: normalizeStringArray(value.appendSystemPrompt),
    skillsResult: freezeSkillsResult(value.skillsResult),
    agentsFilesResult: freezeAgentsFilesResult(value.agentsFilesResult),
    ...(typeof value.finalSystemPrompt === "string"
      ? { finalSystemPrompt: value.finalSystemPrompt }
      : {}),
  };
}

export function createPromptSnapshotResourceLoader(baseResourceLoader, snapshot, extraProps = {}) {
  const normalized = normalizeSessionPromptSnapshot(snapshot)
    || buildSessionPromptSnapshot({ systemPrompt: "" });
  return Object.create(baseResourceLoader || {}, {
    getSystemPrompt: {
      value: () => normalized.systemPrompt,
    },
    getAppendSystemPrompt: {
      value: () => [...normalized.appendSystemPrompt],
    },
    getSkills: {
      value: () => resolveSessionSkillsForRuntime(normalized.skillsResult),
    },
    getAgentsFiles: {
      value: () => freezeAgentsFilesResult(normalized.agentsFilesResult),
    },
    ...extraProps,
  });
}
