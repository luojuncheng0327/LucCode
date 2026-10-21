# M1.2–M1.3 persistence alignment — 2026-10-21

## Scope and evidence levels

The separately stored HanaAgent 1.1.35 release target is a specification, not a
runtime registry. `shared/persistence/hana135-target-catalog.json` contains 116
extracted target descriptors and the SHA-256 of `store_alignment.json`. Its raw
Unicode escapes, nullable pathKind, and compatibility-presence flag are retained.
No compatibility text or runtime behavior is invented from those fields.

`scripts/generate-persistence-target-alignment.mjs` derives the current comparison
from source and registry rules. The current result has 61 runtime stores, 58
target-only stores, 3 live legacy contracts, 15 descriptor differences, and 43
static descriptor matches. Fifty owner modules remain explicit side-effect-free
scaffolds. Source existence and static matches do not prove feature parity.

The retained legacy stores have 9 development-state, 2 update-channel, and 2
download-cache write sites. `usage-ledger` now has a real SQLite owner with a
read-only, byte-preserving JSON import path. `DATA_EPOCH` is 2 only because the
1→2 usage-ledger edge is registered, checkpointed, validated, and recoverable.
The remaining M1.4 schema work (`env_events`, `local_resources`, four existing
table additions, and the remaining indexes) is still pending.

## M1.2 usage-ledger migration evidence

The owner implements the four release-specified tables: `usage_entries`,
`usage_seen_requests`, `usage_daily_rollups`, and `usage_meta`. The database keeps
request identities and daily rollups after detail trimming, preserves missing
token fields as missing, persists the first statistics time zone, emits events
after commit, and closes explicitly with the engine lifecycle. `storagePath`
remains accepted as a compatibility alias; its JSON file is never rewritten.

The coordinator's production `usage-ledger-json-to-sqlite` migration validates
legacy JSON before writing a checkpoint, then uses the existing checkpoint,
journal, validation, and restore flow. The checkpoint contract uses SQLite online
backup for the database and exact byte copies for legacy JSON; WAL/SHM sidecars
are quarantined on restore. Restore now hashes same-size files before accepting an
already-restored shortcut.

The RED/GREEN evidence is in `D:\openhanako\hana135\validation-m12-green-20261021`.
The final targeted migration/ledger/normalization set is 17/17 green, the full
existing-plus-new targeted set is 52/52 green after the final fingerprint repin, and
the generator reports 4 real SQLite introspections. This does not claim Electron
launch or whole-product Hana parity.

## Package worker attribution

The imported worker currently has no production caller. Its 13 discovered sites
are 1 inherited-stderr write and 12 generic extract/copy/promotion/move/remove
filesystem operations. Eight exemptions match complete expressions and specific
operation kinds, and expire on 2026-10-31. No extension store is fabricated.

The regression rejects an additional write and detects a new production source
reference to the worker. Integration must replace this dormant-primitive review
with actual caller destination ownership and root authorization. Temporary copy
and backup siblings are not separate stores. Existing source bytes are unchanged.

Worker IPC tests run only in newly created OS temporary directories and verify
copy/replacement/hash/inspect/move/remove and rejection of relative paths. They do
not validate ZIP extraction attacks, crash rollback, EXDEV behavior, or an App
installation chain; none of those are claimed complete.

## Invalid inherited fingerprint

The initial commit `042810c` already contains a malformed fingerprint receipt:
its recorded payload SHA-256 is `1729dd12d237b06b3e11fe680d59ec326c52fdcfc019ad77bfe406e3b4bdc657`,
while recalculating its own body produces `069fd3839f2f32cd6eda9d0a6b8fdf35ea184125bf1c8a99c982ecaa6eae70a6`.
The existing generator correctly rejects that receipt before comparing schemas.

There are also 41 stale sourceHash fields across 38 distinct modules, all already
stale at the initial commit. Thirty-six modules are unchanged since that commit;
the remaining two only contain P0's `declare lucHome` → `declare luccodeHome` fix
and produce identical JavaScript. Line endings do not explain the drift. The
original cause before the initial commit is unknown.

Three real stores were opened in isolated temporary directories for SQLite
introspection. All schema fields other than sourceHash, and all 61 registry
descriptors, equal the prior receipt. The approved compatible repair archives
the invalid receipt, removes only the generated file, then invokes the existing
generator with explicit review; failure restores the archived bytes. The
generator and its rejection checks were not weakened.

Root better-sqlite3 initially had no native binding. A package-scoped rebuild
using an isolated npm userconfig authorizing only better-sqlite3 was followed by
an actual memory database query. No project/user npm policy or dependency version
was changed. A rebuild exit 0 with scripts blocked was not treated as success.

## Reproduction and regression evidence

- Target catalog RED `d721f46`, GREEN `0520405`: 4 tests; generator coverage
  93.38% lines, 95.24% branches, 100% functions. This is scoped coverage only.
- Worker attribution RED `43a4b3b`, GREEN `3ffb615`: 5 tests, including isolated
  runtime IPC operations and fail-closed census rules.
- Generated baseline RED `16de6ce`: the invalid inherited receipt was rejected.
  GREEN verifies generated inventory/startup/target audit byte-equivalent content
  and checks a fingerprint after exactly 3 runtime SQLite introspections.
- Combined eight-file targeted regression command passes 34/34. There is no
  `npm test` script; this is not a full-repository test claim.

Generators:

```powershell
node scripts/generate-persistence-target-alignment.mjs
node scripts/scan-persistent-stores.mjs
node scripts/generate-persistence-schema-fingerprint.mjs
node --test scripts/persistence-generated-baseline.test.mjs
```

The schema command reuses the committed review only while its payload remains
unchanged. New contract changes require a fresh compatible/breaking declaration.
Never hand-edit generated inventory, startup receipt, or schema fingerprints.

Full logs, old receipt, and structured audits are in
`D:\openhanako\hana135\validation-m13-resume-20261021`. Current phase completion
and build results are tracked at the top of `code_alignment_plan.md` alongside
the exact validation revision. Electron launch and whole-product runtime parity
remain unverified. No publication, installation overwrite, or real user data
migration was performed.
