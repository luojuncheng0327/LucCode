import {
  normalizeStageFilesParams,
  STAGE_FILES_EXECUTION_BOUNDARY,
} from "../tools/output-file-tool.ts";

function stagePathsFromRequest(request: any = {}) {
  if (request.toolName !== "stage_files") return [];
  const normalized = normalizeStageFilesParams(request.params);
  return normalized.ok ? normalized.value.filepaths : [];
}

function stageBoundaryBlock(reason?: string) {
  return {
    action: "block",
    code: "ACTION_BLOCKED_BY_WORKSPACE_BOUNDARY",
    reviewer: "safety_policy",
    reason: reason || "Files can only be delivered from the current workspace or an authorized folder.",
    risk: "high",
    ruleIds: ["stage-files-workspace-boundary"],
  };
}

export function prepareStageFilesExecutionParams(request: any = {}, boundary: any = {}) {
  const stagePaths = stagePathsFromRequest(request);
  if (stagePaths.length === 0) return { ok: true, params: request.params } as const;
  if (typeof boundary.checkStagePath !== "function") {
    return { ok: false, error: stageBoundaryBlock("The workspace delivery boundary is unavailable.") } as const;
  }

  const canonicalPaths: string[] = [];
  for (const filePath of stagePaths) {
    const checked = boundary.checkStagePath(filePath);
    const canonicalPath = checked?.canonicalPath;
    if (!checked?.allowed || typeof canonicalPath !== "string" || !canonicalPath) {
      return { ok: false, error: stageBoundaryBlock(checked?.reason) } as const;
    }
    const rechecked = boundary.checkStagePath(canonicalPath);
    if (
      !rechecked?.allowed
      || rechecked.canonicalPath !== canonicalPath
    ) {
      return { ok: false, error: stageBoundaryBlock(rechecked?.reason || "The file target changed during permission validation.") } as const;
    }
    if (!canonicalPaths.includes(canonicalPath)) canonicalPaths.push(canonicalPath);
  }

  const params = { ...(request.params || {}), filepaths: canonicalPaths };
  delete params.filePath;
  Object.defineProperty(params, STAGE_FILES_EXECUTION_BOUNDARY, {
    value: Object.freeze({
      canonicalPaths: Object.freeze([...canonicalPaths]),
      checkStagePath: (filePath: string) => boundary.checkStagePath(filePath),
    }),
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return { ok: true, params } as const;
}

export function evaluateToolSafetyPolicy(request: any = {}, boundary: any = {}) {
  const stagePaths = stagePathsFromRequest(request);
  if (stagePaths.length > 0 && typeof boundary.checkStagePath !== "function") {
    return stageBoundaryBlock("The workspace delivery boundary is unavailable.");
  }
  if (stagePaths.length > 0) {
    for (const filePath of stagePaths) {
      const checked = boundary.checkStagePath(filePath);
      if (!checked?.allowed) {
        return stageBoundaryBlock(checked?.reason);
      }
    }
  }

  return null;
}
