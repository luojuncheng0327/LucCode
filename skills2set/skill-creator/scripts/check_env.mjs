#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import process from "node:process";

const ENV_VAR = "LUC_SKILL_CREATOR_PYTHON";
const MIN_PYTHON_VERSION = [3, 10, 0];
const MIN_PYTHON_VERSION_TEXT = `${MIN_PYTHON_VERSION[0]}.${MIN_PYTHON_VERSION[1]}`;
const CHECK_TIMEOUT_MS = 10_000;

const PACKAGE_SPECS = {
  pyyaml: {
    packageName: "pyyaml",
    moduleName: "yaml",
    purpose: "SKILL.md frontmatter validation",
  },
  anthropic: {
    packageName: "anthropic",
    moduleName: "anthropic",
    purpose: "description optimization loop",
  },
};

const CAPABILITIES = {
  baseline: { packages: [], commands: [] },
  "quick-validate": { packages: ["pyyaml"], commands: [] },
  "package-skill": { packages: ["pyyaml"], commands: [] },
  "aggregate-benchmark": { packages: [], commands: [] },
  "eval-viewer": { packages: [], commands: [] },
  "run-eval": { packages: [], commands: ["claude"] },
  "description-optimize": { packages: ["anthropic"], commands: [] },
  "run-loop": { packages: ["anthropic"], commands: ["claude"] },
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

const IMPORT_SCRIPT = `
import importlib.util
import json
import sys
specs = json.loads(sys.argv[1])
packages = {}
for item in specs:
    package_name = item["packageName"]
    module_name = item["moduleName"]
    packages[package_name] = {
        "packageName": package_name,
        "moduleName": module_name,
        "ok": importlib.util.find_spec(module_name) is not None,
    }
print(json.dumps({"packages": packages}))
`;

function printResult(result) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function parseArgs(argv) {
  const capabilities = [];
  const packages = [];
  const commands = [];
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
    } else if (arg === "--package") {
      const value = argv[index + 1];
      index += 1;
      if (!value || value.startsWith("--")) {
        unknown.push(arg);
      } else {
        packages.push(value);
      }
    } else if (arg.startsWith("--package=")) {
      packages.push(arg.slice("--package=".length));
    } else if (arg === "--command") {
      const value = argv[index + 1];
      index += 1;
      if (!value || value.startsWith("--")) {
        unknown.push(arg);
      } else {
        commands.push(value);
      }
    } else if (arg.startsWith("--command=")) {
      commands.push(arg.slice("--command=".length));
    } else if (arg === "--help" || arg === "-h") {
      return { help: true, capabilities, packages, commands, unknown };
    } else {
      unknown.push(arg);
    }
  }

  return { help: false, capabilities, packages, commands, unknown };
}

