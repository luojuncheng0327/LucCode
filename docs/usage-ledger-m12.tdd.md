# M1.2 usage-ledger SQLite migration evidence

This slice implements the HanaAgent 1.1.35 usage-ledger contract in LucCode and
registers the real DATA_EPOCH 1→2 migration. The work was derived from the
release bundle and the existing LucCode API; the Hana source was not available.

| Guarantee | Evidence | Result |
|---|---|---|
| JSON is imported once without rewriting its bytes; SQLite details and daily rollups remain durable after detail trimming | `node --test scripts/usage-ledger-sqlite.test.mjs` | PASS |
| Invalid JSON, invalid entries, invalid timestamps, and failed imports leave no partial rows and can be retried | same command | PASS |
| Writes are transactional; request identities survive trimming; events are emitted only after commit | same command | PASS |
| Missing token fields remain missing; first statistics time zone persists; clear and close are explicit | same command | PASS |
| 1→2 migration validates legacy data before checkpointing, commits once, blocks incomplete startup, and can restore/retry | `node --test scripts/data-epoch-usage-migration.test.mjs` | PASS |
| SQLite main file uses online backup, legacy JSON uses exact byte copy, and same-size restore checks hashes | `node --test scripts/usage-checkpoint-contract.test.mjs` | PASS |
| Provider normalization keeps missing fields and provider cache semantics explicit | `node --test scripts/usage-normalization.test.mjs` | PASS |
| Runtime schema fingerprint opens the real owner in an isolated database | `node --test scripts/persistence-generated-baseline.test.mjs` | PASS; 4 SQLite introspections |
| Existing persistence/build/seed regressions remain green | final 52-test command in `validation-m12-green-20261021/targeted-regressions-final.log` | PASS |

The final M1.2 scoped coverage log (`usage-final-coverage.log`) reported
99.36% lines for `usage-ledger.ts`, 93.15% branches, and 98.15% functions.
The earlier 97.87% / 75.43% / 96.30% figures were superseded. This is not a whole-repository coverage
claim. `build:server`, `verify:seed-kit`, and typecheck also passed with the
local validation keyset; no release was published and no installed application
was overwritten.

The original build logs predated the final `server/index.ts` adjustment.
All four baseline checks were rerun on `3ff8b113a89c36ed63f5fe231cfd010e74afcb43`:
52/52 targeted tests, typecheck, build:server and verify:seed-kit, all exit 0.
The authoritative refreshed logs/results are `current-head-*-20261021.*` in
the same evidence directory.

M1.4 schema additions and their verification are now tracked separately in
`docs/persistence-m14-alignment.tdd.md`. M1.2 does not itself prove M1.4
completion. Electron launch and whole-product Hana parity remain unverified.
