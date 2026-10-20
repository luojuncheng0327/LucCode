; installer.nsh - NSIS custom hooks for LucCode installer
;
; Owns the Windows overlay boundary for LucCode installs. The installer may
; replace LucCode-owned program files, while user/runtime state stays outside
; $INSTDIR.

; Disable CRC integrity check. electron-builder's post-compilation PE editing
; (signtool + rcedit) corrupts the NSIS CRC when no signing cert is configured,
; causing "Installer integrity check has failed" on Windows.
CRCCheck off

!include LogicLib.nsh

!macro lucInstallTimingMark _PHASE _EVENT
  Push $0
  Push $1
  InitPluginsDir
  System::Call 'kernel32::GetTickCount() i.r0'
  FileOpen $1 "$PLUGINSDIR\luccode-install-timing.log" a
  ${IfNot} ${Errors}
    FileWrite $1 "tickMs=$0 phase=${_PHASE} event=${_EVENT}$\r$\n"
    FileClose $1
  ${EndIf}
  ClearErrors
  Pop $1
  Pop $0
!macroend

!macro lucPersistInstallTiming
  IfFileExists "$PLUGINSDIR\luccode-install-timing.log" 0 +2
    CopyFiles /SILENT "$PLUGINSDIR\luccode-install-timing.log" "$INSTDIR\luccode-install-timing.log"
!macroend

!macro lucFindProcess _NAME _RETURN
  nsExec::ExecToLog `"$SYSDIR\cmd.exe" /D /C tasklist /FI "IMAGENAME eq ${_NAME}" /FO CSV | "$SYSDIR\find.exe" "${_NAME}"`
  Pop ${_RETURN}
!macroend

!macro lucFindRunningProcesses _RETURN
  !insertmacro lucFindProcess LucCode.exe ${_RETURN}
  ${If} ${_RETURN} != 0
    !insertmacro lucFindProcess Luc.exe ${_RETURN}
  ${EndIf}
  ${If} ${_RETURN} != 0
    !insertmacro lucFindProcess luc-server.exe ${_RETURN}
  ${EndIf}
!macroend

!macro lucKillProcess _NAME _FORCE
  Push $0
  Push $1
  ${If} ${_FORCE} == 1
    StrCpy $0 "/F"
  ${Else}
    StrCpy $0 ""
  ${EndIf}
  nsExec::ExecToLog `"$SYSDIR\cmd.exe" /D /C taskkill $0 /T /IM "${_NAME}"`
  Pop $1
  Pop $1
  Pop $0
!macroend

!macro lucKillRunningProcesses _FORCE
  !insertmacro lucKillProcess LucCode.exe ${_FORCE}
  !insertmacro lucKillProcess Luc.exe ${_FORCE}
  !insertmacro lucKillProcess luc-server.exe ${_FORCE}
!macroend

!macro lucRequireInstallSurfaceFile _PATH _LABEL
  IfFileExists "${_PATH}" +2 0
    StrCpy $R2 "$R2$\r$\n- ${_LABEL}: ${_PATH}"
!macroend

; 归档文件名带版本号（如 server-<version>-<platform>-<arch>.tar.gz），无法用固定路径
; 校验，用 FindFirst/FindClose 做通配存在性检查；找不到时把目录+通配模式一起写进
; 诊断信息，跟 lucRequireInstallSurfaceFile 走同一条报错/弹窗流程。
!macro lucRequireInstallSurfaceGlob _DIR _PATTERN _LABEL
  Push $R3
  Push $R4
  ClearErrors
  FindFirst $R3 $R4 "${_DIR}\${_PATTERN}"
  ${If} $R4 == ""
    StrCpy $R2 "$R2$\r$\n- ${_LABEL}: ${_DIR}\${_PATTERN}"
  ${EndIf}
  ; FindFirst 可能在没匹配到文件时仍分配 handle（NSIS 已知边界情况），
  ; 无条件尝试关闭，避免泄漏；handle 为空时 FindClose 是安全的空操作。
  ${If} $R3 != ""
    FindClose $R3
  ${EndIf}
  ClearErrors
  Pop $R4
  Pop $R3
