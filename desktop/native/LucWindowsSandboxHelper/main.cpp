#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif

#include <windows.h>
#include <bcrypt.h>
#include <userenv.h>
#include <aclapi.h>
#include <sddl.h>

#include <algorithm>
#include <cstdint>
#include <cwctype>
#include <cwchar>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

#ifndef LUA_TOKEN
#define LUA_TOKEN 0x00000004
#endif
#ifndef WRITE_RESTRICTED
#define WRITE_RESTRICTED 0x00000008
#endif
#ifndef PROC_THREAD_ATTRIBUTE_JOB_LIST
#define PROC_THREAD_ATTRIBUTE_JOB_LIST ProcThreadAttributeValue(13, FALSE, TRUE, FALSE)
#endif

struct WritableRoot {
    std::wstring path;
    bool required;
    std::wstring sidString;
    PSID sid = nullptr;
};

struct Options {
    std::wstring cwd;
    DWORD timeoutMs = 0;
    bool timeoutSpecified = false;
    bool superviseServer = false;
    DWORD parentPid = 0;
    bool parentPidSpecified = false;
    std::vector<WritableRoot> writableRoots;
    std::vector<std::wstring> denyWritePaths;
    std::vector<std::wstring> lucWriteAclCleanupPaths;
    std::vector<std::wstring> legacyAclDiagnosticPaths;
    std::vector<std::wstring> legacyProfileNames;
    std::vector<std::wstring> legacyProfileCleanupNames;
    bool cleanupLegacyAcl = false;
    bool diagnoseToken = false;
    bool currentDesktop = false;
    bool verbatimLastArg = false;
    std::wstring executable;
    std::vector<std::wstring> args;
};

struct LegacyProfileSid {
    std::wstring name;
    std::wstring sidString;
    PSID sid = nullptr;
};

struct MigrationResult {
    int findings = 0;
    int failures = 0;
};

struct AclRestore {
    std::wstring path;
    PSECURITY_DESCRIPTOR descriptor = nullptr;
    PACL oldDacl = nullptr;
};

struct SandboxDesktop {
    std::wstring stationName;
    std::wstring desktopName;
    std::wstring qualifiedName;
    HWINSTA station = nullptr;
    HDESK handle = nullptr;
};

struct TokenDefaultDaclSnapshot {
    std::vector<BYTE> buffer;
    PACL dacl = nullptr;
};

struct StartupAttributeList {
    LPPROC_THREAD_ATTRIBUTE_LIST list = nullptr;
    std::vector<HANDLE> inheritedHandles;
    std::vector<HANDLE> jobs;
};

struct GuardianControlWatch {
    HANDLE input = nullptr;
    HANDLE event = nullptr;
    HANDLE thread = nullptr;
    DWORD readError = ERROR_SUCCESS;
};

static const DWORD WRITE_ALLOW_MASK =
    FILE_GENERIC_READ | FILE_GENERIC_WRITE | FILE_GENERIC_EXECUTE | DELETE | FILE_DELETE_CHILD;
static const DWORD WRITE_DENY_MASK =
    FILE_WRITE_DATA | FILE_APPEND_DATA | FILE_WRITE_EA | FILE_WRITE_ATTRIBUTES | DELETE | FILE_DELETE_CHILD;
// CreateProcessAsUserW requires the target token to have full access to the
// lpDesktop pair. WinSta0 already grants the logon session access; the helper
// only adds a full-access ACE to its per-launch private desktop. The shared
// WinSta0 station ACL and file ACLs are unchanged. This desktop is a dedicated
// USER32 launch surface, not an authorization boundary; the restricted token,
// file ACLs, and kill-on-close job remain the sandbox boundaries.
static const DWORD SANDBOX_WINDOW_STATION_ACCESS = WINSTA_ALL_ACCESS;
static const DWORD SANDBOX_DESKTOP_ACCESS =
    STANDARD_RIGHTS_REQUIRED |
    DESKTOP_CREATEMENU |
    DESKTOP_CREATEWINDOW |
    DESKTOP_ENUMERATE |
    DESKTOP_HOOKCONTROL |
    DESKTOP_JOURNALPLAYBACK |
    DESKTOP_JOURNALRECORD |
    DESKTOP_READOBJECTS |
    DESKTOP_SWITCHDESKTOP |
    DESKTOP_WRITEOBJECTS;
static const wchar_t* EVERYONE_SID = L"S-1-1-0";
static const wchar_t* WRITE_RESTRICTED_CODE_SID = L"S-1-5-33";
static const DWORD MAX_TIMEOUT_MS = INFINITE - 1;
static const DWORD TERMINATION_GRACE_MS = 5000;
static const DWORD EARLY_EXIT_DIAGNOSTIC_WINDOW_MS = 5000;
static const DWORD STATUS_DLL_INIT_FAILED_EXIT_CODE = 0xC0000142UL;
static const UINT TIMEOUT_PROCESS_EXIT_CODE = 124;
static const int HELPER_TERMINATION_FAILED_EXIT_CODE = 125;
static const int HELPER_LAUNCH_FAILED_EXIT_CODE = 126;

static void fail(const std::wstring& message) {
    std::wcerr << L"luc-win-sandbox: " << message << std::endl;
}

static void debug(const std::wstring& message) {
    wchar_t enabled[8] = {};
    DWORD n = GetEnvironmentVariableW(L"LUC_WIN32_SANDBOX_DEBUG", enabled, 8);
    if (n > 0 && enabled[0] != L'\0' && enabled[0] != L'0') {
        std::wcerr << L"luc-win-sandbox: " << message << std::endl;
    }
}

static std::wstring win32Message(DWORD code) {
    LPWSTR buffer = nullptr;
    FormatMessageW(
        FORMAT_MESSAGE_ALLOCATE_BUFFER | FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS,
        nullptr,
        code,
        0,
        reinterpret_cast<LPWSTR>(&buffer),
        0,
        nullptr
    );
    std::wstring out = buffer ? buffer : L"unknown error";
    if (buffer) LocalFree(buffer);
    return out;
}

static std::wstring hexDword(DWORD code) {
    wchar_t buffer[16] = {};
    swprintf_s(buffer, L"0x%08lX", static_cast<unsigned long>(code));
    return buffer;
}

static std::wstring win32Diagnostic(DWORD code) {
    return L"rc=" + std::to_wstring(code) + L" hex=" + hexDword(code) + L" message=" + win32Message(code);
}

static std::wstring boolDiagnosticValue(bool value) {
    return value ? L"true" : L"false";
}

static void emitTerminalRecord(
    const std::wstring& status,
    bool hasExitCode,
    DWORD exitCode,
    DWORD timeoutMs,
    DWORD win32Error = ERROR_SUCCESS
) {
    std::wcerr
        << L"luc-win-sandbox: terminal-v1"
        << L" status=\"" << status << L"\""
        << L" exitCode=\"" << (hasExitCode ? std::to_wstring(exitCode) : L"") << L"\""
        << L" timeoutMs=\"" << timeoutMs << L"\""
        << L" win32Error=\"" << win32Error << L"\""
        << std::endl;
}

static DWORD parseTimeoutMs(const std::wstring& value) {
    if (value.empty()) throw std::runtime_error("empty --timeout-ms");
    unsigned long long parsed = 0;
    for (wchar_t ch : value) {
        if (ch < L'0' || ch > L'9') throw std::runtime_error("invalid --timeout-ms");
        const unsigned long long digit = static_cast<unsigned long long>(ch - L'0');
        if (parsed > (static_cast<unsigned long long>(MAX_TIMEOUT_MS) - digit) / 10) {
            throw std::runtime_error("--timeout-ms is out of range");
        }
        parsed = parsed * 10 + digit;
    }
    return static_cast<DWORD>(parsed);
}

static DWORD parsePositiveDword(const std::wstring& value, const char* argumentName) {
    if (value.empty()) throw std::runtime_error(std::string("empty ") + argumentName);
    unsigned long long parsed = 0;
    for (wchar_t ch : value) {
        if (ch < L'0' || ch > L'9') throw std::runtime_error(std::string("invalid ") + argumentName);
        const unsigned long long digit = static_cast<unsigned long long>(ch - L'0');
        if (parsed > (static_cast<unsigned long long>(MAXDWORD) - digit) / 10) {
            throw std::runtime_error(std::string(argumentName) + " is out of range");
        }
        parsed = parsed * 10 + digit;
    }
    if (parsed == 0) throw std::runtime_error(std::string(argumentName) + " must be positive");
    return static_cast<DWORD>(parsed);
}

static std::wstring escapeDiagnosticValue(const std::wstring& value) {
    std::wstring out;
    out.reserve(value.size());
    for (wchar_t ch : value) {
        if (ch == L'\\') {
            out += L"\\\\";
        } else if (ch == L'"') {
            out += L"\\\"";
        } else if (ch == L'\r') {
            out += L"\\r";
        } else if (ch == L'\n') {
            out += L"\\n";
        } else if (ch == L'\t') {
            out += L"\\t";
        } else {
            out.push_back(ch);
        }
    }
    return out;
}

static bool isDirectory(const std::wstring& p) {
    DWORD attrs = GetFileAttributesW(p.c_str());
    return attrs != INVALID_FILE_ATTRIBUTES && (attrs & FILE_ATTRIBUTE_DIRECTORY);
}

static std::wstring normalizePathKey(std::wstring out) {
    if (out.rfind(L"\\\\?\\UNC\\", 0) == 0) {
        out = L"\\\\" + out.substr(8);
    } else if (out.rfind(L"\\\\?\\", 0) == 0) {
        out = out.substr(4);
    }
    if (out.rfind(L"\\??\\UNC\\", 0) == 0) {
        out = L"\\\\" + out.substr(8);
    } else if (out.rfind(L"\\??\\", 0) == 0) {
        out = out.substr(4);
    }
    std::replace(out.begin(), out.end(), L'/', L'\\');
    std::transform(out.begin(), out.end(), out.begin(), [](wchar_t ch) {
        return static_cast<wchar_t>(std::towupper(ch));
    });
    while (out.size() > 3 && (out.back() == L'\\' || out.back() == L'/')) out.pop_back();
    return out;
}

static std::wstring finalPathForKey(const std::wstring& raw) {
    HANDLE handle = CreateFileW(
        raw.c_str(),
        0,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        nullptr,
        OPEN_EXISTING,
        FILE_FLAG_BACKUP_SEMANTICS,
        nullptr
    );
    if (handle == INVALID_HANDLE_VALUE) return L"";

    DWORD needed = GetFinalPathNameByHandleW(handle, nullptr, 0, VOLUME_NAME_DOS);
    if (needed == 0) {
        CloseHandle(handle);
        return L"";
    }
    std::wstring out(needed + 1, L'\0');
    DWORD written = GetFinalPathNameByHandleW(handle, out.data(), needed + 1, VOLUME_NAME_DOS);
    CloseHandle(handle);
    if (written == 0 || written > needed) return L"";
    out.resize(written);
    return normalizePathKey(out);
}

static std::wstring fullPathForKey(const std::wstring& raw) {
    std::wstring finalPath = finalPathForKey(raw);
    if (!finalPath.empty()) return finalPath;

    DWORD needed = GetFullPathNameW(raw.c_str(), 0, nullptr, nullptr);
    if (needed == 0) return raw;
    std::wstring out(needed, L'\0');
    DWORD written = GetFullPathNameW(raw.c_str(), needed, out.data(), nullptr);
    if (written == 0 || written >= needed) return raw;
    out.resize(written);
    return normalizePathKey(out);
}

static bool isSameOrInside(const std::wstring& childRaw, const std::wstring& rootRaw) {
    std::wstring child = fullPathForKey(childRaw);
    std::wstring root = fullPathForKey(rootRaw);
    if (child == root) return true;
    if (root.empty()) return false;
    if (root.back() != L'\\') root.push_back(L'\\');
    return child.size() > root.size() && child.compare(0, root.size(), root) == 0;
}

static std::wstring hashSidForWritableRoot(const std::wstring& root, const std::wstring& prefix, const std::wstring& discriminator) {
    const std::wstring key = discriminator + fullPathForKey(root);
    std::uint32_t hashes[4] = { 2166136261u, 2166136261u ^ 0x9e3779b9u, 2166136261u ^ 0x85ebca6bu, 2166136261u ^ 0xc2b2ae35u };
    for (wchar_t ch : key) {
        std::uint32_t value = static_cast<std::uint32_t>(ch);
        for (int i = 0; i < 4; i++) {
            hashes[i] ^= (value + static_cast<std::uint32_t>(i * 257));
            hashes[i] *= 16777619u;
            hashes[i] ^= (hashes[i] >> 13);
        }
    }
    return prefix +
        std::to_wstring(hashes[0] | 1u) + L"-" +
        std::to_wstring(hashes[1] | 1u) + L"-" +
        std::to_wstring(hashes[2] | 1u) + L"-" +
        std::to_wstring(hashes[3] | 1u);
}

