import path from "path";

export const EXEC_COMMAND_DEFAULT_MAX_OUTPUT_TOKENS = 6000;
export const EXEC_COMMAND_SANDBOX_PERMISSIONS = Object.freeze({
  USE_DEFAULT: "use_default",
  REQUIRE_ESCALATED: "require_escalated",
} as const);

export function normalizeExecCommandSandboxPermissions(value: unknown) {
  if (value === undefined || value === EXEC_COMMAND_SANDBOX_PERMISSIONS.USE_DEFAULT) {
    return { ok: true as const, value: EXEC_COMMAND_SANDBOX_PERMISSIONS.USE_DEFAULT };
  }
  if (value === EXEC_COMMAND_SANDBOX_PERMISSIONS.REQUIRE_ESCALATED) {
    return { ok: true as const, value: EXEC_COMMAND_SANDBOX_PERMISSIONS.REQUIRE_ESCALATED };
  }
  return { ok: false as const };
}

export function textResult(text: string, details: Record<string, any> = {}) {
  const isError = (typeof details?.errorCode === "string" && !!details.errorCode)
    || details?.execCommand?.ok === false;
  return {
    ...(isError ? { isError: true as const } : {}),
    content: [{ type: "text", text }],
    details,
  };
}

export function jsonResult(payload: Record<string, any>) {
  return textResult(JSON.stringify(payload, null, 2), payload);
}

function optionalPositiveNumber(value: any, fallback: number) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : fallback;
}

function optionalNonNegativeNumber(value: any, fallback: number) {
  const num = Number(value);
  return Number.isFinite(num) && num >= 0 ? num : fallback;
}

export function normalizeExecCommandParams(params: any = {}, ctx: any = {}, {
  defaultCwd = process.cwd(),
}: { defaultCwd?: string } = {}) {
  const cmd = typeof params.cmd === "string"
    ? params.cmd
    : typeof params.command === "string"
      ? params.command
      : "";
  if (!cmd.trim()) {
    return {
      ok: false,
      error: textResult("exec_command requires a non-empty cmd string", {
        errorCode: "EXEC_COMMAND_INVALID_PARAMS",
      }),
    };
  }

  const sandboxPermissions = normalizeExecCommandSandboxPermissions(params.sandbox_permissions);
  if (!sandboxPermissions.ok) {
    return {
      ok: false,
      error: textResult(
        "exec_command sandbox_permissions must be use_default or require_escalated",
        { errorCode: "EXEC_COMMAND_INVALID_SANDBOX_PERMISSIONS" },
      ),
    };
  }

  const justification = typeof params.justification === "string" ? params.justification.trim() : "";
  if (sandboxPermissions.value === EXEC_COMMAND_SANDBOX_PERMISSIONS.REQUIRE_ESCALATED && !justification) {
    return {
      ok: false,
      error: textResult(
        "sandbox_permissions=\"require_escalated\" requires a one-sentence justification phrased as a question asking the user for approval.",
        { errorCode: "EXEC_COMMAND_JUSTIFICATION_REQUIRED" },
      ),
    };
  }

  const workdir = typeof params.workdir === "string" && params.workdir.trim()
    ? params.workdir.trim()
    : typeof params.cwd === "string" && params.cwd.trim()
      ? params.cwd.trim()
      : ctx?.sessionManager?.getCwd?.() || defaultCwd || process.cwd();
  const maxOutputTokens = optionalPositiveNumber(params.max_output_tokens, EXEC_COMMAND_DEFAULT_MAX_OUTPUT_TOKENS);
  const yieldTimeMs = optionalNonNegativeNumber(params.yield_time_ms, 10000);
  const timeout = Number.isFinite(Number(params.timeout)) && Number(params.timeout) > 0
    ? Math.ceil(Number(params.timeout))
    : undefined;

  return {
    ok: true,
    value: {
      cmd: cmd.trimEnd(),
      workdir: path.resolve(workdir),
      shell: typeof params.shell === "string" ? params.shell.trim() : "",
      tty: params.tty === true,
      sandboxPermissions: sandboxPermissions.value,
      justification,
      maxOutputTokens,
      yieldTimeMs,
      timeout,
    },
  };
}

export function normalizeWriteStdinParams(params: any = {}) {
  const processId = typeof params.process_id === "string" && params.process_id.trim()
    ? params.process_id.trim()
    : typeof params.processId === "string" && params.processId.trim()
      ? params.processId.trim()
      : "";
  if (!processId) {
    return {
      ok: false,
      error: textResult("write_stdin requires process_id", {
        errorCode: "WRITE_STDIN_PROCESS_ID_REQUIRED",
      }),
    };
  }
  return {
    ok: true,
    value: {
      processId,
      chars: typeof params.chars === "string" ? params.chars : "",
    },
  };
}

export function mergeExecDetails(result: any, execDetails: Record<string, any>) {
  return {
    ...(result || {}),
    ...(execDetails?.ok === false ? { isError: true as const } : {}),
    details: {
      ...(result?.details && typeof result.details === "object" ? result.details : {}),
      execCommand: execDetails,
    },
  };
}

export function firstText(result: any) {
  const block = result?.content?.find?.((item: any) => item?.type === "text");
  return typeof block?.text === "string" ? block.text : "";
}

export function extractExitCode(text: string) {
  const match = String(text || "").match(/Command exited with code\s+(-?\d+)/i)
    || String(text || "").match(/\bexit(?:ed)?(?:\s+with)?\s+code[:\s]+(-?\d+)/i);
  return match ? Number(match[1]) : null;
}
