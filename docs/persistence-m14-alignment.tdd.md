# M1.4 SQLite schema alignment — 2026-10-21

M1.4 implements the remaining schema difference from the local HanaAgent 1.1.35
release: `env_events`, `local_resources`, five indexes, and additions to
`session_manifests`, `session_capability_snapshots`, `session_branch_heads`
and `files`. The four usage tables already came from M1.2.

## Contract and completion boundary

- SessionManifestStore: store-local `user_version` 5 → 11, matching the release
  migration sequence (9 remains reserved). Adds 11 nullable manifest fields,
  `tool_selection_explicit INTEGER NOT NULL DEFAULT 0`,
  `observed_message_count INTEGER`, and the scoped event table/index.
  Initialization and migration share one transaction; failures close the handle.
- FileHistoryStore: nullable `stat_size INTEGER` and `stat_mtime_ms REAL`.
  Both ALTERs are transactional and idempotent; old snapshots remain intact.
  The compatible release contract retains `meta.schema_version=1`.
  Stat read and batch write helpers are available; baseline-scan integration is
  separate feature work.
- ResourceCatalogStore: real schema-v1 owner at
  `LUC_HOME/workspace-state/resources.sqlite`, with all 15 columns, four indexes,
  uniqueness/null/check constraints, compatible index repair and explicit close.
  Server construction occurs after the epoch gate and transfers the connection
  to Engine; constructor/init failures and normal disposal release it.
- DATA_EPOCH stays 2. These changes are additive. The production 1→2 edge remains
  the M1.2 usage migration; the checkpoint tests exercise the existing backup/
  restore primitives and do not add or claim another production epoch edge.

Resource adoption, move/relocation identity handling, resource IO routes,
environment-event producers/reminder consumers, and the feature APIs for new
session metadata remain M2. Electron/UI and whole-product parity are unverified.
No publication, push, installation overwrite, production trust-root change or
real-user-data migration is part of this work.

## Independent release comparison

`scripts/fixtures/hana135-m14-schema.json` contains SQL extracted from the
local release bundle and its SHA-256. Extraction reads literal SQL only; it does
not execute release JavaScript. The retained extraction script and command log
are in the external validation directory below.

`persistence-m14-release-schema.test.mjs` opens all five real owners in OS
temporary directories and compares their PRAGMA column types, nullability,
defaults, primary keys, foreign keys, unique keys and index definitions against
databases initialized from the independently extracted release DDL. All five
owner comparisons passed.

The 16-table/13-index acceptance count uses the report's scope: ordinary
`CREATE TABLE` objects and explicit indexes. The pre-existing FTS virtual
table, its shadow tables, SQLite internals and implicit autoindexes are excluded.

## RED/GREEN evidence

All evidence paths below are relative to
`D:\openhanako\hana135\validation-m12-green-20261021`.

| Slice | RED | GREEN / proof |
|---|---|---|
| Session schema | `2eed4bd`, `m14-session-red.log`, exit 1 | `5977ad0`, `m14-session-green-final.log`, 2/2 |
| File stat schema | `7baaefd`, `m14-file-history-red-corrected.log`, exit 1 | `8b84e64`, `m14-file-history-green.log`, 5/5 |
| Resource schema/registration | `fa1a6d9`, `m14-resource-red.log`, exit 1 | `77c22ae`, `m14-resource-schema-regressions.log`, 12/12 |
| Resource lifecycle | `6e7ce79`, `m14-resource-lifecycle-red-final.log`, exit 1 | `f98575d`, `m14-resource-lifecycle-green.log`, 8/8; log typing corrected in `e9f35f5` |
| Session transaction boundary | `18ea426`, `m14-schema-hardening-red.log`, 7 pass / 2 fail | `eea5a96`, `m14-schema-hardening-green.log`, 9/9 |
| Checkpoint/restore | Existing primitive integration, no production change needed | `m14-checkpoint-green.log`, 1/1 |

The initial file-history RED `1692cc3` expected an unnecessary version bump
to 2. Release evidence showed the compatible version remains 1; the corrected
RED tests fail on missing columns, batch APIs, rollback and future-version
handling. Session tests similarly corrected an accidental TEXT expectation for
`experience_enabled`, whose target type is INTEGER.

Tests preserve old snapshot bytes and session rows, reopen databases, inject
late DDL failure and retry, reject future schemas at the owner boundary, enforce
catalog constraints, and verify cleanup through the real Engine disposal method.
The checkpoint test captures committed WAL data from all three changed owners,
restores after mutations, quarantines sidecars and verifies reopened integrity.
It is a temporary-store integration check, not an application launch test.

## Generated audit and final acceptance evidence

Only the existing generators update `build/*.json`:

```powershell
node scripts/scan-persistent-stores.mjs
node scripts/generate-persistence-target-alignment.mjs
node scripts/generate-persistence-schema-fingerprint.mjs --classification compatible --compatibility-reason "<recorded additive-schema review>"
```

The fingerprint uses five real owner introspections. Current counts are:
116 target stores; 62 registry stores; 804 discovered sites; 57 target-only stores;
3 retained legacy stores; 15 descriptor differences; 44 static matches; 49 owner
scaffolds. They are inventory/audit counts, not feature completion percentages.

The final `m14-final-*.result.json` files record exact executable/arguments,
HEAD, initial worktree status, timestamps and exit codes for the targeted tests,
typecheck, changed-file lint, full build:server and independent verify:seed-kit.
Their matching logs and `m14-validation-summary.json`, together with the top
of `code_alignment_plan.md`, are the authoritative final stage result.
The build uses the existing external local validation keyset; the repository
production pinned keyset is unchanged. Scoped coverage does not cover the whole
repository. No full-repository or Electron-launch test result is claimed.