static std::wstring sidForWritableRoot(const std::wstring& root) {
    return hashSidForWritableRoot(root, L"S-1-5-21-", L"luc-win32-write-root-v3:");
}

static std::wstring sidForWritableRootLegacyCapabilityNamespace(const std::wstring& root) {
    return hashSidForWritableRoot(root, L"S-1-15-3-4096-", L"luc-win32-write-root-v2:");
}

static std::wstring sidForWritableRootLegacyAccountNamespace(const std::wstring& root) {
    return hashSidForWritableRoot(root, L"S-1-5-21-", L"luc-win32-write-root:");
}

static Options parseArgs(int argc, wchar_t** argv) {
    Options opts;
    bool passthrough = false;
    for (int i = 1; i < argc; i++) {
        std::wstring arg = argv[i];
        if (passthrough) {
            if (opts.executable.empty()) opts.executable = arg;
            else opts.args.push_back(arg);
            continue;
        }
        if (arg == L"--") {
            passthrough = true;
            continue;
        }
        if (arg == L"--cwd" && i + 1 < argc) {
            opts.cwd = argv[++i];
            continue;
        }
        if (arg == L"--supervise-server") {
            if (opts.superviseServer) throw std::runtime_error("duplicate --supervise-server");
            opts.superviseServer = true;
            continue;
        }
        if (arg == L"--parent-pid" && i + 1 < argc) {
            if (opts.parentPidSpecified) throw std::runtime_error("duplicate --parent-pid");
            opts.parentPid = parsePositiveDword(argv[++i], "--parent-pid");
            opts.parentPidSpecified = true;
            continue;
        }
        if (arg == L"--timeout-ms" && i + 1 < argc) {
            if (opts.timeoutSpecified) throw std::runtime_error("duplicate --timeout-ms");
            opts.timeoutMs = parseTimeoutMs(argv[++i]);
            opts.timeoutSpecified = true;
            continue;
        }
        if ((arg == L"--writable-root" || arg == L"--writable-root-optional") && i + 1 < argc) {
            std::wstring target = argv[++i];
            opts.writableRoots.push_back({ target, arg == L"--writable-root" });
            continue;
        }
        if (arg == L"--deny-write" && i + 1 < argc) {
            opts.denyWritePaths.push_back(argv[++i]);
            continue;
        }
        if (arg == L"--cleanup-luc-write-acl" && i + 1 < argc) {
            opts.lucWriteAclCleanupPaths.push_back(argv[++i]);
            continue;
        }
        if (arg == L"--diagnose-legacy-acl" && i + 1 < argc) {
            opts.legacyAclDiagnosticPaths.push_back(argv[++i]);
            continue;
        }
        if (arg == L"--cleanup-legacy-acl") {
            opts.cleanupLegacyAcl = true;
            continue;
        }
        if (arg == L"--legacy-appcontainer-profile" && i + 1 < argc) {
            opts.legacyProfileNames.push_back(argv[++i]);
            continue;
        }
        if (arg == L"--cleanup-legacy-profile" && i + 1 < argc) {
            opts.legacyProfileCleanupNames.push_back(argv[++i]);
            continue;
        }
        if (arg == L"--diagnose-token") {
            opts.diagnoseToken = true;
            continue;
        }
        if (arg == L"--current-desktop") {
            if (opts.currentDesktop) throw std::runtime_error("duplicate --current-desktop");
            opts.currentDesktop = true;
            continue;
        }
        if (arg == L"--verbatim-last-arg") {
            if (opts.verbatimLastArg) throw std::runtime_error("duplicate --verbatim-last-arg");
            opts.verbatimLastArg = true;
            continue;
        }
        if (arg == L"--network" || arg == L"--grant-read" || arg == L"--grant-read-optional" ||
            arg == L"--grant-write" || arg == L"--grant-write-optional" || arg == L"--deny-read") {
            throw std::runtime_error("legacy AppContainer helper argument is no longer supported");
        }
        throw std::runtime_error("unknown or incomplete argument");
    }

    bool maintenanceMode = !opts.lucWriteAclCleanupPaths.empty() ||
        !opts.legacyAclDiagnosticPaths.empty() ||
        !opts.legacyProfileNames.empty() ||
        !opts.legacyProfileCleanupNames.empty() ||
        opts.cleanupLegacyAcl;
    if (maintenanceMode) {
        if (!opts.cwd.empty() || !opts.executable.empty() || !opts.writableRoots.empty() || !opts.denyWritePaths.empty() || opts.diagnoseToken || opts.currentDesktop || opts.verbatimLastArg || opts.timeoutSpecified || opts.superviseServer || opts.parentPidSpecified) {
            throw std::runtime_error("maintenance arguments cannot be combined with sandbox execution arguments");
        }
        return opts;
    }
    if (opts.superviseServer) {
        if (!opts.parentPidSpecified) throw std::runtime_error("missing --parent-pid");
        if (opts.cwd.empty()) throw std::runtime_error("missing --cwd");
        if (opts.executable.empty()) throw std::runtime_error("missing executable after --");
        if (opts.timeoutSpecified || !opts.writableRoots.empty() || !opts.denyWritePaths.empty() || opts.diagnoseToken || opts.currentDesktop || opts.verbatimLastArg) {
            throw std::runtime_error("server guardian arguments cannot be combined with sandbox execution arguments");
        }
        return opts;
    }
    if (opts.parentPidSpecified) throw std::runtime_error("--parent-pid requires --supervise-server");
    if (opts.cwd.empty()) throw std::runtime_error("missing --cwd");
    if (!opts.timeoutSpecified) throw std::runtime_error("missing --timeout-ms");
    if (opts.executable.empty()) throw std::runtime_error("missing executable after --");
    if (opts.verbatimLastArg && opts.args.empty()) {
        throw std::runtime_error("--verbatim-last-arg requires at least one child argument");
    }
    if (opts.writableRoots.empty()) opts.writableRoots.push_back({ opts.cwd, true });
    return opts;
}

static std::wstring quoteArg(const std::wstring& arg) {
    if (arg.empty()) return L"\"\"";
    bool needsQuotes = arg.find_first_of(L" \t\n\v\"") != std::wstring::npos;
    if (!needsQuotes) return arg;

    std::wstring out = L"\"";
    size_t backslashes = 0;
    for (wchar_t ch : arg) {
        if (ch == L'\\') {
            backslashes++;
            continue;
        }
        if (ch == L'"') {
            out.append(backslashes * 2 + 1, L'\\');
            out.push_back(ch);
            backslashes = 0;
            continue;
        }
        out.append(backslashes, L'\\');
        backslashes = 0;
        out.push_back(ch);
    }
    out.append(backslashes * 2, L'\\');
    out.push_back(L'"');
    return out;
}

static std::wstring buildCommandLine(const Options& opts) {
    std::wstring command = quoteArg(opts.executable);
    for (size_t i = 0; i < opts.args.size(); i++) {
        command.push_back(L' ');
        if (opts.verbatimLastArg && i + 1 == opts.args.size()) {
            command += opts.args[i];
        } else {
            command += quoteArg(opts.args[i]);
        }
    }
    return command;
}

static bool aceMatchesSidAndMask(PACL dacl, PSID sid, BYTE aceType, DWORD mask) {
    if (!dacl || !sid) return false;
    for (DWORD i = 0; i < dacl->AceCount; i++) {
        void* rawAce = nullptr;
        if (!GetAce(dacl, i, &rawAce) || !rawAce) continue;
        ACE_HEADER* header = reinterpret_cast<ACE_HEADER*>(rawAce);
        if (header->AceType != aceType) continue;
        if (aceType == ACCESS_ALLOWED_ACE_TYPE) {
            auto* ace = reinterpret_cast<ACCESS_ALLOWED_ACE*>(rawAce);
            PSID aceSid = reinterpret_cast<PSID>(&ace->SidStart);
            if (EqualSid(aceSid, sid) && ((ace->Mask & mask) == mask)) return true;
        } else if (aceType == ACCESS_DENIED_ACE_TYPE) {
            auto* ace = reinterpret_cast<ACCESS_DENIED_ACE*>(rawAce);
            PSID aceSid = reinterpret_cast<PSID>(&ace->SidStart);
            if (EqualSid(aceSid, sid) && ((ace->Mask & mask) == mask)) return true;
        }
    }
    return false;
}

static bool ensureAce(
    const std::wstring& path,
    PSID sid,
    ACCESS_MODE mode,
    DWORD mask,
    bool required,
    std::vector<AclRestore>* restores = nullptr
) {
    PACL oldDacl = nullptr;
    PSECURITY_DESCRIPTOR descriptor = nullptr;
    DWORD rc = GetNamedSecurityInfoW(
        const_cast<LPWSTR>(path.c_str()),
        SE_FILE_OBJECT,
        DACL_SECURITY_INFORMATION,
        nullptr,
        nullptr,
        &oldDacl,
        nullptr,
        &descriptor
    );
    if (rc != ERROR_SUCCESS) {
        if (required) fail(L"cannot read ACL for " + path + L": " + win32Diagnostic(rc));
        else debug(L"skipping optional ACL update for " + path + L": " + win32Diagnostic(rc));
        return false;
    }

    BYTE aceType = mode == DENY_ACCESS ? ACCESS_DENIED_ACE_TYPE : ACCESS_ALLOWED_ACE_TYPE;
    if (aceMatchesSidAndMask(oldDacl, sid, aceType, mask)) {
        if (descriptor) LocalFree(descriptor);
        return true;
    }

    EXPLICIT_ACCESSW access = {};
    access.grfAccessPermissions = mask;
    access.grfAccessMode = mode;
    access.grfInheritance = isDirectory(path) ? (OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE) : NO_INHERITANCE;
    access.Trustee.TrusteeForm = TRUSTEE_IS_SID;
    access.Trustee.TrusteeType = TRUSTEE_IS_UNKNOWN;
    access.Trustee.ptstrName = reinterpret_cast<LPWSTR>(sid);

    PACL newDacl = nullptr;
    rc = SetEntriesInAclW(1, &access, oldDacl, &newDacl);
    if (rc != ERROR_SUCCESS) {
        if (required) fail(L"cannot build ACL for " + path + L": " + win32Diagnostic(rc));
        else debug(L"skipping optional ACL update for " + path + L": " + win32Diagnostic(rc));
        if (descriptor) LocalFree(descriptor);
        return false;
    }

    rc = SetNamedSecurityInfoW(
        const_cast<LPWSTR>(path.c_str()),
        SE_FILE_OBJECT,
        DACL_SECURITY_INFORMATION,
        nullptr,
        nullptr,
        newDacl,
        nullptr
    );
    if (newDacl) LocalFree(newDacl);
    if (rc != ERROR_SUCCESS) {
        if (descriptor) LocalFree(descriptor);
        if (required) fail(L"cannot apply ACL for " + path + L": " + win32Diagnostic(rc));
        else debug(L"skipping optional ACL update for " + path + L": " + win32Diagnostic(rc));
        return false;
    }
    if (restores) {
        restores->push_back({ path, descriptor, oldDacl });
        descriptor = nullptr;
    }
    if (descriptor) LocalFree(descriptor);
    return true;
}

static void restoreAcls(std::vector<AclRestore>& restores) {
    for (auto it = restores.rbegin(); it != restores.rend(); ++it) {
        DWORD rc = SetNamedSecurityInfoW(
            const_cast<LPWSTR>(it->path.c_str()),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            nullptr,
            nullptr,
            it->oldDacl,
            nullptr
        );
        if (rc != ERROR_SUCCESS) {
            fail(L"cannot restore ACL for " + it->path + L": " + win32Message(rc));
        }
        if (it->descriptor) LocalFree(it->descriptor);
        it->descriptor = nullptr;
        it->oldDacl = nullptr;
    }
    restores.clear();
}

static bool convertRootSids(std::vector<WritableRoot>& roots) {
    for (auto& root : roots) {
        root.sidString = sidForWritableRoot(root.path);
        if (!ConvertStringSidToSidW(root.sidString.c_str(), &root.sid)) {
            fail(L"cannot create restricted SID for " + root.path + L": " + win32Message(GetLastError()));
            return false;
        }
    }
    return true;
}

