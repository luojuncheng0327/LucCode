"use strict";

function parseVersion(version) {
  if (typeof version !== "string") return null;
  // Keep the existing optional tag prefix and surrounding whitespace support.
  const match = /^v?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(version.trim());
  if (!match) return null;
  const core = match.slice(1, 4).map(Number);
  if (!core.every(Number.isSafeInteger)) return null;
  const prerelease = match[4] ? match[4].split(".") : [];
  if (prerelease.some((part) => /^0[0-9]+$/.test(part))) return null;
  return { core, prerelease };
}

/**
 * SemVer precedence: -1 when a < b, 0 when equal, 1 when a > b.
 * Build metadata does not affect precedence. Numeric prerelease identifiers
 * are compared without Number conversion, so long identifiers stay exact.
 * Returns null for malformed versions instead of accepting a valid prefix.
 */
function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return null;
  for (let i = 0; i < 3; i += 1) {
    if (left.core[i] !== right.core[i]) return left.core[i] > right.core[i] ? 1 : -1;
  }
  if (!left.prerelease.length || !right.prerelease.length) {
    if (left.prerelease.length === right.prerelease.length) return 0;
    return left.prerelease.length ? -1 : 1;
  }
  for (let i = 0; i < Math.min(left.prerelease.length, right.prerelease.length); i += 1) {
    const aPart = left.prerelease[i];
    const bPart = right.prerelease[i];
    if (aPart === bPart) continue;
    const aNumeric = /^[0-9]+$/.test(aPart);
    const bNumeric = /^[0-9]+$/.test(bPart);
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    if (aNumeric && aPart.length !== bPart.length) return aPart.length > bPart.length ? 1 : -1;
    return aPart > bPart ? 1 : -1;
  }
  if (left.prerelease.length === right.prerelease.length) return 0;
  return left.prerelease.length > right.prerelease.length ? 1 : -1;
}

module.exports = { parseVersion, compareVersions };