!macroend

!macro lucVerifyInstallSurface
  !insertmacro lucInstallTimingMark "installSurfaceSelfCheck" "start"
  Push $0
  Push $R2
  StrCpy $R2 ""
  !insertmacro lucRequireInstallSurfaceFile "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "LucCode.exe"
  !insertmacro lucRequireInstallSurfaceFile "$INSTDIR\resources\app.asar" "resources\app.asar"
  !insertmacro lucRequireInstallSurfaceFile "$INSTDIR\resources\app-update.yml" "resources\app-update.yml"
  ; manifest 文件名带平台限定（seed-train-<platform>-<arch>.json，见
  ; scripts/build-server-artifact.mjs 的 seedManifestFileName），跟归档文件名
  ; 一样无法用固定路径校验，走同一条通配存在性检查。
  !insertmacro lucRequireInstallSurfaceGlob "$INSTDIR\resources\seed" "seed-train-*.json" "resources\seed\seed-train-*.json"
  !insertmacro lucRequireInstallSurfaceGlob "$INSTDIR\resources\seed" "seed-train-*.json.sig" "resources\seed\seed-train-*.json.sig"
  !insertmacro lucRequireInstallSurfaceGlob "$INSTDIR\resources\seed" "server-*.tar.gz" "resources\seed\server-*.tar.gz"
  !insertmacro lucRequireInstallSurfaceGlob "$INSTDIR\resources\seed" "renderer-*.tar.gz" "resources\seed\renderer-*.tar.gz"
  !insertmacro lucRequireInstallSurfaceFile "$INSTDIR\resources\git\cmd\git.exe" "MinGit git.exe"
  !insertmacro lucRequireInstallSurfaceFile "$INSTDIR\resources\git\usr\bin\sh.exe" "MinGit sh.exe"

  ${If} $R2 != ""
    DetailPrint "LucCode install surface self-check failed."
    FileOpen $0 "$INSTDIR\luccode-install-diagnostics.log" w
    FileWrite $0 "LucCode install surface self-check failed.$\r$\n"
    FileWrite $0 "Install dir: $INSTDIR$\r$\n"
    FileWrite $0 "Missing or unreadable files:$R2$\r$\n"
    FileClose $0
    MessageBox MB_OK|MB_ICONSTOP "LucCode installation is incomplete. Missing or unreadable files:$R2$\r$\n$\r$\nDiagnostic file:$\r$\n$INSTDIR\luccode-install-diagnostics.log"
    SetErrorLevel 1
    !insertmacro lucInstallTimingMark "installSurfaceSelfCheck" "failed"
    !insertmacro lucPersistInstallTiming
    Pop $R2
    Pop $0
    Quit
  ${Else}
    Delete "$INSTDIR\luccode-install-diagnostics.log"
    Delete "$INSTDIR\luc-install-diagnostics.log"
    DetailPrint "LucCode install surface self-check passed."
  ${EndIf}
  Pop $R2
  Pop $0
  !insertmacro lucInstallTimingMark "installSurfaceSelfCheck" "end"
!macroend

; 根治 electron/electron#51761：安装目录 DACL 含 orphaned AppContainer SID 时
; Chromium GPU 沙箱崩溃（0x80000003）。补 S-1-15-2-2（ALL RESTRICTED APPLICATION
; PACKAGES）的继承 ACE 后沙箱无需降级；该 ACE 同时满足网络沙箱的要求。grant 幂等，
; 每次安装/更新重发一次即可覆盖上层目录继承来的污染。失败不阻断安装：应用启动侧
; 还有同一 grant 的运行时自愈兜底。
!macro lucGrantSandboxAce
  !insertmacro lucInstallTimingMark "grantSandboxAce" "start"
  Push $0
  DetailPrint "Granting the restricted-app-packages sandbox ACE on the install directory"
  nsExec::ExecToLog `"$SYSDIR\icacls.exe" "$INSTDIR" /grant *S-1-15-2-2:(OI)(CI)(RX)`
  Pop $0
  ${If} $0 != 0
    DetailPrint "Sandbox ACE grant failed (code $0); the app applies the same grant at startup."
  ${EndIf}
  Pop $0
  !insertmacro lucInstallTimingMark "grantSandboxAce" "end"
