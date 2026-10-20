const fs = require("fs");
const path = require("path");

const MAX_STRING_LENGTH = 4096;
const MAX_ARRAY_LENGTH = 20;
const MAX_OBJECT_KEYS = 40;

function createDesktopLaunchDiagnostics({
  lucHome,
  startupId,
  appVersion = "unknown",
  platform = process.platform,
  arch = process.arch,
  redactText = (value) => String(value),
  now = () => new Date().toISOString(),
} = {}) {
  if (!lucHome) throw new Error("lucHome required");
  const dir = path.join(lucHome, "diagnostics", "desktop-launch");
  const rendererLogPath = path.join(dir, "renderer.log");

  const base = {
    startupId: startupId || "unknown",
    appVersion,
    platform,
    arch,
  };

  function writeLine(event, details = {}) {
    const entry = {
      ts: now(),
      event,
      ...base,
      details: sanitizeValue(details, redactText),
    };
    const text = `${JSON.stringify(entry)}\n`;
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(rendererLogPath, text, "utf-8");
  }

  return {
    dir,
    rendererLogPath,
    reset(details = {}) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(rendererLogPath, "", "utf-8");
      writeLine("desktop-launch-start", details);
    },
    append(event, details = {}) {
      try {
        writeLine(event, details);
      } catch {
        // Launch diagnostics must never become a startup dependency.
      }
    },
  };
}

function sanitizeValue(value, redactText, depth = 0) {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactText(value).slice(0, MAX_STRING_LENGTH);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return String(value);
  if (value instanceof Error) {
    return {
      name: value.name,
      message: sanitizeValue(value.message, redactText, depth + 1),
      code: value.code,
    };
  }
  if (depth >= 4) return "[max-depth]";
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_LENGTH).map(item => sanitizeValue(item, redactText, depth + 1));
  }
  if (typeof value === "object") {
    const output = {};
    for (const [key, item] of Object.entries(value).slice(0, MAX_OBJECT_KEYS)) {
      output[key] = sanitizeValue(item, redactText, depth + 1);
    }
    return output;
  }
  return String(value);
}

module.exports = {
  createDesktopLaunchDiagnostics,
};
