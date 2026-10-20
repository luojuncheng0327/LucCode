import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  DIGEST_ASSET_NAME,
  DIGEST_HISTORY_ASSET_NAME,
  DIGEST_SCHEMA_VERSION,
  RELEASE_DIGEST_JSON_SCHEMA,
  appendDigestToHistory,
  assertValidReleaseDigest,
  assertValidReleaseDigestHistory,
} from "./release-digest-schema.mjs";

const DEFAULT_REPOSITORY = "LuoJunCheng/luccode";
const DEFAULT_MODEL = "gpt-5.5";

export function parseArgs(argv = process.argv.slice(2), env = process.env) {
  const args = {
    tag: env.GITHUB_REF_NAME || null,
    previousTag: "auto",
    ref: env.GITHUB_SHA || "HEAD",
    owner: null,
    repo: null,
    out: DIGEST_ASSET_NAME,
    sourceOut: null,
    releaseNotesFile: null,
    releaseUrl: "",
    noLlm: false,
    appendHistory: false,
    historyFile: DIGEST_HISTORY_ASSET_NAME,
    model: env.OPENAI_MODEL || DEFAULT_MODEL,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--tag") args.tag = argv[++i];
    else if (arg === "--previous-tag") args.previousTag = argv[++i];
    else if (arg === "--ref") args.ref = argv[++i];
    else if (arg === "--owner") args.owner = argv[++i];
    else if (arg === "--repo") args.repo = argv[++i];
    else if (arg === "--out") args.out = argv[++i];
    else if (arg === "--source-out") args.sourceOut = argv[++i];
    else if (arg === "--release-notes-file") args.releaseNotesFile = argv[++i];
    else if (arg === "--release-url") args.releaseUrl = argv[++i];
    else if (arg === "--model") args.model = argv[++i];
    else if (arg === "--no-llm") args.noLlm = true;
    else if (arg === "--append-history") args.appendHistory = true;
    else if (arg === "--history-file") args.historyFile = argv[++i];
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  const [envOwner, envRepo] = (env.GITHUB_REPOSITORY || DEFAULT_REPOSITORY).split("/");
  args.owner ||= envOwner;
  args.repo ||= envRepo;

  // --append-history 只搬运既有摘要文件，不接触 git/LLM，不需要 tag
  if (!args.tag && !args.help && !args.appendHistory) {
    throw new Error("Missing release tag. Pass --tag vX.Y.Z or run from a tag workflow.");
  }

  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/generate-release-digest.mjs --tag v0.0.0 [options]

Options:
  --previous-tag <tag|auto>  Previous tag used for commit range. Default: auto
  --ref <git-ref>            Git ref to summarize before the tag exists. Default: HEAD
  --owner <owner>           GitHub owner. Default: GITHUB_REPOSITORY owner
  --repo <repo>             GitHub repo. Default: GITHUB_REPOSITORY repo
  --out <path>              Digest JSON output. Default: ${DIGEST_ASSET_NAME}
  --source-out <path>       Write the LLM source packet for audit/debugging
  --release-notes-file <p>   Optional local release notes file
  --release-url <url>        Optional release URL embedded into digest source
  --model <model>           OpenAI model. Default: ${DEFAULT_MODEL}
  --no-llm                  Only collect/write the source packet; do not call OpenAI
  --append-history          Append the digest at --out into the v2 rolling history, then exit
                            (no git, no LLM; the hand-written digest workflow's second step)
  --history-file <path>     v2 rolling history JSON path. Default: ${DIGEST_HISTORY_ASSET_NAME}
`);
}

function git(args, { allowFailure = false } = {}) {
  try {
    return execFileSync("git", args, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (error) {
    if (allowFailure) return "";
    const stderr = error?.stderr?.toString?.().trim();
    throw new Error(`git ${args.join(" ")} failed${stderr ? `: ${stderr}` : ""}`);
  }
}

function normalizeTag(tag) {
  if (!tag || typeof tag !== "string") return "";
  return tag.trim();
}

function tagToVersion(tag) {
  const normalized = normalizeTag(tag);
  return normalized.startsWith("v") ? normalized.slice(1) : normalized;
}

export function resolvePreviousTag(ref = "HEAD", explicitPreviousTag = "auto") {
  if (explicitPreviousTag && explicitPreviousTag !== "auto") return explicitPreviousTag;

  const previous = git(["describe", "--tags", "--abbrev=0", `${ref}^`], { allowFailure: true });
  if (previous) return previous;

  const sortedTags = git(["tag", "--sort=-creatordate"], { allowFailure: true })
    .split("\n")
    .map(item => item.trim())
    .filter(Boolean);
  return sortedTags[0] || "";
}

function parseCommitLog(raw) {
  if (!raw.trim()) return [];
  return raw
    .split("\x1e")
    .map(entry => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [sha = "", subject = "", body = ""] = entry.split("\x00");
      return {
        sha,
        shortSha: sha.slice(0, 12),
        subject: subject.trim(),
        body: body.trim(),
      };
    });
}

function collectCommits(previousTag, ref) {
  const range = previousTag ? `${previousTag}..${ref}` : ref;
  const raw = git(["log", "--no-merges", "--format=%H%x00%s%x00%b%x1e", range], { allowFailure: true });
  return { range, commits: parseCommitLog(raw) };
}

async function readReleaseNotes(filePath) {
  if (!filePath) return "";
  return fs.promises.readFile(filePath, "utf-8");
}

export async function collectDigestSource(options) {
  const tag = normalizeTag(options.tag);
  const ref = options.ref || "HEAD";
  const previousTag = resolvePreviousTag(ref, options.previousTag);
  const { range, commits } = collectCommits(previousTag, ref);
  const releaseNotes = await readReleaseNotes(options.releaseNotesFile);

  return {
    schemaVersion: DIGEST_SCHEMA_VERSION,
    task: "Generate a bilingual, user-facing release digest for LucCode.",
    rules: [
      "Use only facts from releaseNotes and commits.",
      "Write concise zh and en content for normal users, not raw engineering changelog prose.",
      "Group related commits into at most 12 items.",
      "Set noUserFacingChanges=true only when there are no meaningful user-facing changes.",
      "Every item must cite at least one source from the supplied commits or release notes.",
      "Do not mention internal CI noise unless it directly affects installation or updates.",
    ],
    owner: options.owner,
    repo: options.repo,
    tag,
    version: tagToVersion(tag),
    previousTag,
    ref,
    generatedAt: new Date().toISOString(),
    releaseUrl: options.releaseUrl || `https://github.com/${options.owner}/${options.repo}/releases/tag/${tag}`,
    releaseNotes,
    commitRange: range,
    commits,
  };
}

function buildSystemPrompt() {
  return [
    "You write LucCode release digests.",
    "Return JSON that strictly matches the supplied schema.",
    "The digest is shown in the app About page under a button named 此次更新你将获得.",
    "The zh text should be natural Simplified Chinese.",
    "The en text should be natural English.",
    "Be specific, but do not invent benefits that are not supported by sources.",
  ].join("\n");
}

function buildUserPrompt(source) {
  return JSON.stringify(source, null, 2);
}

function extractResponseText(payload) {
  if (typeof payload?.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text;
  }
  for (const item of payload?.output || []) {
    for (const content of item?.content || []) {
      if (typeof content?.text === "string" && content.text.trim()) {
        return content.text;
      }
    }
  }
  throw new Error("OpenAI response did not include text output");
}

export async function generateDigestWithOpenAI(source, {
  env = process.env,
  fetchImpl = fetch,
  model = DEFAULT_MODEL,
} = {}) {
  if (!env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required to generate release digest");
  }

  const response = await fetchImpl("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: [
        {
          role: "system",
          content: [{ type: "input_text", text: buildSystemPrompt() }],
        },
        {
          role: "user",
          content: [{ type: "input_text", text: buildUserPrompt(source) }],
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "luc_release_digest",
          strict: true,
          schema: RELEASE_DIGEST_JSON_SCHEMA,
        },
      },
      store: false,
      max_output_tokens: 4000,
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI release digest generation failed: ${response.status} ${await response.text()}`);
  }

  const payload = await response.json();
  const text = extractResponseText(payload);
  const digest = JSON.parse(text);
  assertValidReleaseDigest(digest);
  return digest;
}

async function writeJson(filePath, value) {
  await fs.promises.mkdir(path.dirname(path.resolve(filePath)), { recursive: true });
  await fs.promises.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await fs.promises.readFile(filePath, "utf-8"));
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }
}

/**
 * 手写工作流的第二步：读取 --out 的 v1 单版摘要，
 * 追加进 --history-file 的 v2 滚动史册（新版本插头部、同版本幂等覆盖、
 * 旧版本拒绝、超 50 条裁掉最老），整体校验通过后落盘。史册文件不存在
 * 时以该摘要为唯一条目新建（首次迁移）。损坏的现有史册文件直接抛错，
 * 不静默重建（项目铁律：禁止非用户预期的 fallback）。
 */
export async function appendDigestFileToHistoryFile(digestPath, historyPath) {
  const digest = JSON.parse(await fs.promises.readFile(digestPath, "utf-8"));
  const existing = await readJsonIfExists(historyPath);
  if (existing !== null) {
    assertValidReleaseDigestHistory(existing);
  }
  const history = appendDigestToHistory(existing, digest);
  assertValidReleaseDigestHistory(history);
  await writeJson(historyPath, history);
  return history;
}

export async function run(argv = process.argv.slice(2), { env = process.env, fetchImpl = fetch } = {}) {
  const args = parseArgs(argv, env);
  if (args.help) {
    printHelp();
    return;
  }

  if (args.appendHistory) {
    const history = await appendDigestFileToHistoryFile(args.out, args.historyFile);
    console.log(`Appended ${args.out} into ${args.historyFile} (${history.entries.length} entries, head ${history.entries[0].version})`);
    return;
  }

  const source = await collectDigestSource(args);
  if (args.sourceOut) {
    await writeJson(args.sourceOut, source);
  }

  if (args.noLlm) {
    if (!args.sourceOut) {
      console.log(JSON.stringify(source, null, 2));
    }
    return;
  }

  const digest = await generateDigestWithOpenAI(source, {
    env,
    fetchImpl,
    model: args.model,
  });
  await writeJson(args.out, digest);
  const history = await appendDigestFileToHistoryFile(args.out, args.historyFile);
  console.log(`Wrote ${args.out} for ${digest.tag}; history ${args.historyFile} now has ${history.entries.length} entries`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  run().catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exit(1);
  });
}