!macroend

!macro lucWriteInstallDirProcessCleaner _SCRIPT
  Push $0
  FileOpen $0 "${_SCRIPT}" w
  FileWrite $0 `$$ErrorActionPreference = 'SilentlyContinue'$\r$\n`
  FileWrite $0 `$$installDir = [Environment]::GetEnvironmentVariable('LUC_INSTALL_DIR')$\r$\n`
  FileWrite $0 `if ([string]::IsNullOrWhiteSpace($$installDir)) { exit 0 }$\r$\n`
  FileWrite $0 `$$installFull = [System.IO.Path]::GetFullPath($$installDir).TrimEnd('\')$\r$\n`
  FileWrite $0 `$$installPrefix = $$installFull + '\'$\r$\n`
  FileWrite $0 `$$selfPid = $$PID$\r$\n`
  FileWrite $0 `$$self = Get-CimInstance Win32_Process -Filter "ProcessId = $$selfPid"$\r$\n`
  FileWrite $0 `$$installerPid = if ($$self) { $$self.ParentProcessId } else { -1 }$\r$\n`
  FileWrite $0 `function Test-LucPath([string]$$value) {$\r$\n`
  FileWrite $0 `  if ([string]::IsNullOrWhiteSpace($$value)) { return $$false }$\r$\n`
  FileWrite $0 `  try {$\r$\n`
  FileWrite $0 `    $$full = [System.IO.Path]::GetFullPath($$value)$\r$\n`
  FileWrite $0 `    return $$full.Equals($$installFull, [StringComparison]::OrdinalIgnoreCase) -or $$full.StartsWith($$installPrefix, [StringComparison]::OrdinalIgnoreCase)$\r$\n`
  FileWrite $0 `  } catch { return $$false }$\r$\n`
  FileWrite $0 `}$\r$\n`
  FileWrite $0 `function Test-LucCommand([string]$$value) {$\r$\n`
  FileWrite $0 `  if ([string]::IsNullOrWhiteSpace($$value)) { return $$false }$\r$\n`
  FileWrite $0 `  $$quotedPrefix = '"' + $$installPrefix$\r$\n`
  FileWrite $0 `  return $$value.StartsWith($$installPrefix, [StringComparison]::OrdinalIgnoreCase) -or $$value.IndexOf($$quotedPrefix, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or $$value.IndexOf(' ' + $$installPrefix, [StringComparison]::OrdinalIgnoreCase) -ge 0$\r$\n`
  FileWrite $0 `}$\r$\n`
  FileWrite $0 `Get-CimInstance Win32_Process | Where-Object {$\r$\n`
  FileWrite $0 `  $$_.ProcessId -ne $$selfPid -and $$_.ProcessId -ne $$installerPid -and ((Test-LucPath $$_.ExecutablePath) -or (Test-LucCommand $$_.CommandLine))$\r$\n`
  FileWrite $0 `} | ForEach-Object {$\r$\n`
  FileWrite $0 `  Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue$\r$\n`
  FileWrite $0 `}$\r$\n`
  FileClose $0
  Pop $0
!macroend

