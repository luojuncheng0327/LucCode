const path = require("path");

function normalizeFileWatchPath(filePath) {
  const resolved = path.resolve(filePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

module.exports = {
  normalizeFileWatchPath,
};
