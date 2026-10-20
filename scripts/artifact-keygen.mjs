#!/usr/bin/env node
/**
 * scripts/artifact-keygen.mjs
 *
 * Generates an ed25519 keypair for signing artifact train manifests. Run once per
 * key ceremony. The private key must NEVER be committed — it goes to
 * offline storage, later to the designated Actions secret store.
 *
 * Usage:
 *   node scripts/artifact-keygen.mjs --out <private-key-path> [--key-id <id>]
 *
 * Prints the public key + keyId as JSON on stdout, ready to paste into
 * the pinned keyset. All other output (instructions, warnings) goes to
 * stderr so stdout stays machine-parseable.
 */

import { generateKeyPairSync, createHash } from "crypto";
import fs from "fs";
import path from "path";

function parseArgs(argv) {
  const args = { out: null, keyId: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--out") {
      args.out = argv[++i];
    } else if (arg === "--key-id") {
      args.keyId = argv[++i];
    } else {
      console.error(`artifact-keygen: unknown argument ${arg}`);
      process.exit(1);
    }
  }
  if (!args.out) {
    console.error("Usage: node scripts/artifact-keygen.mjs --out <private-key-path> [--key-id <id>]");
    process.exit(1);
  }
  return args;
}

/** Deterministic default keyId tied to the actual key, so nobody has to guess. */
function defaultKeyId(publicKeyDer) {
  const digest = createHash("sha256").update(publicKeyDer).digest("hex");
  const year = new Date().getUTCFullYear();
  return `${year}${digest.slice(0, 6)}`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const outPath = path.resolve(args.out);

  if (fs.existsSync(outPath)) {
    console.error(`artifact-keygen: refusing to overwrite existing file: ${outPath}`);
    process.exit(1);
  }

  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const privatePem = privateKey.export({ type: "pkcs8", format: "pem" });
  const publicPem = publicKey.export({ type: "spki", format: "pem" });
  const publicDer = publicKey.export({ type: "spki", format: "der" });

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, privatePem, { mode: 0o600 });

  const keyId = args.keyId || defaultKeyId(publicDer);

  console.error("");
  console.error(`[artifact-keygen] Private key written to: ${outPath}`);
  console.error("[artifact-keygen] This file is HIGHLY SENSITIVE. It must go to OFFLINE");
  console.error("[artifact-keygen] storage — never commit it, never leave it in a worktree,");
  console.error("[artifact-keygen] never paste it anywhere but the intended secrets store.");
  console.error("");
  console.error("[artifact-keygen] Public key + keyId (paste into the pinned keyset):");
  console.error("");

  console.log(JSON.stringify({ keyId, publicKey: publicPem }, null, 2));
}

main();