static void freeRootSids(std::vector<WritableRoot>& roots) {
    for (auto& root : roots) {
        if (root.sid) LocalFree(root.sid);
        root.sid = nullptr;
    }
}

static bool applyWriteAcls(
    std::vector<WritableRoot>& roots,
    const std::vector<std::wstring>& denyWritePaths,
    std::vector<AclRestore>& restores
) {
    for (const auto& root : roots) {
        if (!ensureAce(root.path, root.sid, GRANT_ACCESS, WRITE_ALLOW_MASK, root.required, &restores) && root.required) {
            return false;
        }
    }

    for (const auto& denyPath : denyWritePaths) {
        bool matched = false;
        for (const auto& root : roots) {
            if (!root.sid || !isSameOrInside(denyPath, root.path)) continue;
            matched = true;
            if (!ensureAce(denyPath, root.sid, DENY_ACCESS, WRITE_DENY_MASK, true, &restores)) return false;
        }
        if (!matched) {
            debug(L"deny-write path is outside writable roots: " + denyPath);
        }
    }
    return true;
}

static bool queryTokenDefaultDacl(HANDLE token, TokenDefaultDaclSnapshot& snapshot) {
    DWORD needed = 0;
    GetTokenInformation(token, TokenDefaultDacl, nullptr, 0, &needed);
    if (needed == 0 && GetLastError() != ERROR_INSUFFICIENT_BUFFER) {
        debug(L"GetTokenInformation(TokenDefaultDacl) size failed: " + win32Message(GetLastError()));
        return false;
    }
    snapshot.buffer.assign(needed, 0);
    if (!GetTokenInformation(token, TokenDefaultDacl, snapshot.buffer.data(), needed, &needed)) {
        debug(L"GetTokenInformation(TokenDefaultDacl) failed: " + win32Message(GetLastError()));
        snapshot.buffer.clear();
        snapshot.dacl = nullptr;
        return false;
    }
    auto* info = reinterpret_cast<TOKEN_DEFAULT_DACL*>(snapshot.buffer.data());
    snapshot.dacl = info ? info->DefaultDacl : nullptr;
    return true;
}

static PACL buildTokenDefaultDacl(
    const std::vector<WritableRoot>& roots,
    PSID everyoneSid,
    PSID logonSid,
    DWORD permissions
) {
    std::vector<EXPLICIT_ACCESSW> entries;
    auto appendGrant = [&](PSID sid) {
        if (!sid || !IsValidSid(sid)) return;
        EXPLICIT_ACCESSW access = {};
        access.grfAccessPermissions = permissions;
        access.grfAccessMode = GRANT_ACCESS;
        access.grfInheritance = NO_INHERITANCE;
        access.Trustee.TrusteeForm = TRUSTEE_IS_SID;
        access.Trustee.TrusteeType = TRUSTEE_IS_UNKNOWN;
        access.Trustee.ptstrName = reinterpret_cast<LPWSTR>(sid);
        entries.push_back(access);
    };
    appendGrant(everyoneSid);
    appendGrant(logonSid);
    for (const auto& root : roots) {
        if (!root.sid) continue;
        appendGrant(root.sid);
    }
    if (entries.empty()) return nullptr;
    PACL dacl = nullptr;
    DWORD rc = SetEntriesInAclW(
        static_cast<ULONG>(entries.size()),
        entries.data(),
        nullptr,
        &dacl
    );
    if (rc != ERROR_SUCCESS) {
        fail(L"SetEntriesInAclW(token default DACL) failed: " + win32Message(rc));
        return nullptr;
    }
    return dacl;
}

static PACL buildDaclForSid(PSID sid, PACL baseDefaultDacl, DWORD permissions, const wchar_t* context) {
    if (!sid || !IsValidSid(sid)) {
        fail(std::wstring(L"cannot build ") + context + L" DACL without a valid SID");
        return nullptr;
    }
    EXPLICIT_ACCESSW access = {};
    access.grfAccessPermissions = permissions;
    access.grfAccessMode = GRANT_ACCESS;
    access.grfInheritance = NO_INHERITANCE;
    access.Trustee.TrusteeForm = TRUSTEE_IS_SID;
    access.Trustee.TrusteeType = TRUSTEE_IS_GROUP;
    access.Trustee.ptstrName = reinterpret_cast<LPWSTR>(sid);

    PACL dacl = nullptr;
    DWORD rc = SetEntriesInAclW(1, &access, baseDefaultDacl, &dacl);
    if (rc != ERROR_SUCCESS) {
        fail(std::wstring(L"cannot build ") + context + L" DACL: " + win32Message(rc));
        return nullptr;
    }
    return dacl;
}

static bool sidAlreadyListed(const std::vector<SID_AND_ATTRIBUTES>& sids, PSID sid) {
    if (!sid) return true;
    return std::any_of(sids.begin(), sids.end(), [sid](const SID_AND_ATTRIBUTES& existing) {
        return existing.Sid && EqualSid(existing.Sid, sid);
    });
}

static bool appendRestrictingSid(std::vector<SID_AND_ATTRIBUTES>& sids, PSID sid) {
    if (!sid || sidAlreadyListed(sids, sid)) return true;
    SID_AND_ATTRIBUTES attr = {};
    attr.Sid = sid;
    attr.Attributes = 0;
    sids.push_back(attr);
    return true;
}

static bool appendRestrictingSid(
    std::vector<SID_AND_ATTRIBUTES>& sids,
    const std::wstring& sidString,
    std::vector<PSID>& ownedSids
) {
    PSID sid = nullptr;
    if (!ConvertStringSidToSidW(sidString.c_str(), &sid)) {
        fail(L"cannot create restricting SID " + sidString + L": " + win32Message(GetLastError()));
        return false;
    }
    if (sidAlreadyListed(sids, sid)) {
        LocalFree(sid);
        return true;
    }
    ownedSids.push_back(sid);
    return appendRestrictingSid(sids, sid);
}

static void freeOwnedSids(std::vector<PSID>& sids) {
    for (PSID sid : sids) {
        if (sid) LocalFree(sid);
    }
    sids.clear();
}

static PSID copySidToLocalAlloc(PSID source) {
    if (!source || !IsValidSid(source)) return nullptr;
    DWORD length = GetLengthSid(source);
    PSID copy = LocalAlloc(LMEM_FIXED, length);
    if (!copy) return nullptr;
    if (!CopySid(length, copy, source)) {
        LocalFree(copy);
        return nullptr;
    }
    return copy;
}

static PSID copyCurrentLogonSid(HANDLE token) {
    DWORD needed = 0;
    GetTokenInformation(token, TokenGroups, nullptr, 0, &needed);
    if (needed == 0 && GetLastError() != ERROR_INSUFFICIENT_BUFFER) {
        fail(L"GetTokenInformation(TokenGroups) size failed: " + win32Message(GetLastError()));
        return nullptr;
    }

    std::vector<BYTE> buffer(needed, 0);
    if (!GetTokenInformation(token, TokenGroups, buffer.data(), needed, &needed)) {
        fail(L"GetTokenInformation(TokenGroups) failed: " + win32Message(GetLastError()));
        return nullptr;
    }

    auto* groups = reinterpret_cast<TOKEN_GROUPS*>(buffer.data());
    for (DWORD i = 0; groups && i < groups->GroupCount; i++) {
        SID_AND_ATTRIBUTES& group = groups->Groups[i];
        if ((group.Attributes & SE_GROUP_LOGON_ID) != SE_GROUP_LOGON_ID) continue;
        if ((group.Attributes & SE_GROUP_ENABLED) != SE_GROUP_ENABLED) {
            fail(L"current logon SID is not enabled in TokenGroups");
            return nullptr;
        }
        PSID copy = copySidToLocalAlloc(group.Sid);
        if (!copy) fail(L"cannot copy current logon SID");
        return copy;
    }

    fail(L"current logon SID was not present in TokenGroups");
    return nullptr;
}

static bool appendEveryoneRestrictingSid(
    std::vector<SID_AND_ATTRIBUTES>& sids,
    std::vector<PSID>& ownedSids,
    PSID& everyoneSid
) {
    PSID sid = nullptr;
    if (!ConvertStringSidToSidW(EVERYONE_SID, &sid)) {
        fail(L"cannot create Everyone restricting SID: " + win32Message(GetLastError()));
        return false;
    }
    ownedSids.push_back(sid);
    everyoneSid = sid;
    return appendRestrictingSid(sids, sid);
}

static bool appendCurrentLogonRestrictingSid(
    std::vector<SID_AND_ATTRIBUTES>& sids,
    HANDLE token,
    std::vector<PSID>& ownedSids,
    PSID& logonSidOut
) {
    PSID logonSid = copyCurrentLogonSid(token);
    if (!logonSid) return false;
    ownedSids.push_back(logonSid);
    logonSidOut = logonSid;
    return appendRestrictingSid(sids, logonSid);
}

static bool buildRestrictingSids(
    const std::vector<WritableRoot>& roots,
    HANDLE baseToken,
    std::vector<SID_AND_ATTRIBUTES>& restrictingSids,
    std::vector<PSID>& ownedRestrictingSids,
    PSID& everyoneSid,
    PSID& logonSid
) {
    if (!appendEveryoneRestrictingSid(restrictingSids, ownedRestrictingSids, everyoneSid)) return false;
    if (!appendCurrentLogonRestrictingSid(restrictingSids, baseToken, ownedRestrictingSids, logonSid)) return false;
    for (const auto& root : roots) {
        if (!root.sid) continue;
        appendRestrictingSid(restrictingSids, root.sid);
    }
    if (!appendRestrictingSid(restrictingSids, WRITE_RESTRICTED_CODE_SID, ownedRestrictingSids)) return false;
    if (restrictingSids.empty()) {
        fail(L"no restricting SIDs available for restricted token");
        return false;
    }
    return true;
}

static bool enableTokenPrivilege(HANDLE token, const wchar_t* privilegeName) {
    LUID luid = {};
    if (!LookupPrivilegeValueW(nullptr, privilegeName, &luid)) {
        fail(std::wstring(L"LookupPrivilegeValueW(") + privilegeName + L") failed: " +
             win32Message(GetLastError()));
        return false;
    }
    TOKEN_PRIVILEGES privileges = {};
    privileges.PrivilegeCount = 1;
    privileges.Privileges[0].Luid = luid;
    privileges.Privileges[0].Attributes = SE_PRIVILEGE_ENABLED;
    SetLastError(ERROR_SUCCESS);
    if (!AdjustTokenPrivileges(token, FALSE, &privileges, 0, nullptr, nullptr)) {
        fail(std::wstring(L"AdjustTokenPrivileges(") + privilegeName + L") failed: " +
             win32Message(GetLastError()));
        return false;
    }
    const DWORD errorCode = GetLastError();
    if (errorCode != ERROR_SUCCESS) {
        fail(std::wstring(L"AdjustTokenPrivileges(") + privilegeName + L") was incomplete: " +
             win32Message(errorCode));
        return false;
    }
    return true;
}

