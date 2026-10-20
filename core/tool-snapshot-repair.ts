import { CORE_TOOL_NAMES, uniqueToolNames } from "../shared/tool-categories.ts";

const LEGACY_TOOL_ALIASES: Record<string, string[]> = {
  bash: ["exec_command"],
  terminal: ["exec_command", "write_stdin"],
};

function availableMcpNamesByLowercase(availableNames) {
  const names = new Map<string, string[]>();
  for (const name of availableNames) {
    if (!name.startsWith("mcp_")) continue;
    const key = name.toLowerCase();
    const matches = names.get(key) || [];
    matches.push(name);
    names.set(key, matches);
  }
  return names;
}

function mappedToolNames(name, availableMcpNames) {
  const legacy = LEGACY_TOOL_ALIASES[name];
  if (legacy) return legacy;

  // MCP tool ids became lowercase while the server's own display/wire names
  // stayed untouched. Frozen sessions may therefore carry the earlier cased
  // model-facing name. Reuse the live published names as the authority instead
  // of reimplementing MCP normalization here, and only migrate a unique match.
  if (name.startsWith("mcp_")) {
    const matches = availableMcpNames.get(name.toLowerCase()) || [];
    if (matches.length === 1) return matches;
  }
  return [name];
}

/**
 * Repairs the runtime-active subset while preserving a normalized copy of the
 * frozen contract. A missing handler may be a transient plugin outage, so
 * restore must not turn current availability into persisted history.
 */
export function repairRestoredToolSnapshotDetailed(snapshotToolNames, allToolNames, {
  coreToolNames = CORE_TOOL_NAMES,
} = {}) {
  const available = new Set(uniqueToolNames(allToolNames));
  const availableMcpNames = availableMcpNamesByLowercase(available);
  const toolNames = [];
  const contractToolNames = [];
  const droppedToolNames = [];
  const seen = new Set();
  const seenContract = new Set();
  const seenSnapshotNames = new Set();

  for (const name of uniqueToolNames(snapshotToolNames)) {
    if (seenSnapshotNames.has(name)) continue;
    seenSnapshotNames.add(name);
    const mappedNames = mappedToolNames(name, availableMcpNames);
    const kept = mappedNames.filter((mapped) => available.has(mapped));
    if (!kept.length) {
      droppedToolNames.push(name);
    }
    for (const mapped of mappedNames) {
      if (!seenContract.has(mapped)) {
        seenContract.add(mapped);
        contractToolNames.push(mapped);
      }
      if (!available.has(mapped)) continue;
      if (seen.has(mapped)) continue;
      seen.add(mapped);
      toolNames.push(mapped);
    }
  }

  for (const name of coreToolNames) {
    if (!available.has(name) || seen.has(name)) continue;
    seen.add(name);
    toolNames.push(name);
    if (!seenContract.has(name)) {
      seenContract.add(name);
      contractToolNames.push(name);
    }
  }

  return { toolNames, contractToolNames, droppedToolNames };
}

export function repairRestoredToolSnapshot(snapshotToolNames, allToolNames, options = {}) {
  return repairRestoredToolSnapshotDetailed(snapshotToolNames, allToolNames, options).toolNames;
}

export function sameToolNames(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) return false;
  if (left.length !== right.length) return false;
  return left.every((name, index) => name === right[index]);
}