function helpResult() {
  return {
    ok: true,
    code: "help",
    message: [
      "Usage: node skills2set/skill-creator/scripts/check_env.mjs [--capability name] [--package package] [--command command]",
      `Requires Python ${MIN_PYTHON_VERSION_TEXT}+ for the bundled skill-creator scripts.`,
      `Capabilities: ${Object.keys(CAPABILITIES).join(", ")}`,
      `Packages: ${Object.keys(PACKAGE_SPECS).join(", ")}`,
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

function runPython(candidate, code, args = []) {
  return spawnSync(candidate.command, [...candidate.args, "-c", code, ...args], {
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
        return { ok: true, python, runner: candidate, attempted };
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
      message: `Skill Creator scripts require Python ${MIN_PYTHON_VERSION_TEXT}+; found ${unsupported.python.version} at ${unsupported.python.command}.`,
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
    message: `Skill Creator scripts require Python ${MIN_PYTHON_VERSION_TEXT}+. Install Python or set ${ENV_VAR} to a Python executable, then retry.`,
  };
}

function collectRequirements(capabilities, packages, commands) {
  const allPackages = new Set(packages);
  const allCommands = new Set(commands);

  for (const capability of capabilities) {
    const requirement = CAPABILITIES[capability];
    for (const packageName of requirement.packages) {
      allPackages.add(packageName);
    }
    for (const commandName of requirement.commands) {
      allCommands.add(commandName);
    }
  }

  return {
    packages: [...allPackages],
    commands: [...allCommands],
  };
}

function packagesToCheck(packages) {
  return packages.map((packageName) => PACKAGE_SPECS[packageName]);
}

function checkPackages(runner, packageSpecs) {
  if (packageSpecs.length === 0) {
    return {};
  }

  const result = runPython(runner, IMPORT_SCRIPT, [JSON.stringify(packageSpecs)]);
  if (result.error || result.status !== 0) {
    const stderr = result.stderr ? result.stderr.trim() : "";
    throw new Error(`Python package check failed: ${result.error?.message || stderr || "unknown error"}`);
  }

  const parsed = parseJsonOutput(result.stdout);
  return parsed?.packages || {};
}

function checkCommands(commands) {
  const status = {};
  const missing = [];

  for (const command of commands) {
    const result = spawnSync(command, ["--version"], {
      encoding: "utf8",
      timeout: CHECK_TIMEOUT_MS,
    });
    const ok = !result.error && result.status === 0;
    status[command] = {
      ok,
      status: result.status,
      error: result.error ? result.error.message : undefined,
      stdout: result.stdout ? result.stdout.trim().slice(0, 200) : undefined,
      stderr: result.stderr ? result.stderr.trim().slice(0, 200) : undefined,
    };
    if (!ok) {
      missing.push(command);
    }
  }

  return { status, missing };
}

function invalidRequirementResult(kind, values) {
  return {
    ok: false,
    code: "unknown_requirement",
    message: `Unknown ${kind}: ${values.join(", ")}`,
    capabilities: Object.keys(CAPABILITIES),
    packages: Object.keys(PACKAGE_SPECS),
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
    return invalidRequirementResult("capability", unknownCapabilities);
  }

  const unknownPackages = args.packages.filter((packageName) => !PACKAGE_SPECS[packageName]);
  if (unknownPackages.length > 0) {
    return invalidRequirementResult("package", unknownPackages);
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

  const requirements = collectRequirements(args.capabilities, args.packages, args.commands);
  const requiredPackages = { all: requirements.packages };
  const requiredCommands = requirements.commands;

  let packageStatus = {};
  try {
    packageStatus = checkPackages(pythonResult.runner, packagesToCheck(requirements.packages));
  } catch (error) {
    return {
      ok: false,
      code: "dependency_check_failed",
      python: pythonResult.python,
      requiredPackages,
      requiredCommands,
      message: error instanceof Error ? error.message : String(error),
    };
  }

  const missingPackages = requirements.packages
    .filter((packageName) => !packageStatus[packageName]?.ok)
    .map((packageName) => PACKAGE_SPECS[packageName]);

  if (missingPackages.length > 0) {
    return {
      ok: false,
      code: "missing_dependency",
      python: pythonResult.python,
      requiredPackages,
      requiredCommands,
      packages: packageStatus,
      missingPackages,
      installGuidance: [
        `Install the missing package(s) into the reported Python environment after user confirmation: ${missingPackages.map((item) => item.packageName).join(", ")}.`,
        "Do not auto-install dependencies from this skill.",
      ],
      message: `Missing Python package(s): ${missingPackages.map((item) => item.packageName).join(", ")}.`,
    };
  }

  const commandStatus = checkCommands(requiredCommands);
  if (commandStatus.missing.length > 0) {
    return {
      ok: false,
      code: "missing_command",
      python: pythonResult.python,
      requiredPackages,
      requiredCommands,
      packages: packageStatus,
      commands: commandStatus.status,
      missingCommands: commandStatus.missing,
      installGuidance: [
        `Install or expose the missing command(s) on PATH before running this capability: ${commandStatus.missing.join(", ")}.`,
      ],
      message: `Missing command(s): ${commandStatus.missing.join(", ")}.`,
    };
  }

  return {
    ok: true,
    code: "ok",
    python: pythonResult.python,
    requiredPackages,
    requiredCommands,
    packages: packageStatus,
    commands: commandStatus.status,
    message: "Skill Creator environment is ready for the requested capability.",
  };
}

const result = main();
printResult(result);
process.exit(result.ok ? 0 : 1);
