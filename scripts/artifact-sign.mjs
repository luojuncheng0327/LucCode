#!/usr/bin/env node
/**
 * scripts/artifact-sign.mjs
 *
 * Signs (or verifies) an artifact train manifest with the artifact-core
 * Ed25519 scheme. Sign mode writes `<manifest>.sig` next to the manifest file
 * (raw detached signature bytes, algorithm `null` per Node's Ed25519
 * API). Verify mode checks an existing `.sig` against a public key.
 *
 * Usage:
 *   node scripts/artifact-sign.mjs --key <private-key-path> --file <manifest>
 *   node scripts/artifact-sign.mjs --verify --pub <public-key-path> --file <manifest>
 */

import { sign as cryptoSign, verify as cryptoVerify, createPrivateKey, createPublicKey } from "crypto";
import fs from "fs";
import path from "path";

function parseArgs(argv) {
  const args = { key: null, pub: null, file: null, verify: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--key") {
      args.key = argv[++i];
    } else if (arg === "--pub") {
      args.pub = argv[++i];
    } else if (arg === "--file") {
      args.file = argv[++i];
    } else if (arg === "--verify") {
      args.verify = true;
    } else {
      console.error(`artifact-sign: unknown argument ${arg}`);
      process.exit(1);
    }
  }
  return args;
}

function usageAndExit() {
  console.error("Usage:");
  console.error("  node scripts/artifact-sign.mjs --key <private-key-path> --file <manifest>");
  console.error("  node scripts/artifact-sign.mjs --verify --pub <public-key-path> --file <manifest>");
  process.exit(1);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.file) usageAndExit();

  const manifestPath = path.resolve(args.file);
  if (!fs.existsSync(manifestPath)) {
    console.error(`artifact-sign: manifest file not found: ${manifestPath}`);
    process.exit(1);
  }
  const manifestBytes = fs.readFileSync(manifestPath);

  if (args.verify) {
    if (!args.pub) usageAndExit();
    const publicPem = fs.readFileSync(path.resolve(args.pub), "utf8");
    const publicKey = createPublicKey(publicPem);
    const sigPath = `${manifestPath}.sig`;
    if (!fs.existsSync(sigPath)) {
      console.error(`artifact-sign: signature file not found: ${sigPath}`);
      process.exit(1);
    }
    const sigBytes = fs.readFileSync(sigPath);
    const ok = cryptoVerify(null, manifestBytes, publicKey, sigBytes);
    if (!ok) {
      console.error(`artifact-sign: signature verification FAILED for ${manifestPath}`);
      process.exit(1);
    }
    console.log(`artifact-sign: signature OK for ${manifestPath}`);
    return;
  }

  if (!args.key) usageAndExit();
  const privatePem = fs.readFileSync(path.resolve(args.key), "utf8");
  const privateKey = createPrivateKey(privatePem);
  const signature = cryptoSign(null, manifestBytes, privateKey);
  const sigPath = `${manifestPath}.sig`;
  fs.writeFileSync(sigPath, signature);
  console.log(`artifact-sign: wrote ${sigPath}`);
}

main();