static HANDLE createRestrictedWriteToken(const std::vector<WritableRoot>& roots) {
    HANDLE baseToken = nullptr;
    DWORD desired = TOKEN_DUPLICATE | TOKEN_ASSIGN_PRIMARY | TOKEN_QUERY | TOKEN_IMPERSONATE |
        TOKEN_ADJUST_DEFAULT | TOKEN_ADJUST_SESSIONID | TOKEN_ADJUST_PRIVILEGES;
    if (!OpenProcessToken(GetCurrentProcess(), desired, &baseToken)) {
        fail(L"OpenProcessToken failed: " + win32Message(GetLastError()));
        return nullptr;
    }
    std::vector<SID_AND_ATTRIBUTES> restrictingSids;
    std::vector<PSID> ownedRestrictingSids;
    PSID everyoneSid = nullptr;
    PSID logonSid = nullptr;
    if (!buildRestrictingSids(
        roots,
        baseToken,
        restrictingSids,
        ownedRestrictingSids,
        everyoneSid,
        logonSid
    )) {
        CloseHandle(baseToken);
        freeOwnedSids(ownedRestrictingSids);
        return nullptr;
    }

    HANDLE restrictedToken = nullptr;
    DWORD flags = DISABLE_MAX_PRIVILEGE | LUA_TOKEN | WRITE_RESTRICTED;
    BOOL ok = CreateRestrictedToken(
        baseToken,
        flags,
        0,
        nullptr,
        0,
        nullptr,
        static_cast<DWORD>(restrictingSids.size()),
        restrictingSids.data(),
        &restrictedToken
    );
    CloseHandle(baseToken);
    if (!ok) {
        freeOwnedSids(ownedRestrictingSids);
        fail(L"CreateRestrictedToken failed: " + win32Message(GetLastError()));
        return nullptr;
    }

    PACL defaultDacl = buildTokenDefaultDacl(
        roots,
        everyoneSid,
        logonSid,
        GENERIC_ALL
    );
    if (!defaultDacl) {
        freeOwnedSids(ownedRestrictingSids);
        CloseHandle(restrictedToken);
        return nullptr;
    }
    TOKEN_DEFAULT_DACL info = {};
    info.DefaultDacl = defaultDacl;
    if (!SetTokenInformation(restrictedToken, TokenDefaultDacl, &info, sizeof(info))) {
        const DWORD errorCode = GetLastError();
        LocalFree(defaultDacl);
        freeOwnedSids(ownedRestrictingSids);
        CloseHandle(restrictedToken);
        fail(L"SetTokenInformation(TokenDefaultDacl) failed: " + win32Message(errorCode));
        return nullptr;
    }
    LocalFree(defaultDacl);
    freeOwnedSids(ownedRestrictingSids);

    if (!enableTokenPrivilege(restrictedToken, SE_CHANGE_NOTIFY_NAME)) {
        CloseHandle(restrictedToken);
        return nullptr;
    }

    return restrictedToken;
}

static HANDLE createKillOnCloseJob() {
    HANDLE job = CreateJobObjectW(nullptr, nullptr);
    if (!job) return nullptr;
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION info = {};
    info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &info, sizeof(info))) {
        CloseHandle(job);
        return nullptr;
    }
    return job;
}

static bool waitForJobEmpty(HANDLE job, DWORD timeoutMs, DWORD* errorOut) {
    const ULONGLONG deadline = GetTickCount64() + timeoutMs;
    while (true) {
        JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info = {};
        if (!QueryInformationJobObject(
            job,
            JobObjectBasicAccountingInformation,
            &info,
            sizeof(info),
            nullptr
        )) {
            if (errorOut) *errorOut = GetLastError();
            return false;
        }
        if (info.ActiveProcesses == 0) {
            if (errorOut) *errorOut = ERROR_SUCCESS;
            return true;
        }
        const ULONGLONG now = GetTickCount64();
        if (now >= deadline) {
            if (errorOut) *errorOut = ERROR_TIMEOUT;
            return false;
        }
        const DWORD remaining = static_cast<DWORD>(std::min<ULONGLONG>(deadline - now, 10));
        Sleep(remaining);
    }
}

static bool generatePrivateDesktopName(std::wstring& name) {
    BYTE randomBytes[16] = {};
    const NTSTATUS status = BCryptGenRandom(
        nullptr,
        randomBytes,
        static_cast<ULONG>(sizeof(randomBytes)),
        BCRYPT_USE_SYSTEM_PREFERRED_RNG
    );
    if (status < 0) {
        fail(L"BCryptGenRandom for private desktop name failed: " +
             hexDword(static_cast<DWORD>(status)));
        return false;
    }

    static const wchar_t HEX_DIGITS[] = L"0123456789abcdef";
    std::wstring suffix;
    suffix.reserve(sizeof(randomBytes) * 2);
    for (BYTE value : randomBytes) {
        suffix.push_back(HEX_DIGITS[value >> 4]);
        suffix.push_back(HEX_DIGITS[value & 0x0f]);
    }
    name = L"luc-win-sandbox-desktop-" + suffix;
    return true;
}

static bool createSandboxDesktop(SandboxDesktop& desktop) {
    if (!generatePrivateDesktopName(desktop.desktopName)) return false;

    HANDLE processToken = nullptr;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &processToken)) {
        fail(L"OpenProcessToken for desktop DACL failed: " + win32Message(GetLastError()));
        return false;
    }

    TokenDefaultDaclSnapshot baseDefaultDacl;
    if (!queryTokenDefaultDacl(processToken, baseDefaultDacl)) {
        CloseHandle(processToken);
        fail(L"cannot preserve the token default DACL for sandbox USER objects");
        return false;
    }
    PSID logonSid = copyCurrentLogonSid(processToken);
    CloseHandle(processToken);
    if (!logonSid) return false;

    PACL desktopDacl = buildDaclForSid(
        logonSid,
        baseDefaultDacl.dacl,
        SANDBOX_DESKTOP_ACCESS,
        L"sandbox desktop"
    );
    LocalFree(logonSid);
    if (!desktopDacl) return false;

    SECURITY_DESCRIPTOR desktopDescriptor = {};
    if (!InitializeSecurityDescriptor(&desktopDescriptor, SECURITY_DESCRIPTOR_REVISION) ||
        !SetSecurityDescriptorDacl(&desktopDescriptor, TRUE, desktopDacl, FALSE)) {
        DWORD err = GetLastError();
        LocalFree(desktopDacl);
        fail(L"cannot initialize sandbox desktop descriptor: " + win32Message(err));
        return false;
    }

    desktop.stationName = L"WinSta0";
    desktop.qualifiedName = desktop.stationName + L"\\" + desktop.desktopName;
    SECURITY_ATTRIBUTES desktopAttributes = {};
    desktopAttributes.nLength = sizeof(desktopAttributes);
    desktopAttributes.lpSecurityDescriptor = &desktopDescriptor;
    desktopAttributes.bInheritHandle = FALSE;

    desktop.station = OpenWindowStationW(
        desktop.stationName.c_str(),
        FALSE,
        SANDBOX_WINDOW_STATION_ACCESS
    );
    if (!desktop.station) {
        DWORD errorCode = GetLastError();
        LocalFree(desktopDacl);
        fail(L"OpenWindowStationW(WinSta0) failed: " + win32Message(errorCode));
        return false;
    }

    HWINSTA originalStation = GetProcessWindowStation();
    if (!originalStation || !SetProcessWindowStation(desktop.station)) {
        DWORD errorCode = GetLastError();
        CloseWindowStation(desktop.station);
        desktop.station = nullptr;
        LocalFree(desktopDacl);
        fail(L"cannot enter WinSta0 for private desktop creation: " + win32Message(errorCode));
        return false;
    }

    desktop.handle = CreateDesktopW(
        desktop.desktopName.c_str(),
        nullptr,
        nullptr,
        0,
        SANDBOX_DESKTOP_ACCESS,
        &desktopAttributes
    );
    DWORD createDesktopError = desktop.handle ? ERROR_SUCCESS : GetLastError();
    BOOL restoredStation = SetProcessWindowStation(originalStation);
    DWORD restoreStationError = restoredStation ? ERROR_SUCCESS : GetLastError();
    LocalFree(desktopDacl);
    if (!desktop.handle) {
        CloseWindowStation(desktop.station);
        desktop.station = nullptr;
        fail(L"CreateDesktopW failed: " + win32Message(createDesktopError));
        return false;
    }
    if (!restoredStation) {
        CloseDesktop(desktop.handle);
        desktop.handle = nullptr;
        fail(L"cannot restore process window station: " + win32Message(restoreStationError));
        return false;
    }
    return true;
}

static void closeSandboxDesktop(SandboxDesktop& desktop) {
    if (desktop.handle) CloseDesktop(desktop.handle);
    desktop.handle = nullptr;
    if (desktop.station) CloseWindowStation(desktop.station);
    desktop.station = nullptr;
    desktop.stationName.clear();
    desktop.desktopName.clear();
    desktop.qualifiedName.clear();
}

static std::wstring probeNamedObjectNamespace(HANDLE restrictedToken);

static void revertImpersonationOrTerminate() {
    if (RevertToSelf()) return;
    const DWORD rc = GetLastError();
    std::wcerr
        << L"luc-win-sandbox: impersonation-revert-failure-v1"
        << L" error=\"" << rc << L"\""
        << L" errorHex=\"" << hexDword(rc) << L"\""
        << std::endl;
    ExitProcess(HELPER_LAUNCH_FAILED_EXIT_CODE);
}

static std::wstring probeRestrictedDesktopAccess(HANDLE restrictedToken, const SandboxDesktop& sandbox) {
    if (sandbox.stationName.empty() || sandbox.desktopName.empty()) return L"skipped:no-desktop";
    if (!ImpersonateLoggedOnUser(restrictedToken)) {
        DWORD rc = GetLastError();
        return L"impersonate-failed:" + std::to_wstring(rc) + L":" + win32Message(rc);
    }

    HWINSTA station = OpenWindowStationW(
        sandbox.stationName.c_str(),
        FALSE,
        SANDBOX_WINDOW_STATION_ACCESS
    );
    if (!station) {
        DWORD rc = GetLastError();
        revertImpersonationOrTerminate();
        return L"station-error:" + std::to_wstring(rc) + L":" + win32Message(rc);
    }
    HWINSTA originalStation = GetProcessWindowStation();
    if (!originalStation || !SetProcessWindowStation(station)) {
        DWORD rc = GetLastError();
        CloseWindowStation(station);
        revertImpersonationOrTerminate();
        return L"station-switch-error:" + std::to_wstring(rc) + L":" + win32Message(rc);
    }
    HDESK desktop = OpenDesktopW(
        sandbox.desktopName.c_str(),
        0,
        FALSE,
        SANDBOX_DESKTOP_ACCESS
    );
    DWORD rc = desktop ? ERROR_SUCCESS : GetLastError();
    if (desktop) CloseDesktop(desktop);
    const BOOL restoredStation = SetProcessWindowStation(originalStation);
    const DWORD restoreError = restoredStation ? ERROR_SUCCESS : GetLastError();
    if (restoredStation) CloseWindowStation(station);
    revertImpersonationOrTerminate();

    if (!restoredStation) {
        return L"restore-error:" + std::to_wstring(restoreError) + L":" + win32Message(restoreError);
    }
    if (rc == ERROR_SUCCESS) return L"ok";
    return L"error:" + std::to_wstring(rc) + L":" + win32Message(rc);
}

static bool queryUserObjectName(HANDLE object, std::wstring& name) {
    name.clear();
    if (!object) {
        SetLastError(ERROR_INVALID_HANDLE);
        return false;
    }
    DWORD needed = 0;
    GetUserObjectInformationW(object, UOI_NAME, nullptr, 0, &needed);
    if (needed == 0) return false;

    std::vector<wchar_t> buffer((needed / sizeof(wchar_t)) + 1, L'\0');
    if (!GetUserObjectInformationW(
        object,
        UOI_NAME,
        buffer.data(),
        static_cast<DWORD>(buffer.size() * sizeof(wchar_t)),
        &needed
    )) {
        return false;
    }
    name.assign(buffer.data());
    if (name.empty()) {
        SetLastError(ERROR_INVALID_NAME);
        return false;
    }
    return true;
}

static bool resolveCurrentDesktop(SandboxDesktop& desktop) {
    HWINSTA station = GetProcessWindowStation();
    HDESK threadDesktop = GetThreadDesktop(GetCurrentThreadId());
    if (!station || !threadDesktop) return false;
    if (!queryUserObjectName(station, desktop.stationName)) return false;
    if (!queryUserObjectName(threadDesktop, desktop.desktopName)) return false;
    desktop.qualifiedName = desktop.stationName + L"\\" + desktop.desktopName;
    return true;
}

static std::wstring probeProcessWindowStationName() {
    std::wstring name;
    if (!queryUserObjectName(GetProcessWindowStation(), name)) {
        DWORD rc = GetLastError();
        return L"error:" + std::to_wstring(rc) + L":" + win32Message(rc);
    }
    return L"ok:" + name;
}

