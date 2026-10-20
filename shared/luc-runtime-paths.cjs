const os = require("os");
const path = require("path");

function expandHome(input, homeDir = os.homedir()) {
  if (!input) return input;
  if (input === "~") return homeDir;
  if (input.startsWith("~/") || input.startsWith("~" + path.sep)) {
    return path.join(homeDir, input.slice(2));
  }
  return input;
}

function resolveLucHome(input, homeDir = os.homedir()) {
  const raw = input || path.join(homeDir, ".luccode");
  return path.resolve(expandHome(raw, homeDir));
}

function assertLucHome(lucHome, caller) {
  if (!lucHome || typeof lucHome !== "string") {
    throw new Error(`${caller}: lucHome is required`);
  }
}

function resolveLucPiSdkRuntimeRoot(lucHome) {
  assertLucHome(lucHome, "resolveLucPiSdkRuntimeRoot");
  return path.join(lucHome, "runtime", "pi-sdk");
}

function resolveLucPiSdkManagedBinDir(lucHome) {
  return path.join(resolveLucPiSdkRuntimeRoot(lucHome), "bin");
}

function resolveLucPiSdkResourceLoaderCwd(lucHome) {
  return path.join(resolveLucPiSdkRuntimeRoot(lucHome), "resource-loader", "project");
}

function resolveLucPiSdkResourceLoaderAgentDir(lucHome) {
  return path.join(resolveLucPiSdkRuntimeRoot(lucHome), "resource-loader", "agent");
}

function resolveLegacyPiSdkManagedBinDir(lucHome) {
  assertLucHome(lucHome, "resolveLegacyPiSdkManagedBinDir");
  return path.join(lucHome, ".pi", "agent", "bin");
}

module.exports = {
  resolveLucHome,
  resolveLucPiSdkManagedBinDir,
  resolveLucPiSdkResourceLoaderAgentDir,
  resolveLucPiSdkResourceLoaderCwd,
  resolveLucPiSdkRuntimeRoot,
  resolveLegacyPiSdkManagedBinDir,
};
