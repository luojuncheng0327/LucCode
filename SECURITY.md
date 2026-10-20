# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability, please report it through GitHub:

- Open a private vulnerability report in the repository Security tab when available:
  https://github.com/LuoJunCheng/luccode/security
- If private reporting is not available, open an issue:
  https://github.com/LuoJunCheng/luccode/issues

Please include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact

I will respond within 72 hours and work with you on a fix before public disclosure.

## Scope

- Sandbox escape (PathGuard / Seatbelt bypass)
- Credential leakage
- Remote code execution
- Cross-site scripting in the Electron renderer

## Local credential storage

Provider keys, OAuth tokens, and device records live in the data directory
(`LUC_HOME`, by default `~/.luccode`). What the application guarantees:

- Files holding credentials are written readable and writable by their owner
  only, and the data directory itself is owner-only.
- Startup verifies this on every launch and restores it when it has drifted,
  which happens after restoring a backup or copying the directory between
  machines. Each correction is logged.
- Backups taken during data migrations hold copies of the same credentials.
  They are removed once they are older than 90 days, and only while the live
  catalog is readable and populated, since that is what a rollback would need.

Where that protection ends:

- Permissions decide which *accounts* may open the files. They do not restrict
  programs running as the same user, which can read anything that user can read.
  Narrowing that requires encryption keyed by the operating system's credential
  store, which this project does not do today.
- On Windows the guarantees above do not apply. NTFS does not implement POSIX
  permission bits, and the platform's file API cannot express them, so the
  application performs no permission work there at all. What protects the data
  is the access control list the data directory inherits from its parent. Under
  the default location inside the user profile that already excludes other
  standard accounts, but a data directory placed elsewhere through `LUC_HOME`
  inherits whatever that location grants, and the application neither adjusts
  nor reports it. On Windows, prefer leaving the data directory in its default
  location.
- Credentials are stored as plain text. Treat the data directory accordingly:
  keep it out of version control, shared drives, and archives you pass on.
