import { Type } from "../pi-sdk/index.ts";
import { getToolSessionPath } from "../tools/tool-session.ts";
import { execCommandDescription, writeStdinDescription } from "./guidance.ts";
import { classifyExecCommand } from "./policy.ts";
import {
  EXEC_COMMAND_SANDBOX_PERMISSIONS,
  jsonResult,
  normalizeExecCommandParams,
  normalizeExecCommandSandboxPermissions,
  normalizeWriteStdinParams,
  textResult,
} from "./schema.ts";
import { runExecCommandDirect, runExecCommandOnce, startExecCommandTty } from "./runner.ts";
import {
  WIN32_DEFAULT_ONE_SHOT_SHELL,
  renderCommandForExecShell,
  renderCommandWithWorkdir,
  resolveExecShell,
} from "./shell.ts";

const JUSTIFICATION_MAX_LENGTH = 300;

function truncateJustification(value: any) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length > JUSTIFICATION_MAX_LENGTH ? trimmed.slice(0, JUSTIFICATION_MAX_LENGTH) : trimmed;
}

export function createExecCommandTools({
  bashTool,
  escalatedBashTool,
  commandExec,
  escalatedCommandExec,
  getTerminalSessionManager,
  getAgentId,
  getCwd,
  isOneShotSandboxEnforced,
  platform = process.platform,
  env = process.env,
  // Called at most once, right here, when this tool-set is built for a
  // session. The result is baked into `description` below as a plain string
  // literal — not re-read later — so the description stays fixed for the
  // rest of this session's lifetime even if the underlying machine state
  // (e.g. pwsh getting installed or removed) changes afterward. See the
  // rationale on detectWin32PowerShellFlavor in
  // ../sandbox/win32-runtime-cache.ts for why that function itself must not
  // cache across separate tool-set builds.
  detectPowerShellFlavor,
}: any = {}) {
  const execCommandTool = {
    name: "exec_command",
    label: "Exec Command",
    description: execCommandDescription({ platform, powershellFlavor: detectPowerShellFlavor?.() ?? null }),
    sessionPermission: {
      sideEffect: { kind: "command", commandParam: "cmd" },
      describeSideEffect: (params: any = {}) => {
        const justification = truncateJustification(params.justification);
        return {
          kind: params.tty ? "interactive_command" : "command",
          command: params.cmd || params.command || "",
          ...(justification ? { justification } : {}),
        };
      },
      resolveInvocation: (params: any = {}) => {
        const command = typeof (params.cmd || params.command) === "string"
          ? (params.cmd || params.command).trim()
          : "";
        if (!command) return null;
        const sandboxPermissions = normalizeExecCommandSandboxPermissions(params.sandbox_permissions);
        if (!sandboxPermissions.ok) return null;
        const tty = params.tty === true;
        const sandboxed = !tty && isOneShotSandboxEnforced?.() === true;
        const requiresEscalated = sandboxPermissions.value
          === EXEC_COMMAND_SANDBOX_PERMISSIONS.REQUIRE_ESCALATED;
        const networkIsolated = sandboxed && platform !== "win32" && !requiresEscalated;
        const containedOneShot = sandboxed && networkIsolated && !requiresEscalated;
        const justification = truncateJustification(params.justification);
        return {
          action: "run",
          kind: containedOneShot ? "routine" : "review",
          capability: "exec_command.run",
          sideEffect: {
            kind: tty ? "interactive_command" : "command",
            command,
            sandboxed,
            sandboxPermissions: sandboxPermissions.value,
            networkAccess: networkIsolated ? "blocked" : "review_required",
            hostIpcAccess: containedOneShot ? "available" : "review_required",
            ...(justification ? { justification } : {}),
          },
        };
      },
    },
    parameters: Type.Object({
      cmd: Type.String({ description: "Command to execute in the session's default shell; see tool description for the platform default." }),
      workdir: Type.Optional(Type.String({ description: "Working directory. Defaults to the current session cwd." })),
      shell: Type.Optional(Type.String({ description: "Optional shell override: auto, powershell, pwsh, cmd, bash." })),
      tty: Type.Optional(Type.Boolean({ description: "Start an interactive PTY-backed process instead of a one-shot command." })),
      sandbox_permissions: Type.Optional(Type.Union([
        Type.Literal(EXEC_COMMAND_SANDBOX_PERMISSIONS.USE_DEFAULT),
        Type.Literal(EXEC_COMMAND_SANDBOX_PERMISSIONS.REQUIRE_ESCALATED),
      ], {
        description: "Use use_default for the normal contained command path. Use require_escalated only when the command needs reviewed network-capable execution.",
      })),
      justification: Type.Optional(Type.String({
        description: "One-sentence approval question shown to the user; required with require_escalated (e.g. \"Run a WMI read query to inspect the GPU driver?\").",
      })),
      yield_time_ms: Type.Optional(Type.Number({ description: "Requested initial wait budget in milliseconds. Recorded for scheduling; not a command timeout." })),
      max_output_tokens: Type.Optional(Type.Number({ description: "Approximate maximum output token budget returned by this call." })),
      timeout: Type.Optional(Type.Number({ description: "Optional one-shot timeout in seconds." })),
    }),
    execute: async (toolCallId: any, params: any = {}, signal: any, onUpdate: any, ctx: any) => {
      const normalized = normalizeExecCommandParams(params, ctx, {
        defaultCwd: getCwd?.() || process.cwd(),
      });
      if (!normalized.ok) return normalized.error;

      const value = normalized.value;
      const classification = classifyExecCommand(value.cmd, { platform });
      if (classification.unsupportedSyntax) {
        return textResult(
          `This command uses POSIX heredoc syntax, but Windows exec_command defaults to ${WIN32_DEFAULT_ONE_SHOT_SHELL.display}. Use ${WIN32_DEFAULT_ONE_SHOT_SHELL.display} syntax, python -c, or write a temporary script file instead.`,
          {
            errorCode: classification.errorCode,
            execCommand: {
              ok: false,
              cmd: value.cmd,
              workdir: value.workdir,
              shell: WIN32_DEFAULT_ONE_SHOT_SHELL.family,
              platform,
              classification,
            },
          },
        );
      }

      const shell = resolveExecShell({ shell: value.shell, platform });
      const defaultCwd = ctx?.sessionManager?.getCwd?.() || getCwd?.() || process.cwd();
      const commandWithWorkdir = renderCommandWithWorkdir(value.cmd, shell, {
        workdir: value.workdir,
        defaultCwd,
        platform,
      });
      const renderedCommand = renderCommandForExecShell(commandWithWorkdir, shell, { platform });
      const execDetails = {
        cmd: value.cmd,
        commandWithWorkdir,
        renderedCommand,
        workdir: value.workdir,
        shell: shell.label,
        shellFamily: shell.family,
        shellRequested: shell.requested,
        tty: value.tty,
        sandboxPermissions: value.sandboxPermissions,
        ...(value.justification ? { justification: value.justification } : {}),
        platform,
        classification,
        yieldTimeMs: value.yieldTimeMs,
        maxOutputTokens: value.maxOutputTokens,
      };

      if (value.tty) {
        return startExecCommandTty({
          manager: getTerminalSessionManager?.(),
          getAgentId,
          getCwd,
          command: renderedCommand,
          workdir: value.workdir,
          label: params.label || value.cmd.slice(0, 64),
          ctx,
          execDetails,
          cols: params.cols,
          rows: params.rows,
        });
      }

      const selectedCommandExec = value.sandboxPermissions
        === EXEC_COMMAND_SANDBOX_PERMISSIONS.REQUIRE_ESCALATED
        ? escalatedCommandExec || commandExec
        : commandExec;
      if (selectedCommandExec) {
        return runExecCommandDirect({
          commandExec: selectedCommandExec,
          command: renderedCommand,
          workdir: value.workdir,
          timeout: value.timeout,
          signal,
          onUpdate,
          execDetails,
          maxOutputTokens: value.maxOutputTokens,
          platform,
        });
      }

      const selectedBashTool = value.sandboxPermissions
        === EXEC_COMMAND_SANDBOX_PERMISSIONS.REQUIRE_ESCALATED
        ? escalatedBashTool || bashTool
        : bashTool;
      if (!selectedBashTool?.execute) {
        return textResult("exec_command runner unavailable", {
          errorCode: "EXEC_COMMAND_RUNNER_UNAVAILABLE",
          execCommand: execDetails,
        });
      }

      return runExecCommandOnce({
        bashTool: selectedBashTool,
        toolCallId,
        command: renderedCommand,
        timeout: value.timeout,
        signal,
        onUpdate,
        ctx,
        execDetails,
        maxOutputTokens: value.maxOutputTokens,
      });
    },
  };

  const writeStdinTool = {
    name: "write_stdin",
    label: "Write Stdin",
    description: writeStdinDescription(),
    sessionPermission: {
      sideEffect: { kind: "terminal_input" },
      describeSideEffect: (params: any = {}) => ({
        kind: "terminal_input",
        processId: params.process_id || params.processId || "",
      }),
      resolveInvocation: (params: any = {}) => {
        const processId = typeof (params.process_id || params.processId) === "string"
          ? (params.process_id || params.processId).trim()
          : "";
        if (!processId) return null;
        const isPoll = typeof params.chars !== "string" || params.chars.length === 0;
        return {
          action: isPoll ? "poll" : "write",
          kind: isPoll ? "read" : "review",
          capability: isPoll ? "write_stdin.poll" : "write_stdin.write",
          target: { type: "terminal_process", id: processId, label: processId },
        };
      },
    },
    parameters: Type.Object({
      process_id: Type.String({ description: "process_id returned by exec_command with tty=true." }),
      chars: Type.Optional(Type.String({ description: "Characters to write to stdin, including newline if needed." })),
    }),
    execute: async (_toolCallId: any, params: any = {}, _signal: any, _onUpdate: any, ctx: any) => {
      const normalized = normalizeWriteStdinParams(params);
      if (!normalized.ok) return normalized.error;
      const sessionPath = getToolSessionPath(ctx);
      if (!sessionPath) {
        return textResult("current session is required to write stdin", {
          errorCode: "WRITE_STDIN_SESSION_REQUIRED",
        });
      }
      const manager = getTerminalSessionManager?.();
      if (!manager) {
        return textResult("terminal manager unavailable", {
          errorCode: "WRITE_STDIN_TERMINAL_MANAGER_UNAVAILABLE",
        });
      }
      const value = normalized.value;
      return jsonResult(manager.write({
        sessionPath,
        terminalId: value.processId,
        chars: value.chars,
      }));
    },
  };

  void env;
  return [execCommandTool, writeStdinTool];
}
