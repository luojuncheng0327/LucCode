// 根治 electron/electron#51761：安装目录 DACL 含 orphaned AppContainer SID 时，
// Chromium 构建 GPU 子进程沙箱描述符会 __debugbreak()（0x80000003）。给安装目录
// 幂等补 S-1-15-2-2（ALL RESTRICTED APPLICATION PACKAGES）的 (OI)(CI)(RX) ACE 后，
// 沙箱与 GPU 都不需要降级。上游修复落地后，本模块应整块删除（build-to-delete）。
const fs = require("fs");
const path = require("path");
const childProcess = require("child_process");
const gpuStartupPolicy = require("./gpu-startup-policy.cjs");

const STATE_VERSION = 1;
const STATE_FILE = path.join("user", "win32-install-acl-heal.json");
const SANDBOX_ACE_GRANT = "*S-1-15-2-2:(OI)(CI)(RX)";
const MAX_GRANT_FAILURES = 3;
const MAX_INEFFECTIVE_PROBES = 2;
const ICACLS_TIMEOUT_MS = 15000;

function nowIso(now) {
  if (now instanceof Date) return now.toISOString();
  if (typeof now === "string" && now) return now;
  return new Date().toISOString();
}

// 语义同 gpu-startup-policy 的 boolFromSetting（其为模块私有，为避免仅因两行解析
// 逻辑而扩大该模块的导出面，这里保留一份局部实现）。
function envFlag(value) {
  if (typeof value !== "string") return false;
  return ["1", "true", "on", "yes", "enabled"].includes(value.trim().toLowerCase());
}

function getInstallAclHealStatePath(lucHome) {
  return path.join(lucHome, STATE_FILE);
}

