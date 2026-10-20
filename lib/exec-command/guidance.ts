import { WIN32_DEFAULT_ONE_SHOT_SHELL } from "./shell.ts";

export type Win32PowerShellFlavor = "pwsh" | "windows-powershell" | null;

export function execCommandDescription({
  platform = process.platform,
  powershellFlavor = null,
}: { platform?: NodeJS.Platform; powershellFlavor?: Win32PowerShellFlavor } = {}) {
  const common = [
    "Run a short, one-shot local command in the current session.",
    "When the OS sandbox is enabled, one-shot commands use its network-blocked path by default on macOS/Linux.",
    "If a command that matters for the user's request fails because of sandboxing (network, PowerShell, WMI, registry or system reads), rerun it with sandbox_permissions=\"require_escalated\" and a one-sentence justification phrased as an approval question; the user reviews it before it runs unsandboxed.",
    "In Auto mode, network-blocked one-shot commands run as routine work under the session permission mode; interactive, unsandboxed, and escalated commands remain reviewable. The OS sandbox restricts files and networking but does not isolate every host IPC surface; use Ask mode when each command needs explicit confirmation.",
    "Use tty=true only when the command must remain interactive or long-running; then continue with write_stdin.",
    "For local GUI app control, use the computer tool instead of shell commands.",
  ];
  if (platform === "win32") {
    common.push(
      "Windows cannot isolate command networking; sandbox_permissions=\"use_default\" still uses the restricted-token runner but requires the same permission review.",
      `On Windows the default one-shot shell is ${WIN32_DEFAULT_ONE_SHOT_SHELL.display}. Use ${WIN32_DEFAULT_ONE_SHOT_SHELL.display} syntax for builtins, chaining, pipelines, and redirection.`,
      "Use shell=\"cmd\" only for cmd.exe builtins or batch files.",
      "Use shell=\"bash\" only for explicit POSIX commands; the bundled runtime provides an sh-compatible shell (POSIX sh syntax, not full Bash). Bash-specific features require a system Git Bash install.",
      "Avoid POSIX heredocs on Windows; use python -c, PowerShell here-strings, or a temporary file instead.",
    );
    if (powershellFlavor === "pwsh") {
      common.push("PowerShell 7 (pwsh) is installed and preferred; modern PowerShell syntax is available.");
    } else if (powershellFlavor === "windows-powershell") {
      common.push(
        "Only inbox Windows PowerShell 5.1 is available; avoid PowerShell 7-only syntax such as && and || chains, the ternary operator, and ForEach-Object -Parallel.",
      );
    }
  } else {
    common.push("On macOS/Linux the default shell is the existing POSIX shell runner.");
  }
  return common.join(" ");
}

export function writeStdinDescription() {
  return [
    "Write input to a running exec_command process started with tty=true.",
    "Pass the process_id returned by exec_command and the exact characters to send, including newlines when needed.",
  ].join(" ");
}