static void emitCreateProcessLaunchFailureDiagnostic(
    const Options& opts,
    HANDLE restrictedToken,
    const SandboxDesktop& desktop,
    const std::wstring& commandLine,
    DWORD errorCode,
    DWORD flags,
    BOOL inheritHandles,
    size_t inheritedHandleCount
) {
    fail(L"CreateProcessAsUserW failed: " + win32Message(errorCode));
    std::wcerr
        << L"luc-win-sandbox: launch-failure"
        << L" error=\"" << errorCode << L"\""
        << L" errorHex=\"" << hexDword(errorCode) << L"\""
        << L" message=\"" << escapeDiagnosticValue(win32Message(errorCode)) << L"\""
        << std::endl;
    std::wcerr
        << L"luc-win-sandbox: launch-failure-context"
        << L" executablePresent=\"" << boolDiagnosticValue(!opts.executable.empty()) << L"\""
        << L" executableLength=\"" << opts.executable.size() << L"\""
        << L" cwdPresent=\"" << boolDiagnosticValue(!opts.cwd.empty()) << L"\""
        << L" cwdLength=\"" << opts.cwd.size() << L"\""
        << L" argumentCount=\"" << opts.args.size() << L"\""
        << L" commandLineLength=\"" << commandLine.size() << L"\""
        << L" desktop=\"" << escapeDiagnosticValue(desktop.qualifiedName) << L"\""
        << L" flags=\"" << flags << L"\""
        << L" flagsHex=\"" << hexDword(flags) << L"\""
        << L" inheritHandles=\"" << boolDiagnosticValue(inheritHandles != FALSE) << L"\""
        << L" inheritedHandleCount=\"" << inheritedHandleCount << L"\""
        << std::endl;
    std::wcerr
        << L"luc-win-sandbox: launch-failure-probes"
        << L" desktopProbe=\"" << escapeDiagnosticValue(probeRestrictedDesktopAccess(restrictedToken, desktop)) << L"\""
        << L" windowStation=\"" << escapeDiagnosticValue(probeProcessWindowStationName()) << L"\""
        << L" namedObjectsProbe=\"" << escapeDiagnosticValue(probeNamedObjectNamespace(restrictedToken)) << L"\""
        << std::endl;
}

static void emitPrelaunchDesktopProbeDiagnostic(const std::wstring& desktopProbe) {
    debug(
        L"prelaunch-probe-v1 desktopProbe=\"" +
        escapeDiagnosticValue(desktopProbe) +
        L"\""
    );
}

static void emitPrelaunchDesktopProbeFailureDiagnostic(const std::wstring& desktopProbe) {
    std::wcerr
        << L"luc-win-sandbox: prelaunch-probe-failure-v1"
        << L" desktopProbe=\"" << escapeDiagnosticValue(desktopProbe) << L"\""
        << std::endl;
}

static void emitPostCreateEarlyExitDiagnostic(
    DWORD exitCode,
    ULONGLONG elapsedMs,
    const std::wstring& prelaunchDesktopProbe
) {
    if (elapsedMs > EARLY_EXIT_DIAGNOSTIC_WINDOW_MS) return;

    const wchar_t* classification = nullptr;
    if (exitCode == STATUS_DLL_INIT_FAILED_EXIT_CODE) {
        classification = L"dll-init-failure";
    } else if ((exitCode & 0xC0000000UL) == 0xC0000000UL) {
        classification = L"nt-status-failure";
    } else {
        return;
    }

    std::wcerr
        << L"luc-win-sandbox: post-create-exit-v1"
        << L" exitCode=\"" << exitCode << L"\""
        << L" exitCodeHex=\"" << hexDword(exitCode) << L"\""
        << L" classification=\"" << classification << L"\""
        << L" elapsedMs=\"" << elapsedMs << L"\""
        << L" prelaunchDesktopProbe=\"" << escapeDiagnosticValue(prelaunchDesktopProbe) << L"\""
        << std::endl;
}

static std::wstring processImageBasename(DWORD processId) {
    HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, processId);
    if (!process) return L"unavailable:" + std::to_wstring(GetLastError());

    std::vector<wchar_t> image(32768, L'\0');
    DWORD length = static_cast<DWORD>(image.size());
    if (!QueryFullProcessImageNameW(process, 0, image.data(), &length)) {
        const DWORD errorCode = GetLastError();
        CloseHandle(process);
        return L"unavailable:" + std::to_wstring(errorCode);
    }
    CloseHandle(process);

    std::wstring fullPath(image.data(), length);
    const size_t separator = fullPath.find_last_of(L"\\/");
    return separator == std::wstring::npos ? fullPath : fullPath.substr(separator + 1);
}

static void emitTimeoutProcessSnapshot(HANDLE job) {
    constexpr size_t MAX_REPORTED_PROCESSES = 128;
    const DWORD bufferSize = static_cast<DWORD>(
        sizeof(JOBOBJECT_BASIC_PROCESS_ID_LIST) +
        (MAX_REPORTED_PROCESSES - 1) * sizeof(ULONG_PTR)
    );
    std::vector<BYTE> buffer(bufferSize, 0);
    auto* processes = reinterpret_cast<JOBOBJECT_BASIC_PROCESS_ID_LIST*>(buffer.data());
    if (!QueryInformationJobObject(
        job,
        JobObjectBasicProcessIdList,
        processes,
        bufferSize,
        nullptr
    )) {
        const DWORD errorCode = GetLastError();
        std::wcerr
            << L"luc-win-sandbox: timeout-processes-v1"
            << L" queryError=\"" << errorCode << L"\""
            << std::endl;
        return;
    }

    std::wstring summary;
    const ULONG_PTR count = std::min<ULONG_PTR>(
        processes->NumberOfProcessIdsInList,
        MAX_REPORTED_PROCESSES
    );
    for (ULONG_PTR i = 0; i < count; i++) {
        if (!summary.empty()) summary += L",";
        const DWORD processId = static_cast<DWORD>(processes->ProcessIdList[i]);
        summary += std::to_wstring(processId);
        summary += L":";
        summary += processImageBasename(processId);
    }
    std::wcerr
        << L"luc-win-sandbox: timeout-processes-v1"
        << L" assigned=\"" << processes->NumberOfAssignedProcesses << L"\""
        << L" listed=\"" << processes->NumberOfProcessIdsInList << L"\""
        << L" processes=\"" << escapeDiagnosticValue(summary) << L"\""
        << std::endl;
}

static bool isValidInheritableCandidate(HANDLE handle) {
    return handle && handle != INVALID_HANDLE_VALUE;
}

static void pushUniqueHandle(std::vector<HANDLE>& handles, HANDLE handle) {
    if (!isValidInheritableCandidate(handle)) return;
    if (std::find(handles.begin(), handles.end(), handle) == handles.end()) {
        handles.push_back(handle);
    }
}

static bool setupStartupAttributeList(
    const std::vector<HANDLE>& handles,
    HANDLE job,
    StartupAttributeList& attributes
) {
    for (HANDLE handle : handles) {
        if (!SetHandleInformation(handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT)) {
            fail(L"SetHandleInformation(HANDLE_FLAG_INHERIT) failed: " +
                 win32Message(GetLastError()));
            return false;
        }
    }
    const bool hasJob = isValidInheritableCandidate(job);
    const DWORD attributeCount = (handles.empty() ? 0 : 1) + (hasJob ? 1 : 0);
    if (attributeCount == 0) return true;
    SIZE_T size = 0;
    InitializeProcThreadAttributeList(nullptr, attributeCount, 0, &size);
    if (size == 0) {
        fail(L"InitializeProcThreadAttributeList size failed: " + win32Message(GetLastError()));
        return false;
    }
    attributes.list = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(
        HeapAlloc(GetProcessHeap(), 0, size)
    );
    if (!attributes.list) {
        fail(L"HeapAlloc for process attribute list failed");
        return false;
    }
    if (!InitializeProcThreadAttributeList(attributes.list, attributeCount, 0, &size)) {
        fail(L"InitializeProcThreadAttributeList failed: " + win32Message(GetLastError()));
        return false;
    }
    if (!handles.empty()) {
        attributes.inheritedHandles = handles;
        if (!UpdateProcThreadAttribute(
            attributes.list,
            0,
            PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
            attributes.inheritedHandles.data(),
            attributes.inheritedHandles.size() * sizeof(HANDLE),
            nullptr,
            nullptr
        )) {
            fail(L"UpdateProcThreadAttribute(PROC_THREAD_ATTRIBUTE_HANDLE_LIST) failed: " + win32Message(GetLastError()));
            return false;
        }
    }
    if (hasJob) {
        attributes.jobs.push_back(job);
        if (!UpdateProcThreadAttribute(
            attributes.list,
            0,
            PROC_THREAD_ATTRIBUTE_JOB_LIST,
            attributes.jobs.data(),
            attributes.jobs.size() * sizeof(HANDLE),
            nullptr,
            nullptr
        )) {
            fail(L"UpdateProcThreadAttribute(PROC_THREAD_ATTRIBUTE_JOB_LIST) failed: " + win32Message(GetLastError()));
            return false;
        }
    }
    return true;
}

static bool setupInheritedHandleList(const std::vector<HANDLE>& handles, StartupAttributeList& attributes) {
    return setupStartupAttributeList(handles, nullptr, attributes);
}

static void freeStartupAttributeList(StartupAttributeList& attributes) {
    if (attributes.list) {
        DeleteProcThreadAttributeList(attributes.list);
        HeapFree(GetProcessHeap(), 0, attributes.list);
    }
    attributes.list = nullptr;
    attributes.inheritedHandles.clear();
    attributes.jobs.clear();
}

static bool snapshotCurrentEnvironment(std::vector<wchar_t>& environment) {
    LPWCH rawEnvironment = GetEnvironmentStringsW();
    if (!rawEnvironment) {
        const DWORD errorCode = GetLastError();
        fail(L"GetEnvironmentStringsW failed: " + win32Message(errorCode));
        SetLastError(errorCode);
        return false;
    }
    const wchar_t* begin = rawEnvironment;
    const wchar_t* end = begin;
    while (*end != L'\0') {
        end += wcslen(end) + 1;
    }
    ++end;
    environment.assign(begin, end);
    FreeEnvironmentStringsW(rawEnvironment);
    return true;
}

static DWORD WINAPI readGuardianControl(LPVOID rawContext) {
    auto* watch = reinterpret_cast<GuardianControlWatch*>(rawContext);
    char buffer[64] = {};
    DWORD bytesRead = 0;
    if (!ReadFile(watch->input, buffer, sizeof(buffer), &bytesRead, nullptr)) {
        watch->readError = GetLastError();
    }
    // Any command, EOF, or pipe error means the owner no longer wants this Job.
    SetEvent(watch->event);
    return 0;
}

static GuardianControlWatch* startGuardianControlWatch(HANDLE input) {
    auto* watch = new GuardianControlWatch();
    watch->input = input;
    watch->event = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    if (!watch->event) {
        const DWORD errorCode = GetLastError();
        delete watch;
        SetLastError(errorCode);
        return nullptr;
    }
    watch->thread = CreateThread(nullptr, 0, readGuardianControl, watch, 0, nullptr);
    if (!watch->thread) {
        const DWORD errorCode = GetLastError();
        CloseHandle(watch->event);
        delete watch;
        SetLastError(errorCode);
        return nullptr;
    }
    return watch;
}

static bool stopGuardianControlWatch(GuardianControlWatch* watch) {
    if (!watch) return true;
    DWORD threadState = WaitForSingleObject(watch->thread, 0);
    if (threadState == WAIT_TIMEOUT) {
        if (!CancelSynchronousIo(watch->thread)) {
            const DWORD errorCode = GetLastError();
            if (errorCode != ERROR_NOT_FOUND) {
                debug(L"guardian control ReadFile cancellation failed: " + win32Message(errorCode));
            }
        }
        threadState = WaitForSingleObject(watch->thread, TERMINATION_GRACE_MS);
    }
    if (threadState != WAIT_OBJECT_0) {
        // The helper process is about to exit, but the context/event must remain valid
        // until then because the reader may still complete asynchronously.
        fail(L"guardian control reader did not stop before helper exit");
        return false;
    }
    CloseHandle(watch->thread);
    CloseHandle(watch->event);
    delete watch;
    return true;
}

static void emitGuardianRecord(
    const std::wstring& status,
    DWORD parentPid,
    DWORD serverPid,
    DWORD win32Error = ERROR_SUCCESS
) {
    std::wcerr
        << L"luc-win-sandbox: guardian-v1"
        << L" status=\"" << status << L"\""
        << L" parentPid=\"" << parentPid << L"\""
        << L" serverPid=\"" << serverPid << L"\""
        << L" win32Error=\"" << win32Error << L"\""
        << std::endl;
}