!macro lucWriteInstallDirProcessFinder _SCRIPT
  Push $0
  FileOpen $0 "${_SCRIPT}" w
  FileWrite $0 `$$ErrorActionPreference = 'SilentlyContinue'$\r$\n`
  FileWrite $0 `$$installDir = [Environment]::GetEnvironmentVariable('LUC_INSTALL_DIR')$\r$\n`
  FileWrite $0 `if ([string]::IsNullOrWhiteSpace($$installDir)) { exit 3 }$\r$\n`
  FileWrite $0 `$$installFull = [System.IO.Path]::GetFullPath($$installDir).TrimEnd('\')$\r$\n`
  FileWrite $0 `$$installPrefix = $$installFull + '\'$\r$\n`
  FileWrite $0 `$$selfPid = $$PID$\r$\n`
  FileWrite $0 `$$self = Get-CimInstance Win32_Process -Filter "ProcessId = $$selfPid"$\r$\n`
  FileWrite $0 `$$installerPid = if ($$self) { $$self.ParentProcessId } else { -1 }$\r$\n`
  FileWrite $0 `function Test-LucPath([string]$$value) {$\r$\n`
  FileWrite $0 `  if ([string]::IsNullOrWhiteSpace($$value)) { return $$false }$\r$\n`
  FileWrite $0 `  try {$\r$\n`
  FileWrite $0 `    $$full = [System.IO.Path]::GetFullPath($$value)$\r$\n`
  FileWrite $0 `    return $$full.Equals($$installFull, [StringComparison]::OrdinalIgnoreCase) -or $$full.StartsWith($$installPrefix, [StringComparison]::OrdinalIgnoreCase)$\r$\n`
  FileWrite $0 `  } catch { return $$false }$\r$\n`
  FileWrite $0 `}$\r$\n`
  FileWrite $0 `function Test-LucCommand([string]$$value) {$\r$\n`
  FileWrite $0 `  if ([string]::IsNullOrWhiteSpace($$value)) { return $$false }$\r$\n`
  FileWrite $0 `  $$quotedPrefix = '"' + $$installPrefix$\r$\n`
  FileWrite $0 `  return $$value.StartsWith($$installPrefix, [StringComparison]::OrdinalIgnoreCase) -or $$value.IndexOf($$quotedPrefix, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or $$value.IndexOf(' ' + $$installPrefix, [StringComparison]::OrdinalIgnoreCase) -ge 0$\r$\n`
  FileWrite $0 `}$\r$\n`
  FileWrite $0 `$$all = $$null$\r$\n`
  FileWrite $0 `try { $$all = @(Get-CimInstance Win32_Process -ErrorAction Stop) } catch { exit 2 }$\r$\n`
  FileWrite $0 `if ($$all.Count -eq 0) { exit 2 }$\r$\n`
  FileWrite $0 `$$matches = @($$all | Where-Object {$\r$\n`
  FileWrite $0 `  $$_.ProcessId -ne $$selfPid -and $$_.ProcessId -ne $$installerPid -and ((Test-LucPath $$_.ExecutablePath) -or (Test-LucCommand $$_.CommandLine))$\r$\n`
  FileWrite $0 `})$\r$\n`
  FileWrite $0 `$$matches | ForEach-Object {$\r$\n`
  FileWrite $0 `  Write-Output ("LucCode-owned process still running: {0} pid={1} path={2}" -f $$_.Name, $$_.ProcessId, $$_.ExecutablePath)$\r$\n`
  FileWrite $0 `}$\r$\n`
  FileWrite $0 `if ($$matches.Count -gt 0) { exit 0 } else { exit 10 }$\r$\n`
  FileClose $0
  Pop $0
!macroend

!macro lucStopInstallDirProcesses
  ; Stop every process launched from this install root. This catches renamed
  ; helper processes and stale child processes that do not use fixed image names.
  !insertmacro lucInstallTimingMark "stopInstallDirProcesses" "start"
  Push $0
  Push $1
  InitPluginsDir
  StrCpy $1 "$PLUGINSDIR\luc-stop-install-dir.ps1"
  !insertmacro lucWriteInstallDirProcessCleaner "$1"
  System::Call 'kernel32::SetEnvironmentVariable(t "LUC_INSTALL_DIR", t "$INSTDIR") i.r0'
  nsExec::ExecToLog `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$1"`
  Pop $0
  Pop $1
  Pop $0
  !insertmacro lucInstallTimingMark "stopInstallDirProcesses" "end"
!macroend

