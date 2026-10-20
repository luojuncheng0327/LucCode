import fs from "fs";
import path from "path";

export interface WorkspaceSkillPolicy {
  discoverProjectSkills: boolean;
  discoverCompatibleProjectSkills: boolean;
}

export const DEFAULT_WORKSPACE_SKILL_POLICY: Readonly<WorkspaceSkillPolicy> = Object.freeze({
  discoverProjectSkills: true,
  discoverCompatibleProjectSkills: false,
});

export const WORKSPACE_SKILL_DIRS = [
  { sub: ".agents/skills", label: "Agents", category: "standard" },
  { sub: ".claude/skills", label: "Claude Code", category: "compatible" },
  { sub: ".codex/skills", label: "Codex", category: "compatible" },
  { sub: ".openclaw/skills", label: "OpenClaw", category: "compatible" },
];

export function workspaceSkillPolicyFromConfig(workspaceContext) {
  return {
    discoverProjectSkills: workspaceContext?.discover_project_skills !== false,
    discoverCompatibleProjectSkills: workspaceContext?.discover_compatible_project_skills === true,
  };
}

export function normalizeWorkspaceSkillPolicy(policy): WorkspaceSkillPolicy {
  if (!policy || typeof policy !== "object") return { ...DEFAULT_WORKSPACE_SKILL_POLICY };
  return {
    discoverProjectSkills: policy.discoverProjectSkills !== false,
    discoverCompatibleProjectSkills: policy.discoverCompatibleProjectSkills === true,
  };
}

function workspaceSkillPathEntry(workspaceDir, definition) {
  return {
    dirPath: path.join(workspaceDir, definition.sub),
    label: definition.label,
    scope: "workspace",
    category: definition.category,
    sub: definition.sub,
  };
}

/** All supported project roots, independent of whether they are loaded. */
export function resolveWorkspaceSkillCatalogPaths(workspaceDir, { existingOnly = true } = {}) {
  if (!workspaceDir) return [];
  const entries = WORKSPACE_SKILL_DIRS.map((definition) => workspaceSkillPathEntry(workspaceDir, definition));
  return existingOnly ? entries.filter(({ dirPath }) => fs.existsSync(dirPath)) : entries;
}

/** Roots that are active for one Agent's project-skill policy. */
export function resolveWorkspaceSkillPaths(workspaceDir, policy: WorkspaceSkillPolicy = DEFAULT_WORKSPACE_SKILL_POLICY) {
  const normalized = normalizeWorkspaceSkillPolicy(policy);
  return resolveWorkspaceSkillCatalogPaths(workspaceDir).filter((entry) => (
    workspaceSkillCategoryEnabled(entry.category, normalized)
  ));
}

export function workspaceSkillCategoryEnabled(category, policy: WorkspaceSkillPolicy = DEFAULT_WORKSPACE_SKILL_POLICY) {
  const normalized = normalizeWorkspaceSkillPolicy(policy);
  return category === "compatible"
    ? normalized.discoverCompatibleProjectSkills
    : normalized.discoverProjectSkills;
}

/**
 * Resolve ordered project candidates with the same winner/shadow contract used
 * by runtime injection and Desk catalog presentation.
 */
export function resolveWorkspaceSkillCandidateStates(candidates, policy, { claimedByName = new Map() } = {}) {
  return (candidates || []).map((candidate) => {
    if (!workspaceSkillCategoryEnabled(candidate.sourceCategory, policy)) {
      return {
        ...candidate,
        active: false,
        shadowed: false,
        shadowedBy: null,
        inactiveReason: "policy-disabled",
      };
    }
    const prior = claimedByName.get(candidate.name) || null;
    if (prior) {
      return {
        ...candidate,
        active: false,
        shadowed: true,
        shadowedBy: prior,
        inactiveReason: "shadowed",
      };
    }
    const identity = candidate.resolutionIdentity || candidate.sourceIdentity || {
      skillName: candidate.name,
      filePath: candidate.filePath || null,
    };
    claimedByName.set(candidate.name, identity);
    return {
      ...candidate,
      active: true,
      shadowed: false,
      shadowedBy: null,
      inactiveReason: null,
    };
  });
}