static int superviseServer(const Options& opts) {
    // Opening the parent once gives this guardian a stable kernel identity. A reused
    // numeric PID cannot make a different process satisfy this wait.
    HANDLE parentProcess = OpenProcess(SYNCHRONIZE, FALSE, opts.parentPid);
    if (!parentProcess) {
        const DWORD errorCode = GetLastError();
        fail(L"guardian cannot open parent process: " + win32Message(errorCode));
        emitGuardianRecord(L"parent_open_failed", opts.parentPid, 0, errorCode);
        return HELPER_LAUNCH_FAILED_EXIT_CODE;
    }

    HANDLE controlInput = GetStdHandle(STD_INPUT_HANDLE);
    if (!isValidInheritableCandidate(controlInput)) {
        const DWORD errorCode = GetLastError();
        fail(L"guardian requires a control stdin pipe");
        CloseHandle(parentProcess);
        emitGuardianRecord(L"control_pipe_missing", opts.parentPid, 0, errorCode);
        return HELPER_LAUNCH_FAILED_EXIT_CODE;
    }

    SECURITY_ATTRIBUTES nulAttributes = {};
    nulAttributes.nLength = sizeof(nulAttributes);
    nulAttributes.bInheritHandle = TRUE;
    HANDLE serverInput = CreateFileW(
        L"NUL",
        GENERIC_READ,
        FILE_SHARE_READ | FILE_SHARE_WRITE,
        &nulAttributes,
        OPEN_EXISTING,
        FILE_ATTRIBUTE_NORMAL,
        nullptr
    );
    if (serverInput == INVALID_HANDLE_VALUE) {
        const DWORD errorCode = GetLastError();
        fail(L"guardian cannot open NUL for server stdin: " + win32Message(errorCode));
        CloseHandle(parentProcess);
        emitGuardianRecord(L"server_stdio_failed", opts.parentPid, 0, errorCode);
        return HELPER_LAUNCH_FAILED_EXIT_CODE;
    }

    STARTUPINFOEXW startup = {};
    startup.StartupInfo.cb = sizeof(STARTUPINFOEXW);
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = serverInput;
    startup.StartupInfo.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
    startup.StartupInfo.hStdError = GetStdHandle(STD_ERROR_HANDLE);

    std::vector<HANDLE> inheritedHandles;
    pushUniqueHandle(inheritedHandles, startup.StartupInfo.hStdInput);
    pushUniqueHandle(inheritedHandles, startup.StartupInfo.hStdOutput);
    pushUniqueHandle(inheritedHandles, startup.StartupInfo.hStdError);
    StartupAttributeList inheritedAttributes;
    if (!setupInheritedHandleList(inheritedHandles, inheritedAttributes)) {
        const DWORD errorCode = GetLastError();
        freeStartupAttributeList(inheritedAttributes);
        CloseHandle(serverInput);
        CloseHandle(parentProcess);
        emitGuardianRecord(L"server_stdio_failed", opts.parentPid, 0, errorCode);
        return HELPER_LAUNCH_FAILED_EXIT_CODE;
    }
    startup.lpAttributeList = inheritedAttributes.list;

    std::wstring commandLine = buildCommandLine(opts);
    PROCESS_INFORMATION server = {};
    const DWORD creationFlags = CREATE_SUSPENDED | CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT;
    BOOL launched = CreateProcessW(
        opts.executable.c_str(),
        commandLine.data(),
        nullptr,
        nullptr,
        TRUE,
        creationFlags,
        nullptr,
        opts.cwd.c_str(),
        &startup.StartupInfo,
        &server
    );
    const DWORD launchError = launched ? ERROR_SUCCESS : GetLastError();
    freeStartupAttributeList(inheritedAttributes);
    CloseHandle(serverInput);
    if (!launched) {
        fail(L"guardian CreateProcessW failed: " + win32Message(launchError));
        CloseHandle(parentProcess);
        emitGuardianRecord(L"server_launch_failed", opts.parentPid, 0, launchError);
        return HELPER_LAUNCH_FAILED_EXIT_CODE;
    }

    HANDLE job = createKillOnCloseJob();
    if (!job) {
        const DWORD errorCode = GetLastError();
        fail(L"guardian CreateJobObject failed: " + win32Message(errorCode));
        TerminateProcess(server.hProcess, 1);
        CloseHandle(server.hThread);
        CloseHandle(server.hProcess);
        CloseHandle(parentProcess);
        emitGuardianRecord(L"job_create_failed", opts.parentPid, server.dwProcessId, errorCode);
        return HELPER_LAUNCH_FAILED_EXIT_CODE;
    }
    if (!AssignProcessToJobObject(job, server.hProcess)) {
        const DWORD errorCode = GetLastError();
        fail(L"guardian AssignProcessToJobObject failed: " + win32Message(errorCode));
        TerminateProcess(server.hProcess, 1);
        CloseHandle(job);
        CloseHandle(server.hThread);
        CloseHandle(server.hProcess);
        CloseHandle(parentProcess);
        emitGuardianRecord(L"job_assign_failed", opts.parentPid, server.dwProcessId, errorCode);
        return HELPER_LAUNCH_FAILED_EXIT_CODE;
    }

    GuardianControlWatch* controlWatch = startGuardianControlWatch(controlInput);
    if (!controlWatch) {
        const DWORD errorCode = GetLastError();
        fail(L"guardian cannot start control reader: " + win32Message(errorCode));
        TerminateJobObject(job, 1);
        DWORD ignored = ERROR_SUCCESS;
        waitForJobEmpty(job, TERMINATION_GRACE_MS, &ignored);
        CloseHandle(server.hThread);
        CloseHandle(server.hProcess);
        CloseHandle(parentProcess);
        CloseHandle(job);
        emitGuardianRecord(L"control_reader_failed", opts.parentPid, server.dwProcessId, errorCode);
        return HELPER_LAUNCH_FAILED_EXIT_CODE;
    }
    if (ResumeThread(server.hThread) == static_cast<DWORD>(-1)) {
        const DWORD errorCode = GetLastError();
        fail(L"guardian ResumeThread failed: " + win32Message(errorCode));
        TerminateJobObject(job, 1);
        DWORD ignored = ERROR_SUCCESS;
        waitForJobEmpty(job, TERMINATION_GRACE_MS, &ignored);
        CloseHandle(server.hThread);
        CloseHandle(server.hProcess);
        CloseHandle(parentProcess);
        CloseHandle(job);
        stopGuardianControlWatch(controlWatch);
        emitGuardianRecord(L"server_resume_failed", opts.parentPid, server.dwProcessId, errorCode);
        return HELPER_LAUNCH_FAILED_EXIT_CODE;
    }
    CloseHandle(server.hThread);
    emitGuardianRecord(L"supervising", opts.parentPid, server.dwProcessId);

    HANDLE watched[] = { parentProcess, server.hProcess, controlWatch->event };
    const DWORD waitResult = WaitForMultipleObjects(3, watched, FALSE, INFINITE);
    if (waitResult == WAIT_OBJECT_0 + 1) {
        DWORD exitCode = 1;
        const BOOL gotExitCode = GetExitCodeProcess(server.hProcess, &exitCode);
        const DWORD errorCode = gotExitCode ? ERROR_SUCCESS : GetLastError();
        CloseHandle(server.hProcess);
        CloseHandle(parentProcess);
        // The direct server has stopped. Closing the last Job handle also converges
        // descendants that inherited the Job before the guardian exits.
        CloseHandle(job);
        const bool controlStopped = stopGuardianControlWatch(controlWatch);
        if (!gotExitCode) {
            emitGuardianRecord(L"server_exit_query_failed", opts.parentPid, server.dwProcessId, errorCode);
            return HELPER_TERMINATION_FAILED_EXIT_CODE;
        }
        if (!controlStopped) {
            emitGuardianRecord(L"control_reader_stop_failed", opts.parentPid, server.dwProcessId);
            return HELPER_TERMINATION_FAILED_EXIT_CODE;
        }
        emitGuardianRecord(L"server_exited", opts.parentPid, server.dwProcessId);
        return static_cast<int>(exitCode);
    }

    std::wstring stopReason;
    DWORD waitError = ERROR_SUCCESS;
    if (waitResult == WAIT_OBJECT_0) {
        stopReason = L"parent_exited";
    } else if (waitResult == WAIT_OBJECT_0 + 2) {
        stopReason = L"control_requested";
    } else {
        stopReason = L"wait_failed";
        waitError = waitResult == WAIT_FAILED ? GetLastError() : ERROR_INVALID_FUNCTION;
        fail(L"guardian WaitForMultipleObjects failed: " + win32Message(waitError));
    }

    DWORD convergenceError = ERROR_SUCCESS;
    if (!TerminateJobObject(job, 1)) {
        convergenceError = GetLastError();
    } else if (!waitForJobEmpty(job, TERMINATION_GRACE_MS, &convergenceError)) {
        fail(L"guardian Job did not converge: " + win32Message(convergenceError));
    }
    CloseHandle(server.hProcess);
    CloseHandle(parentProcess);
    CloseHandle(job);
    const bool controlStopped = stopGuardianControlWatch(controlWatch);
    if (convergenceError != ERROR_SUCCESS) {
        emitGuardianRecord(L"termination_failed", opts.parentPid, server.dwProcessId, convergenceError);
        return HELPER_TERMINATION_FAILED_EXIT_CODE;
    }
    if (!controlStopped) {
        emitGuardianRecord(L"control_reader_stop_failed", opts.parentPid, server.dwProcessId);
        return HELPER_TERMINATION_FAILED_EXIT_CODE;
    }
    emitGuardianRecord(stopReason, opts.parentPid, server.dwProcessId, waitError);
    return waitError == ERROR_SUCCESS ? 0 : HELPER_TERMINATION_FAILED_EXIT_CODE;
}

