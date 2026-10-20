# Alpha invite gate — deployment

A single Cloudflare Worker plus one KV namespace. It hands a tester who holds a
valid invite code the address of the alpha update feed, binds that code to the
machine that spent it, and hands the tester two fresh codes to pass on.

Everything here is a one-time setup on your own Cloudflare account. Nothing in
this directory contains an account id, a namespace id or a token, and nothing
you produce below belongs in the repository.

## What the pieces are

| File | Role |
|------|------|
| `worker.mjs` | Workers entry point. Wiring only: KV binding + env into `core.mjs`. |
| `core.mjs` | Every decision the service makes. No Cloudflare imports, no npm dependencies. |
| `wrangler.toml` | Configuration skeleton with placeholders. |

The test suite is `tests/alpha-gate-worker.test.ts` in the repository root and
runs under the normal `npm test`; it drives `core.mjs` with an in-memory KV, so
no deployment is needed to check behaviour.

## Prerequisites

- A Cloudflare account (the free Workers plan is enough).
- Node.js on the machine you deploy from. No repository dependency is added:
  wrangler is invoked through `npx` and never installed into `package.json`.
- The wrangler version pinned below was the published release on 2026-08-01.
  Confirm it still looks right before running, and keep the same pin for every
  step so all commands agree.

```
WRANGLER="npx wrangler@4.118.0"
```

## 1. Authenticate

```
$WRANGLER login
```

Opens a browser once and stores the token in your user profile.

## 2. Create the KV namespace

```
cd tools/alpha-gate-worker
$WRANGLER kv namespace create INVITE_KV
```

It prints an id. Paste it into `wrangler.toml` in place of
`REPLACE_WITH_KV_NAMESPACE_ID`. Keep that edit local — do not commit it.

## 3. Set the feed address and the fission settings

Edit `[vars]` in `wrangler.toml`:

- `FEED_URL` — the https address of the alpha update feed directory (the one
  holding `latest-mac.yml` and the DMG). In this version the guard is that the
  address is unguessable, so treat it like a secret even though it lives in
  `[vars]`: anyone who redeems a code learns it.
- `FISSION_COUNT`, `MAX_GENERATION`, `GLOBAL_CAP`, `RATE_LIMIT_PER_HOUR` — the
  invite economy. Defaults are 2 / 5 / 10000 / 30. A malformed value is not
  silently ignored: the Worker answers 500 with the offending setting named.

## 4. Install the admin token

```
$WRANGLER secret put ADMIN_TOKEN
```

Paste a long random string when prompted (for example the output of
`openssl rand -base64 33`). Store it in your password manager. Until this
secret exists, every `/admin/*` endpoint answers 401 — including for you.

## 5. Deploy

```
$WRANGLER deploy
```

It prints the Worker URL, e.g. `https://alpha-invite-gate.<subdomain>.workers.dev`.

## 6. Mint the first root codes

```
GATE="https://alpha-invite-gate.<subdomain>.workers.dev"
TOKEN="<the ADMIN_TOKEN you just set>"

curl -sS -X POST "$GATE/admin/mint" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"count": 5}'
```

Answers `{"ok":true,"codes":["LUC-XXXX-XXXX-XXXX", ...],"generation":0,"total":5}`.
Those are the roots you hand out personally; every later code descends from them.

Smoke-test one redemption end to end (this really spends the code):

```
curl -sS -X POST "$GATE/redeem" \
  -H "Content-Type: application/json" \
  -d '{"code":"LUC-XXXX-XXXX-XXXX","deviceIdHash":"'"$(printf smoke | shasum -a 256 | cut -d' ' -f1)"'"}'
```

Expect `{"ok":true,"feedUrl":"...","childCodes":["...","..."]}`. Repeating the
exact same request returns the same two children (redemption is idempotent per
device); the same code from a different `deviceIdHash` returns 404 with the
generic rejection.

## 7. Point the desktop client at the Worker

The client reads the endpoint from `LUC_INVITE_API_URL`, falling back to the
constant `DEFAULT_INVITE_API_URL` in `desktop/auto-updater.cjs` (currently the
empty string, which makes the invite UI report "not configured"). Two ways in:

- For your own testing, launch the app with `LUC_INVITE_API_URL=$GATE`.
- To turn the feature on for everyone, set `DEFAULT_INVITE_API_URL` to the
  Worker URL and ship a release. The URL is not a secret — the invite code is
  the credential, and the endpoint is rate limited per IP.

The client POSTs `{code, deviceIdHash}` to `$GATE/redeem` and expects
`{ok, feedUrl, childCodes}`; it reads the `error` string out of any rejection
and shows it verbatim. Redeeming does not switch the channel by itself — the
app asks the user to confirm the one-way data upgrade first.

## Operating it

All admin calls need `Authorization: Bearer $TOKEN`.

```
# Mint more roots (or a batch at a given generation)
curl -sS -X POST "$GATE/admin/mint" -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -d '{"count": 10, "generation": 0}'

# Burn a code and everything descended from it
curl -sS -X POST "$GATE/admin/revoke" -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -d '{"code":"LUC-XXXX-XXXX-XXXX"}'

# Burn a single code but leave its children alive
curl -sS -X POST "$GATE/admin/revoke" -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -d '{"code":"LUC-XXXX-XXXX-XXXX","cascade":false}'

# The whole genealogy
curl -sS "$GATE/admin/tree" -H "Authorization: Bearer $TOKEN"
```

To pause the invite wave without touching code, set `GLOBAL_CAP` to the current
`total` from `/admin/tree` and redeploy: existing codes still work, but they
stop producing children.

## Things worth knowing before you rely on it

- **Revocation does not reach a machine that already upgraded.** The code is
  spent at the moment of redemption; afterwards the client holds the feed
  address on disk. Revoking blocks further redemptions in that branch, not an
  install that already happened. Cutting off a live installation needs the
  per-device token check on the feed itself, which this version does not have.
- **KV is eventually consistent.** Two redemptions of the same code from two
  machines within roughly a second of each other can both read "unused". The
  window is small and the blast radius is one extra alpha tester.
- **A failure between minting children and marking the parent redeemed** leaves
  the children in the ledger while the parent still reads "unused". A retry
  then mints a second set. It shows up in `/admin/tree` as unreferenced codes;
  revoke them if it ever happens.
- **The rate limit counts requests per IP, not per code**, and only on
  `/redeem`. Testers behind one office NAT share a budget.
- **Rejections on `/redeem` are deliberately identical** for unknown, revoked,
  spent-by-someone-else and malformed codes: same status, same message, same
  shape. Do not add detail there — it would turn the endpoint into a code
  oracle. `/admin/*` is authenticated and answers honestly.
- **Rotating `ADMIN_TOKEN`** is just `wrangler secret put ADMIN_TOKEN` again;
  it takes effect on the next request, and no invite code is affected.
