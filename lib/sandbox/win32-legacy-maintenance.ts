// Legacy AppContainer maintenance is intentionally separate from restricted-token execution args.
export function buildWin32LegacyAclDiagnosticArgs({ paths = [], cleanup = false } = {}) {
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new Error("win32 legacy ACL diagnostic requires at least one path");
  }
  const out = [];
  if (cleanup) out.push("--cleanup-legacy-acl");
  for (const p of paths) {
    if (!p) continue;
    out.push("--diagnose-legacy-acl", p);
  }
  if (!out.some((arg) => arg === "--diagnose-legacy-acl")) {
    throw new Error("win32 legacy ACL diagnostic requires at least one path");
  }
  return out;
}

export function buildWin32LucWriteAclCleanupArgs({ paths = [] } = {}) {
  const targets = [...new Set((paths || []).filter(Boolean))];
  if (targets.length === 0) {
    throw new Error("win32 Luc write ACL cleanup requires at least one path");
  }
  const out = [];
  for (const p of targets) {
    out.push("--cleanup-luc-write-acl", p);
  }
  return out;
}

export function buildWin32LegacyProfileCleanupArgs({ profileNames = [] } = {}) {
  const names = [...new Set((profileNames || []).filter(Boolean))];
  if (names.length === 0) {
    throw new Error("win32 legacy profile cleanup requires at least one profile name");
  }
  const out = [];
  for (const name of names) {
    out.push("--cleanup-legacy-profile", name);
  }
  return out;
}