static int runSandboxed(const Options& opts, HANDLE restrictedToken) {
    SandboxDesktop desktop;
    const bool usesPrivateDesktop = !opts.currentDesktop;
    const bool desktopReady = usesPrivateDesktop
        ? createSandboxDesktop(desktop)
        : resolveCurrentDesktop(desktop);
    if (!desktopReady) {
        DWORD errorCode = GetLastError();
        emitTerminalRecord(L"launch_failed", false, 0, opts.timeoutMs, errorCode);
        return HELPER_LAUNCH_FAILED_EXIT_CODE;
    }

    HANDLE job = createKillOnCloseJob();
    if (!job) {
        DWORD errorCode = GetLastError();
        fail(L"CreateJobObject failed: " + win32Message(errorCode));
        closeSandboxDesktop(desktop);
        emitTerminalRecord(L"launch_failed", false, 0, opts.timeoutMs, errorCode);
        return HELPER_LAUNCH_FAILED_EXIT_CODE;
    }

    STARTUPINFOEXW startup = {};
    startup.StartupInfo.cb = sizeof(STARTUPINFOW);
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
    startup.StartupInfo.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
    startup.StartupInfo.hStdError = GetStdHandle(STD_ERROR_HANDLE);
    startup.StartupInfo.lpDesktop = const_cast<LPWSTR>(desktop.qualifiedName.c_str());

    std::vector<HANDLE> inheritedHandles;
    pushUniqueHandle(inheritedHandles, startup.StartupInfo.hStdInput);
    pushUniqueHandle(inheritedHandles, startup.StartupInfo.hStdOutput);
    pushUniqueHandle(inheritedHandles, startup.StartupInfo.hStdError);
    StartupAttributeList inheritedAttributes;
    if (!setupStartupAttributeList(inheritedHandles, job, inheritedAttributes)) {
        DWORD errorCode = GetLastError();
        freeStartupAttributeList(inheritedAttributes);
        CloseHandle(job);
        closeSandboxDesktop(desktop);
        emitTerminalRecord(L"launch_failed", false, 0, opts.timeoutMs, errorCode);
        return HELPER_LAUNCH_FAILED_EXIT_CODE;
    }
    startup.lpAttributeList = inheritedAttributes.list;

    std::wstring commandLine = buildCommandLine(opts);
    std::vector<wchar_t> environmentBlock;
    if (!snapshotCurrentEnvironment(environmentBlock)) {
        freeStartupAttributeList(inheritedAttributes);
        CloseHandle(job);
        closeSandboxDesktop(desktop);
        DWORD errorCode = GetLastError();
        emitTerminalRecord(L"launch_failed", false, 0, opts.timeoutMs, errorCode);
        return HELPER_LAUNCH_FAILED_EXIT_CODE;
    }
    PROCESS_INFORMATION process = {};
    DWORD flags = CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT;
    BOOL inheritHandles = FALSE;
    if (startup.lpAttributeList) {
        startup.StartupInfo.cb = sizeof(STARTUPINFOEXW);
        flags |= EXTENDED_STARTUPINFO_PRESENT;
        inheritHandles = TRUE;
    }
    const std::wstring prelaunchDesktopProbe = probeRestrictedDesktopAccess(restrictedToken, desktop);
    emitPrelaunchDesktopProbeDiagnostic(prelaunchDesktopProbe);
    if (prelaunchDesktopProbe != L"ok") {
        emitPrelaunchDesktopProbeFailureDiagnostic(prelaunchDesktopProbe);
        freeStartupAttributeList(inheritedAttributes);
        CloseHandle(job);
        closeSandboxDesktop(desktop);
        emitTerminalRecord(L"launch_failed", false, 0, opts.timeoutMs, ERROR_ACCESS_DENIED);
        return HELPER_LAUNCH_FAILED_EXIT_CODE;
    }
    const ULONGLONG processCreatedAt = GetTickCount64();
    BOOL ok = CreateProcessAsUserW(
        restrictedToken,
        opts.executable.c_str(),
        commandLine.data(),
        nullptr,
        nullptr,
        inheritHandles,
        flags,
        environmentBlock.data(),
        opts.cwd.c_str(),
        &startup.StartupInfo,
        &process
    );
    freeStartupAttributeList(inheritedAttributes);

    if (!ok) {
        DWORD errorCode = GetLastError();
        emitCreateProcessLaunchFailureDiagnostic(
            opts,
            restrictedToken,
            desktop,
            commandLine,
            errorCode,
            flags,
            inheritHandles,
            inheritedHandles.size()
        );
        CloseHandle(job);
        closeSandboxDesktop(desktop);
        emitTerminalRecord(L"launch_failed", false, 0, opts.timeoutMs, errorCode);
        return HELPER_LAUNCH_FAILED_EXIT_CODE;
    }

    const DWORD waitMs = opts.timeoutMs > 0 ? opts.timeoutMs : INFINITE;
    const DWORD waitResult = WaitForSingleObject(process.hProcess, waitMs);
    if (waitResult == WAIT_OBJECT_0) {
        DWORD exitCode = 1;
        if (!GetExitCodeProcess(process.hProcess, &exitCode)) {
            DWORD errorCode = GetLastError();
            CloseHandle(process.hThread);
            CloseHandle(process.hProcess);
            CloseHandle(job);
            closeSandboxDesktop(desktop);
            emitTerminalRecord(L"termination_failed", false, 0, opts.timeoutMs, errorCode);
            return HELPER_TERMINATION_FAILED_EXIT_CODE;
        }
        emitPostCreateEarlyExitDiagnostic(
            exitCode,
            GetTickCount64() - processCreatedAt,
            prelaunchDesktopProbe
        );
        CloseHandle(process.hThread);
        CloseHandle(process.hProcess);
        // KILL_ON_JOB_CLOSE preserves the existing contract: descendants cannot outlive
        // the command even when the direct child exits before inherited stdio closes.
        CloseHandle(job);
        closeSandboxDesktop(desktop);
        emitTerminalRecord(L"exited", true, exitCode, opts.timeoutMs);
        return static_cast<int>(exitCode);
    }

    if (waitResult == WAIT_TIMEOUT) {
        emitTimeoutProcessSnapshot(job);
        if (!TerminateJobObject(job, TIMEOUT_PROCESS_EXIT_CODE)) {
            DWORD errorCode = GetLastError();
            fail(L"TerminateJobObject failed: " + win32Message(errorCode));
            CloseHandle(process.hThread);
            CloseHandle(process.hProcess);
            CloseHandle(job);
            closeSandboxDesktop(desktop);
            emitTerminalRecord(L"termination_failed", false, 0, opts.timeoutMs, errorCode);
            return HELPER_TERMINATION_FAILED_EXIT_CODE;
        }

        DWORD convergenceError = ERROR_SUCCESS;
        const bool converged = waitForJobEmpty(job, TERMINATION_GRACE_MS, &convergenceError);
        CloseHandle(process.hThread);
        CloseHandle(process.hProcess);
        CloseHandle(job);
        closeSandboxDesktop(desktop);
        if (!converged) {
            fail(L"sandbox Job did not converge after timeout: " + win32Message(convergenceError));
            emitTerminalRecord(L"termination_failed", false, 0, opts.timeoutMs, convergenceError);
            return HELPER_TERMINATION_FAILED_EXIT_CODE;
        }
        emitTerminalRecord(L"timed_out", true, TIMEOUT_PROCESS_EXIT_CODE, opts.timeoutMs);
        return static_cast<int>(TIMEOUT_PROCESS_EXIT_CODE);
    }

    DWORD waitError = waitResult == WAIT_FAILED ? GetLastError() : ERROR_INVALID_FUNCTION;
    fail(L"WaitForSingleObject failed: " + win32Message(waitError));
    if (TerminateJobObject(job, 1)) {
        DWORD ignored = ERROR_SUCCESS;
        waitForJobEmpty(job, TERMINATION_GRACE_MS, &ignored);
    }
    CloseHandle(process.hThread);
    CloseHandle(process.hProcess);
    CloseHandle(job);
    closeSandboxDesktop(desktop);
    emitTerminalRecord(L"termination_failed", false, 0, opts.timeoutMs, waitError);
    return HELPER_TERMINATION_FAILED_EXIT_CODE;
}

static bool stringStartsWith(const std::wstring& value, const std::wstring& prefix) {
    return value.size() >= prefix.size() && value.compare(0, prefix.size(), prefix) == 0;
}

static bool isDigitsOnly(const std::wstring& value) {
    if (value.empty()) return false;
    return std::all_of(value.begin(), value.end(), [](wchar_t ch) {
        return ch >= L'0' && ch <= L'9';
    });
}

static bool isLegacyAppContainerProfileName(const std::wstring& name) {
    const std::wstring prefix = L"com.luccode.sandbox.";
    if (!stringStartsWith(name, prefix)) return false;
    std::wstring rest = name.substr(prefix.size());
    size_t dot = rest.find(L'.');
    if (dot == std::wstring::npos) return false;
    return isDigitsOnly(rest.substr(0, dot)) && isDigitsOnly(rest.substr(dot + 1));
}

static std::wstring sidToString(PSID sid) {
    LPWSTR sidText = nullptr;
    if (!sid || !ConvertSidToStringSidW(sid, &sidText)) return L"";
    std::wstring sidString = sidText;
    LocalFree(sidText);
    return sidString;
}

static std::wstring probeNamedObjectNamespace(HANDLE restrictedToken) {
    if (!ImpersonateLoggedOnUser(restrictedToken)) {
        return L"impersonate-failed:" + std::to_wstring(GetLastError()) + L":" + win32Message(GetLastError());
    }

    std::wstring name = L"Local\\luc-win-sandbox-diagnose-" +
        std::to_wstring(GetCurrentProcessId()) + L"-" +
        std::to_wstring(GetTickCount64());
    HANDLE mutex = CreateMutexW(nullptr, FALSE, name.c_str());
    DWORD rc = mutex ? ERROR_SUCCESS : GetLastError();
    if (mutex) CloseHandle(mutex);
    revertImpersonationOrTerminate();

    if (rc == ERROR_SUCCESS || rc == ERROR_ALREADY_EXISTS) return L"ok";
    return L"error:" + std::to_wstring(rc) + L":" + win32Message(rc);
}

static int diagnoseRestrictedToken(const Options& opts) {
    HANDLE baseToken = nullptr;
    DWORD desired = TOKEN_DUPLICATE | TOKEN_ASSIGN_PRIMARY | TOKEN_QUERY | TOKEN_IMPERSONATE |
        TOKEN_ADJUST_DEFAULT | TOKEN_ADJUST_SESSIONID;
    if (!OpenProcessToken(GetCurrentProcess(), desired, &baseToken)) {
        fail(L"OpenProcessToken failed: " + win32Message(GetLastError()));
        return 1;
    }

    std::vector<SID_AND_ATTRIBUTES> restrictingSids;
    std::vector<PSID> ownedRestrictingSids;
    PSID everyoneSid = nullptr;
    PSID logonSid = nullptr;
    bool ok = buildRestrictingSids(
        opts.writableRoots,
        baseToken,
        restrictingSids,
        ownedRestrictingSids,
        everyoneSid,
        logonSid
    );
    CloseHandle(baseToken);
    if (!ok) {
        freeOwnedSids(ownedRestrictingSids);
        return 1;
    }

    std::wcerr
        << L"luc-win-sandbox: diagnose-token"
        << L" cwd=\"" << opts.cwd << L"\""
        << L" executable=\"" << opts.executable << L"\""
        << L" writable-root-count=\"" << opts.writableRoots.size() << L"\""
        << L" restricting-sid-count=\"" << restrictingSids.size() << L"\""
        << std::endl;
    for (const auto& root : opts.writableRoots) {
        std::wcerr
            << L"luc-win-sandbox: diagnose-token-writable-root"
            << L" required=\"" << (root.required ? L"true" : L"false") << L"\""
            << L" path=\"" << root.path << L"\""
            << L" sid=\"" << root.sidString << L"\""
            << std::endl;
    }
    for (const auto& sid : restrictingSids) {
        std::wcerr
            << L"luc-win-sandbox: diagnose-token-restricting-sid"
            << L" sid=\"" << sidToString(sid.Sid) << L"\""
            << std::endl;
    }

    HANDLE token = createRestrictedWriteToken(opts.writableRoots);
    if (!token) {
        freeOwnedSids(ownedRestrictingSids);
        return 1;
    }
    std::wcerr
        << L"luc-win-sandbox: diagnose-token-base-named-objects-probe"
        << L" result=\"" << probeNamedObjectNamespace(token) << L"\""
        << std::endl;
    CloseHandle(token);
    freeOwnedSids(ownedRestrictingSids);
    return 0;
}

static bool isLegacyAppContainerSid(PSID sid, std::wstring* sidStringOut = nullptr) {
    std::wstring sidString = sidToString(sid);
    if (sidString.empty()) return false;
    bool legacy = stringStartsWith(sidString, L"S-1-15-2-");
    if (legacy && sidStringOut) *sidStringOut = sidString;
    return legacy;
}

static bool pushUniqueLegacyProfileName(std::vector<std::wstring>& out, const std::wstring& name) {
    if (!isLegacyAppContainerProfileName(name)) {
        fail(L"invalid legacy AppContainer profile name: " + name);
        return false;
    }
    auto it = std::find_if(out.begin(), out.end(), [&name](const std::wstring& existing) {
        return _wcsicmp(existing.c_str(), name.c_str()) == 0;
    });
    if (it == out.end()) out.push_back(name);
    return true;
}

static std::vector<std::wstring> uniqueLegacyProfileNames(const std::vector<std::wstring>& names, int* failures) {
    std::vector<std::wstring> out;
    for (const auto& name : names) {
        if (!pushUniqueLegacyProfileName(out, name) && failures) (*failures)++;
    }
    return out;
}

static std::vector<LegacyProfileSid> deriveLegacyProfileSids(
    const std::vector<std::wstring>& names,
    int* failures
) {
    std::vector<LegacyProfileSid> profiles;
    for (const auto& name : names) {
        PSID sid = nullptr;
        HRESULT hr = DeriveAppContainerSidFromAppContainerName(name.c_str(), &sid);
        if (FAILED(hr) || !sid) {
            fail(L"cannot derive legacy AppContainer SID for " + name +
                L": HRESULT " + std::to_wstring(static_cast<unsigned long>(hr)));
            if (failures) (*failures)++;
            continue;
        }
        profiles.push_back({ name, sidToString(sid), sid });
    }
    return profiles;
}

static void freeLegacyProfileSids(std::vector<LegacyProfileSid>& profiles) {
    for (auto& profile : profiles) {
        if (profile.sid) FreeSid(profile.sid);
        profile.sid = nullptr;
    }
}

static const LegacyProfileSid* findLegacyProfileBySid(
    PSID sid,
    const std::vector<LegacyProfileSid>& profiles
) {
    if (!sid) return nullptr;
    for (const auto& profile : profiles) {
        if (profile.sid && EqualSid(sid, profile.sid)) return &profile;
    }
    return nullptr;
}

