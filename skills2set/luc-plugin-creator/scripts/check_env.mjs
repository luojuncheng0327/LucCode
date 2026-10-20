#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import process from "node:process";

const ENV_VAR = "LUC_PLUGIN_CREATOR_PYTHON";
const MIN_PYTHON_VERSION = [3, 9, 0];
const MIN_PYTHON_VERSION_TEXT = `${MIN_PYTHON_VERSION[0]}.${MIN_PYTHON_VERSION[1]}`;
const CHECK_TIMEOUT_MS = 10_000;
const CAPABILITIES = {
  scaffold: { packages: [] },
};

const VERSION_SCRIPT = `
import json
import sys
version = sys.version_info
print(json.dumps({
    "version": "%d.%d.%d" % (version[0], version[1], version[2]),
    "major": int(version[0]),
    "minor": int(version[1]),
    "micro": int(version[2]),
    "executable": sys.executable,
}))
`;

function printResult(result) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function parseArgs(argv) {
  const capabilities = [];
  const unknown = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--capability") {
      const value = argv[index + 1];
      index += 1;
      if (!value || value.startsWith("--")) {
        unknown.push(arg);
      } else {
        capabilities.push(value);
      }
    } else if (arg.startsWith("--capability=")) {
      capabilities.push(arg.slice("--capability=".length));
    } else if (arg === "--help" || arg === "-h") {
      return { help: true, capabilities, unknown };
    } else {
      unknown.push(arg);
    }
  }

  return { help: false, capabilities, unknown };
}

function helpResult() {
  return {
    ok: true,
    code: "help",
    message: [
      "Usage: node skills2set/luc-plugin-creator/scripts/check_env.mjs --capability scaffold",
      `Requires Python ${MIN_PYTHON_VERSION_TEXT}+ for the bundled plugin scaffold script.`,
      `Capabilities: ${Object.keys(CAPABILITIES).join(", ")}`,
    ].join("\n"),
  };
}

function parsePythonCommand(value) {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.startsWith("[")) {
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid ${ENV_VAR} JSON value: ${reason}`);
    }
    if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every((item) => typeof item === "string")) {
      throw new Error(`${ENV_VAR} JSON value must be a non-empty string array.`);
    }
    return {
      command: parsed[0],
      args: parsed.slice(1),
      label: parsed.join(" "),
      source: ENV_VAR,
    };
  }

  return {
    command: trimmed,
    args: [],
    label: trimmed,
    source: ENV_VAR,
  };
}

function pythonCandidates() {
  const candidates = [];
  if (process.env[ENV_VAR]) {
    candidates.push(parsePythonCommand(process.env[ENV_VAR]));
  }

  if (process.platform === "win32") {
    candidates.push(
      { command: "py", args: ["-3"], label: "py -3", source: "PATH" },
      { command: "python", args: [], label: "python", source: "PATH" },
      { command: "python3", args: [], label: "python3", source: "PATH" },
    );
  } else {
    candidates.push(
      { command: "python3", args: [], label: "python3", source: "PATH" },
      { command: "python", args: [], label: "python", source: "PATH" },
    );
  }

  return candidates.filter(Boolean);
}

function runPython(candidate, code) {
  return spawnSync(candidate.command, [...candidate.args, "-c", code], {
    encoding: "utf8",
    timeout: CHECK_TIMEOUT_MS,
  });
}

function parseJsonOutput(output) {
  const trimmed = String(output || "").trim();
  if (!trimmed) {
    return null;
  }
  return JSON.parse(trimmed);
}

function versionAtLeast(found) {
  const parts = [found.major, found.minor, found.micro];
  for (let index = 0; index < MIN_PYTHON_VERSION.length; index += 1) {
    if (parts[index] > MIN_PYTHON_VERSION[index]) {
      return true;
    }
    if (parts[index] < MIN_PYTHON_VERSION[index]) {
      return false;
    }
  }
  return true;
}

function findPython() {
  const attempted = [];
  let unsupported = null;

  for (const candidate of pythonCandidates()) {
    const result = runPython(candidate, VERSION_SCRIPT);
    const attempt = {
      command: candidate.label,
      source: candidate.source,
      status: result.status,
      error: result.error ? result.error.message : undefined,
      stderr: result.stderr ? result.stderr.trim() : undefined,
    };
    attempted.push(attempt);

    if (result.error || result.status !== 0) {
      continue;
    }

    try {
      const version = parseJsonOutput(result.stdout);
      if (!version) {
        attempt.error = "Python version check returned no JSON.";
        continue;
      }

      const python = {
        ok: true,
        command: candidate.label,
        source: candidate.source,
        executable: version.executable,
        version: version.version,
        major: Number(version.major),
        minor: Number(version.minor),
        micro: Number(version.micro),
        minimumVersion: MIN_PYTHON_VERSION_TEXT,
      };

      if (versionAtLeast(python)) {
        return { ok: true, python, attempted };
      }

      unsupported ??= { ok: false, python, attempted };
    } catch (error) {
      attempt.error = error instanceof Error ? error.message : String(error);
    }
  }

  if (unsupported) {
    return {
      ok: false,
      code: "python_version_unsupported",
      python: { ...unsupported.python, ok: false },
      attempted,
      message: `Luc Plugin Creator scripts require Python ${MIN_PYTHON_VERSION_TEXT}+; found ${unsupported.python.version} at ${unsupported.python.command}.`,
    };
  }

  return {
    ok: false,
    code: "python_not_found",
    python: {
      ok: false,
      minimumVersion: MIN_PYTHON_VERSION_TEXT,
    },
    attempted,
    message: `Luc Plugin Creator scripts require Python ${MIN_PYTHON_VERSION_TEXT}+. Install Python or set ${ENV_VAR} to a Python executable, then retry.`,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    return helpResult();
  }
  if (args.unknown.length > 0) {
    return {
      ok: false,
      code: "invalid_arguments",
      message: `Unknown or incomplete argument(s): ${args.unknown.join(", ")}`,
    };
  }

  const unknownCapabilities = args.capabilities.filter((capability) => !CAPABILITIES[capability]);
  if (unknownCapabilities.length > 0) {
    return {
      ok: false,
      code: "unknown_requirement",
      message: `Unknown capability: ${unknownCapabilities.join(", ")}`,
      capabilities: Object.keys(CAPABILITIES),
    };
  }

  let pythonResult;
  try {
    pythonResult = findPython();
  } catch (error) {
    return {
      ok: false,
      code: "invalid_environment",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  if (!pythonResult.ok) {
    return pythonResult;
  }

  return {
    ok: true,
    code: "ok",
    python: pythonResult.python,
    requiredPackages: { all: [] },
    message: "Luc Plugin Creator environment is ready for scaffolding.",
  };
}

const result = main();
printResult(result);
process.exit(result.ok ? 0 : 1);
