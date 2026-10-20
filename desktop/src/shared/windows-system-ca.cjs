"use strict";

/**
 * Windows Node TLS trust wiring shared by the Electron main process and the
 * independently spawned server runtime.
 *
 * Electron's normal app mode does not accept arbitrary Node CLI flags, so the
 * already-running main process must extend its default CA set through node:tls.
 * The standalone server is a normal Node process and can use the official
 * NODE_USE_SYSTEM_CA startup switch. Both paths keep Node's bundled roots and
 * NODE_EXTRA_CA_CERTS instead of replacing them with the Windows store.
 */

function mergeCertificateLists(...lists) {
  const merged = [];
  const seen = new Set();
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const certificate of list) {
      if ((typeof certificate !== "string" && !ArrayBuffer.isView(certificate)) || seen.has(certificate)) {
        continue;
      }
      seen.add(certificate);
      merged.push(certificate);
    }
  }
  return merged;
}

function enableWindowsSystemCaForCurrentProcess({
  platform = process.platform,
  tls = require("node:tls"),
} = {}) {
  if (platform !== "win32") {
    return { enabled: false, defaultCount: 0, systemCount: 0, mergedCount: 0 };
  }
  if (typeof tls?.getCACertificates !== "function" || typeof tls?.setDefaultCACertificates !== "function") {
    throw new Error("Windows system CA support requires Node.js tls.getCACertificates/setDefaultCACertificates");
  }

  const defaultCertificates = tls.getCACertificates("default");
  const systemCertificates = tls.getCACertificates("system");
  const mergedCertificates = mergeCertificateLists(defaultCertificates, systemCertificates);
  tls.setDefaultCACertificates(mergedCertificates);
  return {
    enabled: true,
    defaultCount: defaultCertificates.length,
    systemCount: systemCertificates.length,
    mergedCount: mergedCertificates.length,
  };
}

function withWindowsSystemCaEnv(env, { platform = process.platform } = {}) {
  const next = { ...(env || {}) };
  if (platform === "win32") {
    // Luc's Windows TLS contract is authoritative even when an inherited
    // environment explicitly disabled system roots. All unrelated variables,
    // especially NODE_EXTRA_CA_CERTS and NODE_OPTIONS, remain untouched.
    next.NODE_USE_SYSTEM_CA = "1";
  }
  return next;
}

module.exports = {
  enableWindowsSystemCaForCurrentProcess,
  mergeCertificateLists,
  withWindowsSystemCaEnv,
};