static bool revokeSidsFromPath(const std::wstring& path, const std::vector<PSID>& sids, PACL oldDacl) {
    if (sids.empty()) return true;
    std::vector<EXPLICIT_ACCESSW> entries;
    for (PSID sid : sids) {
        EXPLICIT_ACCESSW access = {};
        access.grfAccessMode = REVOKE_ACCESS;
        access.Trustee.TrusteeForm = TRUSTEE_IS_SID;
        access.Trustee.TrusteeType = TRUSTEE_IS_UNKNOWN;
        access.Trustee.ptstrName = reinterpret_cast<LPWSTR>(sid);
        entries.push_back(access);
    }
    PACL newDacl = nullptr;
    DWORD rc = SetEntriesInAclW(static_cast<ULONG>(entries.size()), entries.data(), oldDacl, &newDacl);
    if (rc != ERROR_SUCCESS) {
        fail(L"cannot build ACL cleanup for " + path + L": " + win32Message(rc));
        return false;
    }
    rc = SetNamedSecurityInfoW(
        const_cast<LPWSTR>(path.c_str()),
        SE_FILE_OBJECT,
        DACL_SECURITY_INFORMATION,
        nullptr,
        nullptr,
        newDacl,
        nullptr
    );
    if (newDacl) LocalFree(newDacl);
    if (rc != ERROR_SUCCESS) {
        fail(L"cannot clean ACL for " + path + L": " + win32Message(rc));
        return false;
    }
    return true;
}

static bool convertSidString(const std::wstring& sidString, PSID* sidOut) {
    *sidOut = nullptr;
    if (!ConvertStringSidToSidW(sidString.c_str(), sidOut)) {
        fail(L"cannot convert SID " + sidString + L": " + win32Message(GetLastError()));
        return false;
    }
    return true;
}

static MigrationResult cleanupLucWriteAcls(const std::vector<std::wstring>& paths) {
    MigrationResult result;
    for (const auto& path : paths) {
        std::vector<std::wstring> sidStrings = {
            sidForWritableRoot(path),
            sidForWritableRootLegacyCapabilityNamespace(path),
            sidForWritableRootLegacyAccountNamespace(path),
        };
        std::vector<PSID> ownedSids;
        for (const auto& sidString : sidStrings) {
            PSID sid = nullptr;
            if (convertSidString(sidString, &sid)) ownedSids.push_back(sid);
            else result.failures++;
        }
        if (ownedSids.empty()) continue;

        PACL dacl = nullptr;
        PSECURITY_DESCRIPTOR descriptor = nullptr;
        DWORD rc = GetNamedSecurityInfoW(
            const_cast<LPWSTR>(path.c_str()),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            nullptr,
            nullptr,
            &dacl,
            nullptr,
            &descriptor
        );
        if (rc != ERROR_SUCCESS) {
            fail(L"luc-write-acl-cleanup path=\"" + path + L"\" error=\"" + win32Message(rc) + L"\"");
            result.failures++;
            for (PSID sid : ownedSids) LocalFree(sid);
            continue;
        }

        std::vector<PSID> matchedSids;
        if (dacl) {
            for (DWORD i = 0; i < dacl->AceCount; i++) {
                void* rawAce = nullptr;
                if (!GetAce(dacl, i, &rawAce) || !rawAce) continue;
                ACE_HEADER* header = reinterpret_cast<ACE_HEADER*>(rawAce);
                if (header->AceType != ACCESS_ALLOWED_ACE_TYPE && header->AceType != ACCESS_DENIED_ACE_TYPE) continue;

                PSID aceSid = nullptr;
                if (header->AceType == ACCESS_ALLOWED_ACE_TYPE) {
                    auto* ace = reinterpret_cast<ACCESS_ALLOWED_ACE*>(rawAce);
                    aceSid = reinterpret_cast<PSID>(&ace->SidStart);
                } else {
                    auto* ace = reinterpret_cast<ACCESS_DENIED_ACE*>(rawAce);
                    aceSid = reinterpret_cast<PSID>(&ace->SidStart);
                }
                for (PSID ownedSid : ownedSids) {
                    if (!EqualSid(aceSid, ownedSid)) continue;
                    if (std::none_of(matchedSids.begin(), matchedSids.end(), [ownedSid](PSID existing) {
                        return EqualSid(existing, ownedSid);
                    })) {
                        matchedSids.push_back(ownedSid);
                    }
                }
            }
        }

        if (!matchedSids.empty()) {
            if (revokeSidsFromPath(path, matchedSids, dacl)) {
                result.findings += static_cast<int>(matchedSids.size());
                for (PSID sid : matchedSids) {
                    std::wcerr
                        << L"luc-win-sandbox: luc-write-acl-cleaned"
                        << L" path=\"" << path << L"\""
                        << L" sid=\"" << sidToString(sid) << L"\""
                        << std::endl;
                }
            } else {
                result.failures++;
            }
        }

        if (descriptor) LocalFree(descriptor);
        for (PSID sid : ownedSids) LocalFree(sid);
    }
    return result;
}

static MigrationResult diagnoseLegacyAcls(
    const Options& opts,
    const std::vector<LegacyProfileSid>& cleanupProfiles
) {
    MigrationResult result;
    for (const auto& path : opts.legacyAclDiagnosticPaths) {
        PACL dacl = nullptr;
        PSECURITY_DESCRIPTOR descriptor = nullptr;
        DWORD rc = GetNamedSecurityInfoW(
            const_cast<LPWSTR>(path.c_str()),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            nullptr,
            nullptr,
            &dacl,
            nullptr,
            &descriptor
        );
        if (rc != ERROR_SUCCESS) {
            fail(L"legacy-acl-diagnostic path=\"" + path + L"\" error=\"" + win32Message(rc) + L"\"");
            result.failures++;
            continue;
        }

        std::vector<PSID> legacySids;
        if (dacl) {
            for (DWORD i = 0; i < dacl->AceCount; i++) {
                void* rawAce = nullptr;
                if (!GetAce(dacl, i, &rawAce) || !rawAce) continue;
                ACE_HEADER* header = reinterpret_cast<ACE_HEADER*>(rawAce);
                if (header->AceType != ACCESS_ALLOWED_ACE_TYPE && header->AceType != ACCESS_DENIED_ACE_TYPE) continue;

                DWORD mask = 0;
                PSID sid = nullptr;
                std::wstring aceKind = L"unknown";
                if (header->AceType == ACCESS_ALLOWED_ACE_TYPE) {
                    auto* ace = reinterpret_cast<ACCESS_ALLOWED_ACE*>(rawAce);
                    mask = ace->Mask;
                    sid = reinterpret_cast<PSID>(&ace->SidStart);
                    aceKind = L"allow";
                } else {
                    auto* ace = reinterpret_cast<ACCESS_DENIED_ACE*>(rawAce);
                    mask = ace->Mask;
                    sid = reinterpret_cast<PSID>(&ace->SidStart);
                    aceKind = L"deny";
                }

                std::wstring sidString;
                if (!isLegacyAppContainerSid(sid, &sidString)) continue;
                result.findings++;
                const LegacyProfileSid* matchedProfile = findLegacyProfileBySid(sid, cleanupProfiles);
                std::wcerr
                    << L"luc-win-sandbox: legacy-appcontainer-acl"
                    << L" path=\"" << path << L"\""
                    << L" sid=\"" << sidString << L"\""
                    << L" profile=\"" << (matchedProfile ? matchedProfile->name : L"unmatched") << L"\""
                    << L" ace=\"" << aceKind << L"\""
                    << L" mask=\"" << mask << L"\""
                    << std::endl;
                if (opts.cleanupLegacyAcl && matchedProfile && std::none_of(legacySids.begin(), legacySids.end(), [sid](PSID existing) {
                    return EqualSid(existing, sid);
                })) {
                    legacySids.push_back(sid);
                }
            }
        }

        if (opts.cleanupLegacyAcl) {
            if (legacySids.empty()) {
                debug(L"legacy ACL cleanup found no Luc-owned AppContainer SID for " + path);
            } else if (!revokeSidsFromPath(path, legacySids, dacl)) {
                result.failures++;
            }
        }
        if (descriptor) LocalFree(descriptor);
    }
    return result;
}

static bool isMissingAppContainerProfile(HRESULT hr) {
    DWORD code = HRESULT_CODE(hr);
    return code == ERROR_FILE_NOT_FOUND || code == ERROR_PATH_NOT_FOUND || code == ERROR_NOT_FOUND;
}

static MigrationResult cleanupLegacyProfiles(const std::vector<std::wstring>& profileNames) {
    MigrationResult result;
    for (const auto& name : profileNames) {
        HRESULT hr = DeleteAppContainerProfile(name.c_str());
        if (SUCCEEDED(hr)) {
            result.findings++;
            std::wcerr
                << L"luc-win-sandbox: legacy-appcontainer-profile-cleaned"
                << L" name=\"" << name << L"\""
                << std::endl;
            continue;
        }
        if (isMissingAppContainerProfile(hr)) {
            debug(L"legacy AppContainer profile already absent: " + name);
            continue;
        }
        result.failures++;
        fail(L"cannot delete legacy AppContainer profile " + name +
            L": HRESULT " + std::to_wstring(static_cast<unsigned long>(hr)));
    }
    return result;
}

int wmain(int argc, wchar_t** argv) {
    Options opts;
    try {
        opts = parseArgs(argc, argv);
    } catch (const std::exception& err) {
        std::string narrow = err.what();
        std::wstring wide(narrow.begin(), narrow.end());
        std::wcerr << L"luc-win-sandbox: " << wide << std::endl;
        return 2;
    }

    if (opts.superviseServer) {
        return superviseServer(opts);
    }

    if (!opts.lucWriteAclCleanupPaths.empty() ||
        !opts.legacyAclDiagnosticPaths.empty() ||
        !opts.legacyProfileNames.empty() ||
        !opts.legacyProfileCleanupNames.empty() ||
        opts.cleanupLegacyAcl) {
        int failures = 0;
        std::vector<std::wstring> profileNames = uniqueLegacyProfileNames(opts.legacyProfileNames, &failures);
        std::vector<std::wstring> cleanupProfileNames = uniqueLegacyProfileNames(opts.legacyProfileCleanupNames, &failures);
        std::vector<std::wstring> sidProfileNames = profileNames;
        for (const auto& name : cleanupProfileNames) {
            auto it = std::find_if(sidProfileNames.begin(), sidProfileNames.end(), [&name](const std::wstring& existing) {
                return _wcsicmp(existing.c_str(), name.c_str()) == 0;
            });
            if (it == sidProfileNames.end()) sidProfileNames.push_back(name);
        }
        std::vector<LegacyProfileSid> profileSids = deriveLegacyProfileSids(sidProfileNames, &failures);

        MigrationResult lucWriteResult;
        if (!opts.lucWriteAclCleanupPaths.empty()) {
            lucWriteResult = cleanupLucWriteAcls(opts.lucWriteAclCleanupPaths);
        }

        MigrationResult aclResult;
        if (!opts.legacyAclDiagnosticPaths.empty()) {
            aclResult = diagnoseLegacyAcls(opts, profileSids);
        }
        failures += lucWriteResult.failures + aclResult.failures;

        MigrationResult profileResult;
        if (failures == 0) {
            profileResult = cleanupLegacyProfiles(cleanupProfileNames);
            failures += profileResult.failures;
        } else if (!cleanupProfileNames.empty()) {
            debug(L"skipping legacy AppContainer profile cleanup because ACL cleanup failed");
        }
        int findings = lucWriteResult.findings + aclResult.findings + profileResult.findings;

        freeLegacyProfileSids(profileSids);
        if (failures > 0) return 1;
        return findings > 0 ? 3 : 0;
    }

    int exitCode = 1;
    std::vector<AclRestore> aclRestores;
    if (!convertRootSids(opts.writableRoots)) {
        freeRootSids(opts.writableRoots);
        emitTerminalRecord(L"launch_failed", false, 0, opts.timeoutMs, GetLastError());
        return HELPER_LAUNCH_FAILED_EXIT_CODE;
    }
    if (opts.diagnoseToken) {
        int diagnosticExitCode = diagnoseRestrictedToken(opts);
        freeRootSids(opts.writableRoots);
        return diagnosticExitCode;
    }
    if (!applyWriteAcls(opts.writableRoots, opts.denyWritePaths, aclRestores)) {
        restoreAcls(aclRestores);
        freeRootSids(opts.writableRoots);
        emitTerminalRecord(L"launch_failed", false, 0, opts.timeoutMs, GetLastError());
        return HELPER_LAUNCH_FAILED_EXIT_CODE;
    }

    HANDLE token = createRestrictedWriteToken(opts.writableRoots);
    if (token) {
        exitCode = runSandboxed(opts, token);
        CloseHandle(token);
    } else {
        exitCode = HELPER_LAUNCH_FAILED_EXIT_CODE;
        emitTerminalRecord(L"launch_failed", false, 0, opts.timeoutMs, GetLastError());
    }

    restoreAcls(aclRestores);
    freeRootSids(opts.writableRoots);
    return exitCode;
}