// 该文件只是"是否已 grant 过"的幂等记账；损坏时按空处理并在下次写入时重建，
// 代价是多跑一次幂等 icacls，自我修正，不构成静默降级。
function readHealState(lucHome) {
  try {
    const parsed = JSON.parse(fs.readFileSync(getInstallAclHealStatePath(lucHome), "utf-8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {}
  return { version: STATE_VERSION, ineffectiveCount: 0, heal: null };
}

function writeHealState(lucHome, state) {
  const filePath = getInstallAclHealStatePath(lucHome);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify({ ...state, version: STATE_VERSION }, null, 2) + "\n", "utf-8");
  fs.renameSync(tmpPath, filePath);
}

function normalizeInstallDir(installDir) {
  return path.win32.normalize(String(installDir)).replace(/[\\/]+$/, "").toLowerCase();
}

function sameIdentity(heal, installDir, appVersion) {
  return (
    !!heal &&
    typeof heal.installDir === "string" &&
    normalizeInstallDir(heal.installDir) === normalizeInstallDir(installDir) &&
    heal.appVersion === appVersion
  );
}

function icaclsPath(env) {
  const systemRoot = env?.SystemRoot || env?.SYSTEMROOT || "C:\\Windows";
  return path.win32.join(systemRoot, "System32", "icacls.exe");
}

function runProbe({ lucHome, state, heal, policy, now }) {
  if ((state.ineffectiveCount || 0) >= MAX_INEFFECTIVE_PROBES) {
    const next = {
      ...state,
      heal: { ...heal, probedAt: nowIso(now), clearedMode: null, updatedAt: nowIso(now) },
    };
    writeHealState(lucHome, next);
    return { status: "healed", probed: false, clearedMode: null };
  }
  const recovery = policy.clearAutoGpuModeForRecovery({
    lucHome,
    reason: "win32-install-acl-heal",
    now,
  });
  const next = {
    ...state,
    heal: {
      ...heal,
      probedAt: nowIso(now),
      clearedMode: recovery.clearedMode,
      updatedAt: nowIso(now),
    },
  };
  writeHealState(lucHome, next);
  return { status: "healed", probed: recovery.cleared, clearedMode: recovery.clearedMode };
}

function judgeProbeOutcome({ lucHome, state, heal, policy, now }) {
  const evidence = policy.getGpuRecoveryEvidence(lucHome);
  const crashedAfterProbe =
    (evidence.latestCrashAt && evidence.latestCrashAt > heal.probedAt) ||
    (evidence.startup?.status === "pending" &&
      evidence.incompleteClassification === "gpu-recovery" &&
      evidence.startup.startedAt &&
      evidence.startup.startedAt > heal.probedAt);
  if (crashedAfterProbe) {
    if (heal.clearedMode) {
      policy.restoreDeeperAutoGpuMode({
        lucHome,
        mode: heal.clearedMode,
        reason: "acl-heal-ineffective",
        now,
      });
    }
    writeHealState(lucHome, {
      ...state,
      ineffectiveCount: (state.ineffectiveCount || 0) + 1,
      heal: { ...heal, status: "ineffective", updatedAt: nowIso(now) },
    });
    return { status: "ineffective" };
  }
  const stableHardwareStartup =
    evidence.startup?.status === "ready" &&
    evidence.startup.policyMode === "hardware" &&
    evidence.startup.readyAt &&
    evidence.startup.readyAt > heal.probedAt;
  if (stableHardwareStartup && (state.ineffectiveCount || 0) !== 0) {
    writeHealState(lucHome, { ...state, ineffectiveCount: 0 });
    return { status: "stable" };
  }
  if (stableHardwareStartup) return { status: "stable" };
  return { status: "skipped", reason: "already-healed" };
}

function maybeHealWin32InstallAcl({
  lucHome,
  platform = process.platform,
  isPackaged,
  installDir,
  appVersion,
  env = process.env,
  execFileSync = childProcess.execFileSync,
  policy = gpuStartupPolicy,
  now,
} = {}) {
  if (!lucHome) throw new Error("maybeHealWin32InstallAcl requires lucHome");
  if (platform !== "win32") return { status: "skipped", reason: "platform" };
  if (envFlag(env?.LUC_DISABLE_INSTALL_ACL_HEAL)) return { status: "skipped", reason: "disabled" };
  if (!isPackaged && !envFlag(env?.LUC_FORCE_INSTALL_ACL_HEAL)) {
    return { status: "skipped", reason: "not-packaged" };
  }
  if (!installDir || !appVersion) {
    throw new Error("maybeHealWin32InstallAcl requires installDir and appVersion");
  }

  const state = readHealState(lucHome);
  const heal = sameIdentity(state.heal, installDir, appVersion) ? state.heal : null;

  if (heal?.status === "ineffective") return { status: "skipped", reason: "ineffective" };
  if (heal?.status === "failed" && heal.failureCount >= MAX_GRANT_FAILURES) {
    return { status: "skipped", reason: "failure-cap" };
  }
  if (heal?.status === "ok") {
    // grant 与 probe 是两次连续写盘；中间进程被杀会留下 probedAt=null 的 ok 记录，
    // 这里续跑探测而不是把它误判成"已处理完"。
    if (!heal.probedAt) return runProbe({ lucHome, state, heal, policy, now });
    return judgeProbeOutcome({ lucHome, state, heal, policy, now });
  }

  try {
    execFileSync(icaclsPath(env), [installDir, "/grant", SANDBOX_ACE_GRANT], {
      timeout: ICACLS_TIMEOUT_MS,
      windowsHide: true,
    });
  } catch (error) {
    const nextHeal = {
      installDir,
      appVersion,
      status: "failed",
      failureCount: (heal?.failureCount || 0) + 1,
      healedAt: null,
      probedAt: null,
      clearedMode: null,
      lastError: `${error?.message || error}${typeof error?.status === "number" ? ` (exit ${error.status})` : ""}`,
      updatedAt: nowIso(now),
    };
    writeHealState(lucHome, { ...state, heal: nextHeal });
    return { status: "grant-failed", failureCount: nextHeal.failureCount };
  }

  const grantedHeal = {
    installDir,
    appVersion,
    status: "ok",
    failureCount: 0,
    healedAt: nowIso(now),
    probedAt: null,
    clearedMode: null,
    lastError: null,
    updatedAt: nowIso(now),
  };
  const grantedState = { ...state, heal: grantedHeal };
  writeHealState(lucHome, grantedState);
  return runProbe({ lucHome, state: grantedState, heal: grantedHeal, policy, now });
}

function buildInstallAclHealDiagnostics({ lucHome } = {}) {
  const state = lucHome ? readHealState(lucHome) : { heal: null };
  return [
    "",
    "--- Install ACL Heal ---",
    `Heal state: ${JSON.stringify(state.heal || null)}`,
    `Ineffective probe count: ${state.ineffectiveCount || 0}`,
    `Manual fix (electron/electron#51761): icacls "<installDir>" /grant ${SANDBOX_ACE_GRANT}`,
    "Env switches: LUC_DISABLE_INSTALL_ACL_HEAL=1 disables the heal; LUC_FORCE_INSTALL_ACL_HEAL=1 forces it in unpackaged builds",
  ].join("\n");
}

module.exports = {
  buildInstallAclHealDiagnostics,
  getInstallAclHealStatePath,
  maybeHealWin32InstallAcl,
};