!macro lucFindInstallDirProcesses _RETURN
  !insertmacro lucInstallTimingMark "findInstallDirProcesses" "start"
  Push $0
  Push $1
  InitPluginsDir
  StrCpy $1 "$PLUGINSDIR\luc-find-install-dir.ps1"
  !insertmacro lucWriteInstallDirProcessFinder "$1"
  System::Call 'kernel32::SetEnvironmentVariable(t "LUC_INSTALL_DIR", t "$INSTDIR") i.r0'
  nsExec::ExecToLog `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$1"`
  Pop ${_RETURN}
  Pop $1
  Pop $0
  !insertmacro lucInstallTimingMark "findInstallDirProcesses" "end"
!macroend

!macro lucBypassOldUninstallerForUpdate
  ${If} ${isUpdated}
    DetailPrint "Update mode detected; bypassing the previous uninstaller and preparing a LucCode-owned overlay."
    !insertmacro lucPrepareOwnedOverlay
    DeleteRegKey SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}"
    !ifdef UNINSTALL_REGISTRY_KEY_2
      DeleteRegKey SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY_2}"
    !endif
    ClearErrors
  ${EndIf}
!macroend

!macro customInstallMode
  ${If} ${isUpdated}
    ${If} $installMode == "all"
      StrCpy $isForceMachineInstall "1"
    ${Else}
      StrCpy $isForceCurrentInstall "1"
    ${EndIf}
  ${EndIf}
!macroend

!macro customInstall
  !insertmacro lucInstallTimingMark "customInstall" "start"
  !insertmacro lucGrantSandboxAce
  !insertmacro lucVerifyInstallSurface
  !insertmacro lucInstallTimingMark "customInstall" "end"
  !insertmacro lucPersistInstallTiming
  ${If} ${isUpdated}
  ${AndIf} ${isForceRun}
    !insertmacro lucInstallTimingMark "relaunch" "start"
    !insertmacro lucPersistInstallTiming
    HideWindow
    StrCpy $1 "--updated"
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
  ${EndIf}
!macroend

!macro customFinishPage
  !ifndef HIDE_RUN_AFTER_FINISH
    Function StartApp
      ${if} ${isUpdated}
        StrCpy $1 "--updated"
      ${else}
        StrCpy $1 ""
      ${endif}
      ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
    FunctionEnd

    !define MUI_FINISHPAGE_RUN
    !define MUI_FINISHPAGE_RUN_FUNCTION "StartApp"
  !endif

  !insertmacro skipPageIfUpdated
  !insertmacro MUI_PAGE_FINISH
!macroend

!macro customCheckAppRunning
  !insertmacro lucInstallTimingMark "customCheckAppRunning" "start"
  !insertmacro lucBypassOldUninstallerForUpdate
  !insertmacro lucStopInstallDirProcesses
  ; Finder exit contract: 0 = found LucCode-owned processes, 10 = confirmed
  ; none, anything else = query unavailable (PowerShell blocked / WMI broken).
  ; $R9 = 1 when the query is unavailable and we must fall back to the
  ; cmd-based image-name sweep below.
  StrCpy $R9 0
  !insertmacro lucFindInstallDirProcesses $R0
  ${If} $R0 == 0
    DetailPrint "Detected LucCode-owned process in install directory; closing it before install."
    Sleep 500
    !insertmacro lucStopInstallDirProcesses

    StrCpy $R1 0
    luc_check_install_dir_processes:
      !insertmacro lucFindInstallDirProcesses $R0
      ${If} $R0 == 0
        IntOp $R1 $R1 + 1
        DetailPrint "Waiting for LucCode-owned install-directory processes to close."
        ${If} $R1 > 2
          DetailPrint "LucCode-owned install-directory processes still running; asking user to retry."
          MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY luc_retry_install_dir_close
          Quit
          luc_retry_install_dir_close:
          StrCpy $R1 0
        ${EndIf}
        !insertmacro lucStopInstallDirProcesses
        Sleep 1000
        Goto luc_check_install_dir_processes
      ${ElseIf} $R0 != 10
        DetailPrint "LucCode process query became unavailable (code $R0); switching to image-name cleanup."
        StrCpy $R9 1
      ${EndIf}
  ${ElseIf} $R0 != 10
    DetailPrint "LucCode process query unavailable (code $R0); falling back to image-name cleanup."
    StrCpy $R9 1
  ${EndIf}

  ; Image-name sweep runs for fresh installs (legacy behavior), and for
  ; updates whenever the precise install-dir query is unavailable.
  StrCpy $R8 0
  ${If} $R9 == 1
    StrCpy $R8 1
  ${EndIf}
  ${IfNot} ${isUpdated}
    StrCpy $R8 1
  ${EndIf}

  ${If} $R8 == 1
  !insertmacro lucFindRunningProcesses $R0
  ${If} $R0 == 0
    DetailPrint "Detected LucCode.exe, Luc.exe, or luc-server.exe; closing them before install."
    !insertmacro lucKillRunningProcesses 0
    Sleep 500

    !insertmacro lucFindRunningProcesses $R0
    ${If} $R0 == 0
      !insertmacro lucKillRunningProcesses 1
      Sleep 1000
    ${EndIf}

    StrCpy $R1 0
    luc_check_processes:
      !insertmacro lucFindRunningProcesses $R0
      ${If} $R0 == 0
        IntOp $R1 $R1 + 1
        DetailPrint "Waiting for LucCode.exe, Luc.exe, or luc-server.exe to close."
        ${If} $R1 > 2
          DetailPrint "LucCode.exe, Luc.exe, or luc-server.exe still running; asking user to retry."
          MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY luc_retry_close
          Quit
          luc_retry_close:
          StrCpy $R1 0
        ${EndIf}
        !insertmacro lucKillRunningProcesses 1
        Sleep 1000
        Goto luc_check_processes
      ${EndIf}
  ${EndIf}
  ${EndIf}
  !insertmacro lucInstallTimingMark "customCheckAppRunning" "end"
