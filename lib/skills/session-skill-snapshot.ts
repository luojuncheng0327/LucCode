import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import {
  createSkillPointerIdentity,
  sourceIdentityForSkill,
} from "./skill-file-identity.ts";

function jsonClone(value, fallback) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return fallback;
  }
}

function isInsidePath(target, parent) {
  const rel = path.relative(parent, target);
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

function assertChildPath(child, parent, label) {
  if (!isInsidePath(child, parent)) {
    throw new Error(`${label} is outside skill baseDir: ${child}`);
  }
}

function rewriteSkillPaths(skill, filePath, baseDir, sourceIdentity, runtimeIdentity) {
  const sourceInfo = skill?.sourceInfo && typeof skill.sourceInfo === "object"
    ? { ...skill.sourceInfo, path: filePath, baseDir }
    : skill?.sourceInfo;
  return {
    ...skill,
    filePath,
    baseDir,
    sourceIdentity,
    runtimeIdentity,
    ...(sourceInfo ? { sourceInfo } : {}),
    _snapshotSourceFilePath: skill?.filePath || null,
    _snapshotSourceBaseDir: skill?.baseDir || null,
  };
}

function unavailableDiagnostic(skill, filePath) {
  return {
    type: "warning",
    message: `skill "${skill?.name || "unknown"}" source is no longer available`,
    path: filePath || skill?.filePath || null,
  };
}

function isPointerSkill(skill) {
  return skill?.runtimeIdentity?.kind === "skill_pointer";
}

/**
 * Freeze the enabled skill set as per-session pointers. The session owns the
 * list and source identities, while the skill bytes stay with their source.
 * Restoring an old session therefore preserves which skills were visible, but
 * a deleted source resolves to an explicit unavailable diagnostic instead of a
 * stale full-directory copy.
 */
export async function snapshotSkillsForSession(skillsResult, sessionPath) {
  const normalized = {
    skills: Array.isArray(skillsResult?.skills) ? skillsResult.skills : [],
    diagnostics: Array.isArray(skillsResult?.diagnostics) ? skillsResult.diagnostics : [],
  };
  if (!sessionPath || normalized.skills.length === 0) {
    return jsonClone(normalized, { skills: [], diagnostics: [] });
  }

  try {
    const snapshotSkills = [];
    for (let index = 0; index < normalized.skills.length; index++) {
      const skill = normalized.skills[index];
      const sourceBaseDir = skill?.baseDir
        ? path.resolve(skill.baseDir)
        : (skill?.filePath ? path.dirname(path.resolve(skill.filePath)) : null);
      const sourceFilePath = skill?.filePath
        ? path.resolve(skill.filePath)
        : (sourceBaseDir ? path.join(sourceBaseDir, "SKILL.md") : null);

      if (!sourceBaseDir || !sourceFilePath) {
        throw new Error(`skill "${skill?.name || index}" has no filePath/baseDir to snapshot`);
      }
      assertChildPath(sourceFilePath, sourceBaseDir, `skill "${skill?.name || index}" filePath`);

      const stat = await fsp.stat(sourceFilePath);
      if (!stat.isFile()) {
        throw new Error(`skill "${skill?.name || index}" filePath is not a file: ${sourceFilePath}`);
      }

      const sourceIdentity = sourceIdentityForSkill(skill, {
        filePath: sourceFilePath,
        baseDir: sourceBaseDir,
      });
      const runtimeIdentity = createSkillPointerIdentity({
        filePath: sourceFilePath,
        baseDir: sourceBaseDir,
      });

      snapshotSkills.push(rewriteSkillPaths(
        skill,
        sourceFilePath,
        sourceBaseDir,
        sourceIdentity,
        runtimeIdentity,
      ));
    }

    return {
      skills: jsonClone(snapshotSkills, []),
      diagnostics: jsonClone(normalized.diagnostics, []),
    };
  } catch (err) {
    throw new Error(`session skill snapshot failed: ${err?.message || err}`);
  }
}

export function resolveSessionSkillsForRuntime(skillsResult) {
  const normalized = {
    skills: Array.isArray(skillsResult?.skills) ? skillsResult.skills : [],
    diagnostics: Array.isArray(skillsResult?.diagnostics) ? skillsResult.diagnostics : [],
  };
  const skills = [];
  const diagnostics = [...normalized.diagnostics];

  for (const skill of normalized.skills) {
    if (!isPointerSkill(skill)) {
      skills.push(skill);
      continue;
    }

    const filePath = skill.runtimeIdentity?.filePath || skill.filePath || null;
    const baseDir = skill.runtimeIdentity?.baseDir || skill.baseDir || (filePath ? path.dirname(filePath) : null);
    if (!filePath || !baseDir || !isInsidePath(path.resolve(filePath), path.resolve(baseDir))) {
      diagnostics.push(unavailableDiagnostic(skill, filePath));
      continue;
    }

    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) {
        diagnostics.push(unavailableDiagnostic(skill, filePath));
        continue;
      }
      skills.push(skill);
    } catch {
      diagnostics.push(unavailableDiagnostic(skill, filePath));
    }
  }

  return jsonClone({ skills, diagnostics }, { skills: [], diagnostics: [] });
}
