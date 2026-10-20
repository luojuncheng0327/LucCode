import fs from "fs";
import path from "path";

function resolveExistingOrNearest(filePath) {
  const abs = path.resolve(filePath);
  try {
    return fs.realpathSync(abs);
  } catch (err) {
    if (err.code !== "ENOENT") return abs;
  }

  const pending = [];
  let current = abs;
  while (true) {
    const parent = path.dirname(current);
    if (parent === current) return abs;
    pending.push(path.basename(current));
    try {
      const realParent = fs.realpathSync(parent);
      pending.reverse();
      return path.join(realParent, ...pending);
    } catch (err) {
      if (err.code !== "ENOENT") return abs;
      current = parent;
    }
  }
}

function isInside(targetPath, rootPath) {
  const rel = path.relative(rootPath, targetPath);
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

export function isManagedAgentConfigPath(filePath, { lucHome }: { lucHome?: string } = {}) {
  if (!filePath || !lucHome) return false;

  const target = resolveExistingOrNearest(filePath);
  const home = resolveExistingOrNearest(lucHome);
  const agentsRoot = path.join(home, "agents");
  if (!isInside(target, agentsRoot)) return false;

  const rel = path.relative(agentsRoot, target);
  const parts = rel.split(path.sep).filter(Boolean);
  return parts.length === 2 && parts[1].toLowerCase() === "config.yaml";
}

export function createManagedConfigWriteGuard({ lucHome }: { lucHome?: string } = {}) {
  return (absolutePath, operation) => {
    if (operation !== "write" && operation !== "delete") return { allowed: true };
    if (!isManagedAgentConfigPath(absolutePath, { lucHome })) return { allowed: true };
    return {
      allowed: false,
      reason: "managed config files must be changed through settings APIs; do not edit agents/*/config.yaml directly",
    };
  };
}