!macroend

!macro lucCleanBundledServer
  ; 打包布局已改成 resources\seed 归档 + 首启解压，散装的 resources\server 树
  ; 只会出现在老版本升级覆盖的场景。这里保留清理逻辑，避免覆盖安装时新旧
  ; 文件混杂；实际生效的同名清理见下方 lucRemoveOwnedInstallTrees。
  IfFileExists "$INSTDIR\resources\server\*.*" 0 +3
    DetailPrint "Removing old bundled server resources"
    RMDir /r "$INSTDIR\resources\server"
!macroend

!macro lucWriteLegacyShortcutCleaner _SCRIPT
  Push $0
  FileOpen $0 "${_SCRIPT}" w
  FileWrite $0 `$$ErrorActionPreference = 'SilentlyContinue'$\r$\n`
  FileWrite $0 `$$installDir = [Environment]::GetEnvironmentVariable('LUC_INSTALL_DIR')$\r$\n`
  FileWrite $0 `if ([string]::IsNullOrWhiteSpace($$installDir)) { exit 0 }$\r$\n`
  FileWrite $0 `$$installFull = [System.IO.Path]::GetFullPath($$installDir).TrimEnd('\')$\r$\n`
  FileWrite $0 `$$installPrefix = $$installFull + '\'$\r$\n`
  FileWrite $0 `$$shell = New-Object -ComObject WScript.Shell$\r$\n`
  FileWrite $0 `function Test-LucInstallPath([string]$$value) {$\r$\n`
  FileWrite $0 `  if ([string]::IsNullOrWhiteSpace($$value)) { return $$false }$\r$\n`
  FileWrite $0 `  try {$\r$\n`
  FileWrite $0 `    $$expanded = [Environment]::ExpandEnvironmentVariables($$value)$\r$\n`
  FileWrite $0 `    $$full = [System.IO.Path]::GetFullPath($$expanded)$\r$\n`
  FileWrite $0 `    return $$full.Equals($$installFull, [StringComparison]::OrdinalIgnoreCase) -or $$full.StartsWith($$installPrefix, [StringComparison]::OrdinalIgnoreCase)$\r$\n`
  FileWrite $0 `  } catch { return $$false }$\r$\n`
  FileWrite $0 `}$\r$\n`
  FileWrite $0 `function Remove-OwnedShortcut([string]$$path) {$\r$\n`
  FileWrite $0 `  if ([string]::IsNullOrWhiteSpace($$path)) { return }$\r$\n`
  FileWrite $0 `  if (-not (Test-Path -LiteralPath $$path -PathType Leaf)) { return }$\r$\n`
  FileWrite $0 `  try {$\r$\n`
  FileWrite $0 `    $$shortcut = $$shell.CreateShortcut($$path)$\r$\n`
  FileWrite $0 `    if ((Test-LucInstallPath $$shortcut.TargetPath) -or (Test-LucInstallPath $$shortcut.WorkingDirectory)) {$\r$\n`
  FileWrite $0 `      Remove-Item -LiteralPath $$path -Force$\r$\n`
  FileWrite $0 `    }$\r$\n`
  FileWrite $0 `  } catch {}$\r$\n`
  FileWrite $0 `}$\r$\n`
  FileWrite $0 `Remove-OwnedShortcut ([Environment]::GetEnvironmentVariable('LUC_DESKTOP_LEGACY_SHORTCUT'))$\r$\n`
  FileWrite $0 `Remove-OwnedShortcut ([Environment]::GetEnvironmentVariable('LUC_STARTMENU_LEGACY_SHORTCUT'))$\r$\n`
  FileWrite $0 `$$legacyDir = [Environment]::GetEnvironmentVariable('LUC_STARTMENU_LEGACY_DIR')$\r$\n`
  FileWrite $0 `if (-not [string]::IsNullOrWhiteSpace($$legacyDir) -and (Test-Path -LiteralPath $$legacyDir -PathType Container)) {$\r$\n`
  FileWrite $0 `  Get-ChildItem -LiteralPath $$legacyDir -Filter '*.lnk' | Where-Object { -not $$_.PSIsContainer } | ForEach-Object { Remove-OwnedShortcut $$_.FullName }$\r$\n`
  FileWrite $0 `  try { Remove-Item -LiteralPath $$legacyDir -Force -ErrorAction Stop } catch {}$\r$\n`
  FileWrite $0 `}$\r$\n`
  FileClose $0
  Pop $0
