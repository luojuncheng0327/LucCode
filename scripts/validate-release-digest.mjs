import fs from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  DIGEST_ASSET_NAME,
  DIGEST_HISTORY_SCHEMA_VERSION,
  assertValidReleaseDigest,
  assertValidReleaseDigestHistory,
} from "./release-digest-schema.mjs";

function parseArgs(argv = process.argv.slice(2), env = process.env) {
  const args = {
    file: DIGEST_ASSET_NAME,
    tag: env.GITHUB_REF_NAME || null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--file") args.file = argv[++i];
    else if (arg === "--tag") args.tag = argv[++i];
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (!args.help && !args.tag) {
    throw new Error("Missing release tag. Pass --tag vX.Y.Z or run from a tag workflow.");
  }

  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/validate-release-digest.mjs --tag v0.0.0 [--file ${DIGEST_ASSET_NAME}]

Validates the committed release digest before CI uploads it as a release asset.
`);
}

function tagToVersion(tag) {
  return tag.startsWith("v") ? tag.slice(1) : tag;
}

export function validateDigestForTag(digest, tag) {
  assertValidReleaseDigest(digest);
  const expectedVersion = tagToVersion(tag);
  const errors = [];
  if (digest.tag !== tag) {
    errors.push(`digest.tag must be ${tag}, got ${digest.tag}`);
  }
  if (digest.version !== expectedVersion) {
    errors.push(`digest.version must be ${expectedVersion}, got ${digest.version}`);
  }
  if (errors.length > 0) {
    throw new Error(`Release digest does not match tag:\n${errors.map(error => `- ${error}`).join("\n")}`);
  }
  return digest;
}

/**
 * v2 滚动史册：整体结构校验（含版本严格递减、上限）+ 头部条目必须与
 * 本次发版 tag 一致（头部就是"本次要发的那一节"）。
 */
export function validateHistoryForTag(history, tag) {
  assertValidReleaseDigestHistory(history);
  validateDigestForTag(history.entries[0], tag);
  return history;
}

/**
 * 按文件内容自动分流：{schema: 2} → v2 史册校验；否则按 v1 单版摘要
 * 校验。CI 与本地手写工作流共用此入口，两种文件都能过检。
 */
export function validateDigestFileValue(value, tag) {
  if (value && typeof value === "object" && !Array.isArray(value) && value.schema === DIGEST_HISTORY_SCHEMA_VERSION) {
    return validateHistoryForTag(value, tag);
  }
  return validateDigestForTag(value, tag);
}

export function readDigestFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

export function run(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv, env);
  if (args.help) {
    printHelp();
    return;
  }

  const digest = readDigestFile(args.file);
  validateDigestFileValue(digest, args.tag);
  console.log(`Validated ${args.file} for ${args.tag}`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    run();
  } catch (error) {
    console.error(error?.stack || error?.message || String(error));
    process.exit(1);
  }
}
