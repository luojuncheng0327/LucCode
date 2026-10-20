#!/usr/bin/env node
import { restoreSessionManifestCheckpoint } from "../core/session-manifest/checkpoint.ts";

function parseArgs(argv) {
  const options = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--luc-home") {
      options.lucHome = argv[++i];
      continue;
    }
    if (arg === "--restored-at") {
      options.restoredAt = argv[++i];
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    positional.push(arg);
  }
  return { options, positional };
}

function helpText() {
  return [
    "session-manifest-rollback: restore a pre-migration Luc data checkpoint",
    "",
    "Usage:",
    "  node scripts/session-manifest-rollback.mjs <checkpoint-directory> [--luc-home <path>]",
    "",
    "Notes:",
    "  The current session-manifest.db is moved aside before checkpoint data is restored.",
  ].join("\n");
}

const { options, positional } = parseArgs(process.argv.slice(2));
if (options.help || positional.length !== 1) {
  const out = options.help ? process.stdout : process.stderr;
  out.write(`${helpText()}\n`);
  process.exit(options.help ? 0 : 1);
}

try {
  const result = restoreSessionManifestCheckpoint({
    checkpointDirectory: positional[0],
    lucHome: options.lucHome,
    restoredAt: options.restoredAt,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`session-manifest-rollback failed: ${error?.message || error}\n`);
  process.exit(1);
}