!macroend

!macro lucRemoveLegacyGlobalShortcuts
  !insertmacro lucInstallTimingMark "legacyShortcutCleanup" "start"
  Push $0
  Push $1
  InitPluginsDir
  StrCpy $1 "$PLUGINSDIR\luc-clean-legacy-shortcuts.ps1"
  !insertmacro lucWriteLegacyShortcutCleaner "$1"
  System::Call 'kernel32::SetEnvironmentVariable(t "LUC_INSTALL_DIR", t "$INSTDIR") i.r0'
  System::Call 'kernel32::SetEnvironmentVariable(t "LUC_DESKTOP_LEGACY_SHORTCUT", t "$DESKTOP\Luc.lnk") i.r0'
  System::Call 'kernel32::SetEnvironmentVariable(t "LUC_STARTMENU_LEGACY_SHORTCUT", t "$SMPROGRAMS\Luc.lnk") i.r0'
  System::Call 'kernel32::SetEnvironmentVariable(t "LUC_STARTMENU_LEGACY_DIR", t "$SMPROGRAMS\Luc") i.r0'
  nsExec::ExecToLog `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$1"`
  Pop $0
  Pop $1
  Pop $0
  !insertmacro lucInstallTimingMark "legacyShortcutCleanup" "end"
!macroend

!macro lucRemoveOwnedInstallTrees
  !insertmacro lucInstallTimingMark "removeOwnedInstallTrees" "start"
  DetailPrint "Removing LucCode-owned install files"
  SetOutPath "$TEMP"
  ; 老版本安装面是散装 resources\server 目录；现在改成 resources\seed 归档，
  ; 这行只在升级覆盖老版本时才会真正命中，负责清掉旧安装留下的散装树。
  RMDir /r "$INSTDIR\resources\server"
  ; seed 归档文件名包含版本号，覆盖复制不会替换旧版本；写入新安装面前必须
  ; 清空整个安装目录下的 seed。这里仅处理 $INSTDIR，不触碰 LUC_HOME 用户数据。
  RMDir /r "$INSTDIR\resources\seed"
  RMDir /r "$INSTDIR\resources\git"
  RMDir /r "$INSTDIR\resources\screenshot-themes"
  RMDir /r "$INSTDIR\resources\app"
  RMDir /r "$INSTDIR\resources\app.asar.unpacked"
  Delete "$INSTDIR\resources\app.asar"
  Delete "$INSTDIR\resources\app-update.yml"
  Delete "$INSTDIR\resources\elevate.exe"
  RMDir "$INSTDIR\resources"
  RMDir /r "$INSTDIR\locales"
  RMDir /r "$INSTDIR\swiftshader"
  Delete "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  Delete "$INSTDIR\${UNINSTALL_FILENAME}"
  Delete "$INSTDIR\Luc.exe"
  Delete "$INSTDIR\Uninstall Luc.exe"
  Delete "$INSTDIR\luc-install-diagnostics.log"
  !insertmacro lucRemoveLegacyGlobalShortcuts
  Delete "$INSTDIR\uninstallerIcon.ico"
  Delete "$INSTDIR\*.pak"
  Delete "$INSTDIR\*.bin"
  Delete "$INSTDIR\*.dat"
  Delete "$INSTDIR\*.dll"
  Delete "$INSTDIR\*.json"
  Delete "$INSTDIR\*.html"
  Delete "$INSTDIR\LICENSE*"
  Delete "$INSTDIR\*.ico"
  !insertmacro lucInstallTimingMark "removeOwnedInstallTrees" "end"
!macroend

!macro lucPrepareOwnedOverlay
  !insertmacro lucInstallTimingMark "prepareOwnedOverlay" "start"
  !insertmacro lucStopInstallDirProcesses
  !insertmacro lucRemoveOwnedInstallTrees
  ClearErrors
  !insertmacro lucInstallTimingMark "prepareOwnedOverlay" "end"
!macroend

!macro customInit
  !insertmacro lucInstallTimingMark "customInit" "start"
  !insertmacro lucStopInstallDirProcesses
  ; Wait for file handles to release.
  Sleep 2000
  !insertmacro lucInstallTimingMark "customInit" "end"
!macroend

!macro customUnInstallCheck
  !insertmacro lucInstallTimingMark "customUnInstallCheck" "start"
  ${If} ${Errors}
    DetailPrint `Previous uninstaller could not be launched; preparing a LucCode-owned overlay.`
  ${ElseIf} $R0 != 0
    DetailPrint `Previous uninstaller exited with code $R0; preparing a LucCode-owned overlay.`
  ${EndIf}
  !insertmacro lucPrepareOwnedOverlay
  ClearErrors
  !insertmacro lucInstallTimingMark "customUnInstallCheck" "end"
!macroend

!macro customUnInstallCheckCurrentUser
  !insertmacro lucInstallTimingMark "customUnInstallCheckCurrentUser" "start"
  ${If} ${Errors}
    DetailPrint `Previous current-user uninstaller could not be launched; continuing with LucCode-owned overlay.`
  ${ElseIf} $R0 != 0
    DetailPrint `Previous current-user uninstaller exited with code $R0; continuing with LucCode-owned overlay.`
  ${EndIf}
  !insertmacro lucPrepareOwnedOverlay
  ClearErrors
  !insertmacro lucInstallTimingMark "customUnInstallCheckCurrentUser" "end"
!macroend

!macro customRemoveFiles
  !insertmacro lucInstallTimingMark "customRemoveFiles" "start"
  !insertmacro lucStopInstallDirProcesses
  Delete "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  !insertmacro lucRemoveOwnedInstallTrees
  RMDir "$INSTDIR"
  !insertmacro lucInstallTimingMark "customRemoveFiles" "end"
!macroend

!macro customUnInit
  !insertmacro lucInstallTimingMark "customUnInit" "start"
  !insertmacro lucStopInstallDirProcesses
  Sleep 2000
  !insertmacro lucInstallTimingMark "customUnInit" "end"
!macroend
