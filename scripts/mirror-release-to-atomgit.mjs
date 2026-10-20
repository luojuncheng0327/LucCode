import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import process from "node:process";
import { pathToFileURL } from "node:url";

const DEFAULT_GITHUB_REPOSITORY = "LuoJunCheng/luccode";
const DEFAULT_ATOMGIT_OWNER = "LuoJunCheng";
const DEFAULT_ATOMGIT_REPO = "LucCode-Releases";
const ATOMGIT_API_BASE = "https://api.gitcode.com/api/v5";
const ATOMGIT_WEB_API_BASE = "https://gitcode.com/api/v2";
// GitCode caps this endpoint at 20 items even when a larger per_page is sent.
// Use the effective cap so a full first page cannot be mistaken for EOF.
const ATOMGIT_RELEASE_PAGE_SIZE = 20;
const ATOMGIT_MAX_RELEASE_PAGES = 100;
const ATOMGIT_PRERELEASE_LIMIT = 20;

export function parseArgs(argv = process.argv.slice(2), env = process.env) {
  const [defaultGithubOwner, defaultGithubRepo] = (env.GITHUB_REPOSITORY || DEFAULT_GITHUB_REPOSITORY).split("/");
  const args = {
    githubOwner: defaultGithubOwner,
    githubRepo: defaultGithubRepo,
    atomgitOwner: env.ATOMGIT_OWNER || DEFAULT_ATOMGIT_OWNER,
    atomgitRepo: env.ATOMGIT_REPO || DEFAULT_ATOMGIT_REPO,
    tag: null,
    selection: "newest",
    latest: 1,
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--github-owner") args.githubOwner = argv[++i];
    else if (arg === "--github-repo") args.githubRepo = argv[++i];
    else if (arg === "--atomgit-owner") args.atomgitOwner = argv[++i];
    else if (arg === "--atomgit-repo") args.atomgitRepo = argv[++i];
    else if (arg === "--tag") args.tag = argv[++i];
    else if (arg === "--newest" || arg === "--latest") {
      args.selection = "newest";
      args.latest = Number.parseInt(argv[++i], 10);
    }
    else if (arg === "--stable") {
      args.selection = "stable";
      args.latest = Number.parseInt(argv[++i], 10);
    }
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (!Number.isInteger(args.latest) || args.latest < 1 || args.latest > 20) {
    throw new Error("release selection limit must be an integer between 1 and 20");
  }

  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/mirror-release-to-atomgit.mjs [--tag v0.0.0 | --newest 1 | --stable 1] [--dry-run]

Copies GitHub release assets to the matching AtomGit/GitCode release.
Selection:
  --tag v0.0.0  Mirror one exact tag, including prereleases
  --newest N    Mirror the newest non-draft GitHub releases, including prereleases
  --stable N    Mirror the newest non-draft, non-prerelease GitHub releases
Environment:
  GITHUB_TOKEN   Optional for GitHub API rate limits/private assets
  ATOMGIT_TOKEN  Required unless --dry-run
  ATOMGIT_OWNER  Default: ${DEFAULT_ATOMGIT_OWNER}
  ATOMGIT_REPO   Default: ${DEFAULT_ATOMGIT_REPO}
`);
}

function githubHeaders(env) {
  return {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    ...(env.GITHUB_TOKEN || env.GH_TOKEN ? { Authorization: `Bearer ${env.GITHUB_TOKEN || env.GH_TOKEN}` } : {}),
  };
}

function atomgitHeaders(env, extra = {}) {
  const token = env.ATOMGIT_TOKEN || env.GITCODE_TOKEN || "";
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}`, "PRIVATE-TOKEN": token } : {}),
    ...extra,
  };
}

function atomgitWebHeaders(env, extra = {}) {
  const token = env.ATOMGIT_TOKEN || env.GITCODE_TOKEN || "";
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    "X-Platform": "web",
    "X-App-Channel": "gitcode-fe",
    "X-Device-ID": "unknown",
    "User-Agent": "Mozilla/5.0 (compatible; LucReleaseMirror/1.0; +https://github.com/LuoJunCheng/luccode)",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...extra,
  };
}

function atomgitUrl(pathname, env, params = {}) {
  const token = env.ATOMGIT_TOKEN || env.GITCODE_TOKEN || "";
  const url = new URL(`${ATOMGIT_API_BASE}${pathname}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  if (token) url.searchParams.set("access_token", token);
  return url;
}

async function expectJson(response, label) {
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  if (!response.ok) {
    throw new Error(`${label} failed: ${response.status} ${parsed ? JSON.stringify(parsed) : text}`);
  }
  return parsed;
}

async function githubJson(url, env, fetchImpl) {
  const response = await fetchImpl(url, { headers: githubHeaders(env) });
  return expectJson(response, `GitHub API ${url}`);
}

export async function selectGithubReleases(options, { env = process.env, fetchImpl = fetch } = {}) {
  const base = `https://api.github.com/repos/${options.githubOwner}/${options.githubRepo}`;
  if (options.tag) {
    const release = await githubJson(`${base}/releases/tags/${encodeURIComponent(options.tag)}`, env, fetchImpl);
    if (release.draft) throw new Error(`GitHub release ${options.tag} is still draft`);
    return [release];
  }

  const perPage = options.selection === "stable"
    ? 100
    : Math.min(100, Math.max(5, options.latest * 5));
  const releases = await githubJson(`${base}/releases?per_page=${perPage}&page=1`, env, fetchImpl);
  return releases
    .filter(release => !release.draft)
    .filter(release => options.selection !== "stable" || !release.prerelease)
    .slice(0, options.latest);
}

export async function getGithubLatestTag(options, { env = process.env, fetchImpl = fetch } = {}) {
  const url = `https://api.github.com/repos/${options.githubOwner}/${options.githubRepo}/releases/latest`;
  const response = await fetchImpl(url, { headers: githubHeaders(env) });
  if (response.status === 404) return null;
  const release = await expectJson(response, `GitHub API ${url}`);
  if (!release?.tag_name || release.draft || release.prerelease) {
    throw new Error("GitHub latest release response was not a published stable release");
  }
  return release.tag_name;
}

export function buildAtomGitReleasePayload(githubRelease, githubLatestTag = null) {
  return {
    tag_name: githubRelease.tag_name,
    target_commitish: githubRelease.target_commitish || "main",
    name: githubRelease.name || githubRelease.tag_name,
    body: githubRelease.body || "",
    draft: false,
    prerelease: Boolean(githubRelease.prerelease),
    ...(githubRelease.prerelease
      ? { release_status: "pre" }
      : githubRelease.tag_name === githubLatestTag
        ? { release_status: "latest" }
        : {}),
  };
}

export async function listAtomGitReleases(options, { env = process.env, fetchImpl = fetch } = {}) {
  const releases = [];
  const tags = new Set();

  for (let page = 1; page <= ATOMGIT_MAX_RELEASE_PAGES; page += 1) {
    const url = atomgitUrl(
      `/repos/${options.atomgitOwner}/${options.atomgitRepo}/releases`,
      env,
      { direction: "desc", page, per_page: ATOMGIT_RELEASE_PAGE_SIZE },
    );
    const response = await fetchImpl(url, { headers: atomgitHeaders(env) });
    const pageReleases = await expectJson(response, `AtomGit release list page ${page}`);
    if (!Array.isArray(pageReleases)) {
      throw new Error(`AtomGit release list page ${page} was not an array`);
    }

    for (const release of pageReleases) {
      if (!release?.tag_name || typeof release.tag_name !== "string") {
        throw new Error(`AtomGit release list page ${page} contained a release without a tag_name`);
      }
      if (tags.has(release.tag_name)) {
        throw new Error(`AtomGit release pagination returned duplicate tag: ${release.tag_name}`);
      }
      tags.add(release.tag_name);
      releases.push(release);
    }

    if (pageReleases.length < ATOMGIT_RELEASE_PAGE_SIZE) return releases;
  }

  throw new Error(`AtomGit release listing exceeded ${ATOMGIT_MAX_RELEASE_PAGES} full pages; refusing incomplete cleanup`);
}

async function upsertAtomGitRelease(options, githubRelease, existing, githubLatestTag, { env, fetchImpl }) {
  const payload = buildAtomGitReleasePayload(githubRelease, githubLatestTag);
  const releasePath = existing
    ? `/repos/${options.atomgitOwner}/${options.atomgitRepo}/releases/${encodeURIComponent(githubRelease.tag_name)}`
    : `/repos/${options.atomgitOwner}/${options.atomgitRepo}/releases`;
  const method = existing ? "PATCH" : "POST";
  const response = await fetchImpl(atomgitUrl(releasePath, env), {
    method,
    headers: atomgitHeaders(env),
    body: JSON.stringify(payload),
  });
  const release = await expectJson(response, `AtomGit release ${method} ${githubRelease.tag_name}`);
  if (existing?.assets && !release?.assets) return { ...existing, ...release, assets: existing.assets };
  return release;
}

async function getAtomGitProjectId(options, { env, fetchImpl }) {
  const projectPath = encodeURIComponent(`${options.atomgitOwner}/${options.atomgitRepo}`);
  const url = `${ATOMGIT_WEB_API_BASE}/projects/${projectPath}?view=all`;
  const releasePage = `https://gitcode.com/${options.atomgitOwner}/${options.atomgitRepo}/releases`;
  const response = await fetchImpl(url, {
    headers: atomgitWebHeaders(env, {
      Referer: releasePage,
      "page-ref": encodeURIComponent(releasePage),
      "page-uri": encodeURIComponent(releasePage),
    }),
  });
  const project = await expectJson(response, "AtomGit project lookup for release cleanup");
  const projectId = Number(project?.id);
  if (!Number.isSafeInteger(projectId) || projectId <= 0) {
    throw new Error(`AtomGit project lookup did not return a valid numeric id: ${JSON.stringify(project)}`);
  }
  return projectId;
}

async function deleteAtomGitRelease(projectId, tag, { env, fetchImpl }) {
  // GitCode's documented v5 Release API has no release-only DELETE operation.
  // The first-party web UI uses this v2 endpoint, which removes the Release
  // record while leaving its repository Tag untouched.
  const response = await fetchImpl(
    `${ATOMGIT_WEB_API_BASE}/projects/${projectId}/releases/${encodeURIComponent(tag)}`,
    {
      method: "DELETE",
      headers: atomgitWebHeaders(env, { "page-repo-id": String(projectId) }),
      body: JSON.stringify({ project_id: projectId, tag_name: tag }),
    },
  );
  await expectJson(response, `AtomGit release delete ${tag}`);
}

function newestRelease(releases) {
  return [...releases].sort((left, right) => {
    const leftTime = Date.parse(left.created_at || "");
    const rightTime = Date.parse(right.created_at || "");
    if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
      return rightTime - leftTime;
    }
    return String(right.tag_name).localeCompare(String(left.tag_name), "en", { numeric: true });
  })[0] || null;
}

async function makePrereleaseQuotaRoom(options, projectId, githubRelease, releases, dependencies) {
  const targetExists = releases.some(release => release.tag_name === githubRelease.tag_name);
  const prereleaseCount = releases.filter(release => release.prerelease || release.release_status === "pre").length;
  if (targetExists || !githubRelease.prerelease || prereleaseCount < ATOMGIT_PRERELEASE_LIMIT) return releases;

  const fallback = newestRelease(releases);
  const toDelete = releases.filter(release => release.tag_name !== fallback?.tag_name);
  for (const release of toDelete) {
    console.log(`Deleting old AtomGit release ${release.tag_name} to make prerelease quota room`);
    await deleteAtomGitRelease(projectId, release.tag_name, dependencies);
  }
  return fallback ? [fallback] : [];
}

async function retainOnlyTargetRelease(options, projectId, targetTag, dependencies) {
  const releases = await listAtomGitReleases(options, dependencies);
  if (!releases.some(release => release.tag_name === targetTag)) {
    throw new Error(`AtomGit release ${targetTag} was not visible after upload; retaining fallback releases`);
  }
  for (const release of releases) {
    if (release.tag_name === targetTag) continue;
    console.log(`Deleting superseded AtomGit release ${release.tag_name}`);
    await deleteAtomGitRelease(projectId, release.tag_name, dependencies);
  }
}

export function normalizeUploadUrlPayload(payload) {
  const uploadUrl = payload?.url || payload?.upload_url || payload?.href;
  if (!uploadUrl || typeof uploadUrl !== "string") {
    throw new Error(`AtomGit upload_url response did not include an upload URL: ${JSON.stringify(payload)}`);
  }
  const headers = payload?.headers && typeof payload.headers === "object" ? payload.headers : {};
  return { uploadUrl, headers };
}

async function getAtomGitUploadTarget(options, tag, asset, { env, fetchImpl }) {
  const response = await fetchImpl(atomgitUrl(
    `/repos/${options.atomgitOwner}/${options.atomgitRepo}/releases/${encodeURIComponent(tag)}/upload_url`,
    env,
    { file_name: asset.name },
  ), { headers: atomgitHeaders(env) });
  const payload = await expectJson(response, `AtomGit upload URL ${asset.name}`);
  return normalizeUploadUrlPayload(payload);
}

async function downloadGithubAsset(asset, destination, { env, fetchImpl }) {
  const response = await fetchImpl(asset.browser_download_url, {
    headers: githubHeaders(env),
    redirect: "follow",
  });
  if (!response.ok || !response.body) {
    throw new Error(`GitHub asset download failed for ${asset.name}: ${response.status} ${await response.text()}`);
  }
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(destination));
}

async function uploadAtomGitAsset(uploadTarget, filePath, asset, fetchImpl) {
  const content = await fs.promises.readFile(filePath);
  const headers = {
    "Content-Length": String(content.byteLength),
    "Content-Type": asset.content_type || "application/octet-stream",
    ...uploadTarget.headers,
  };
  let response;
  try {
    response = await fetchImpl(uploadTarget.uploadUrl, {
      method: "PUT",
      headers,
      body: content,
      signal: AbortSignal.timeout(10 * 60 * 1000),
    });
  } catch (error) {
    const cause = error?.cause ? `: ${error.cause?.message || String(error.cause)}` : "";
    throw new Error(`AtomGit asset upload failed for ${asset.name}: ${error?.message || String(error)}${cause}`, {
      cause: error,
    });
  }
  if (!response.ok) {
    throw new Error(`AtomGit asset upload failed for ${asset.name}: ${response.status} ${await response.text()}`);
  }
}

async function mirrorAsset(options, githubRelease, asset, { env, fetchImpl, tempDir }) {
  const filePath = path.join(tempDir, asset.name);
  await downloadGithubAsset(asset, filePath, { env, fetchImpl });
  const uploadTarget = await getAtomGitUploadTarget(options, githubRelease.tag_name, asset, { env, fetchImpl });
  await uploadAtomGitAsset(uploadTarget, filePath, asset, fetchImpl);
}

function buildExistingAttachAssetMap(release) {
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const existing = new Map();
  for (const asset of assets) {
    if (asset?.type !== "attach" || !asset.name) continue;
    if (existing.has(asset.name)) {
      throw new Error(`AtomGit release contains duplicate asset name: ${asset.name}`);
    }
    existing.set(asset.name, asset);
  }
  return existing;
}

async function readExistingAtomGitAssetSize(options, tag, assetName, { env, fetchImpl }) {
  const response = await fetchImpl(atomgitUrl(
    `/repos/${options.atomgitOwner}/${options.atomgitRepo}/releases/${encodeURIComponent(tag)}/attach_files/${encodeURIComponent(assetName)}/download`,
    env,
  ), {
    method: "HEAD",
    headers: atomgitHeaders(env),
    redirect: "follow",
  });
  if (!response.ok) {
    throw new Error(`AtomGit existing asset size check failed for ${assetName}: ${response.status} ${await response.text()}`);
  }
  const contentLength = Number.parseInt(response.headers.get("content-length") || "", 10);
  if (!Number.isFinite(contentLength) || contentLength < 0) {
    throw new Error(`AtomGit asset ${assetName} already exists, but its size could not be verified; delete it and rerun the mirror`);
  }
  return contentLength;
}

async function shouldSkipExistingAsset(options, githubRelease, asset, { env, fetchImpl, existingAssets }) {
  if (!existingAssets.has(asset.name)) return false;
  if (!Number.isFinite(asset.size) || asset.size < 0) {
    throw new Error(`GitHub asset ${asset.name} does not include a verifiable size`);
  }
  const existingSize = await readExistingAtomGitAssetSize(options, githubRelease.tag_name, asset.name, { env, fetchImpl });
  if (existingSize !== asset.size) {
    throw new Error(`AtomGit asset ${asset.name} already exists with size ${existingSize}, expected ${asset.size}; delete it and rerun the mirror`);
  }
  return true;
}

export async function mirrorRelease(options, githubRelease, { env = process.env, fetchImpl = fetch } = {}) {
  if (!options.dryRun && !(env.ATOMGIT_TOKEN || env.GITCODE_TOKEN)) {
    throw new Error("ATOMGIT_TOKEN is required unless --dry-run is set");
  }

  const assetNames = (githubRelease.assets || []).map(asset => asset.name);
  if (options.dryRun) {
    return {
      tag: githubRelease.tag_name,
      dryRun: true,
      prerelease: Boolean(githubRelease.prerelease),
      assetNames,
    };
  }

  const dependencies = { env, fetchImpl };
  const githubLatestTag = await getGithubLatestTag(options, dependencies);
  const atomgitProjectId = await getAtomGitProjectId(options, dependencies);
  const listedReleases = await listAtomGitReleases(options, dependencies);
  const availableReleases = await makePrereleaseQuotaRoom(
    options,
    atomgitProjectId,
    githubRelease,
    listedReleases,
    dependencies,
  );
  const existingRelease = availableReleases.find(release => release.tag_name === githubRelease.tag_name) || null;
  const atomgitRelease = await upsertAtomGitRelease(
    options,
    githubRelease,
    existingRelease,
    githubLatestTag,
    dependencies,
  );
  const existingAssets = buildExistingAttachAssetMap(atomgitRelease);
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), `luc-atomgit-${githubRelease.tag_name}-`));
  try {
    for (const asset of githubRelease.assets || []) {
      if (await shouldSkipExistingAsset(options, githubRelease, asset, { env, fetchImpl, existingAssets })) {
        console.log(`Skipping ${githubRelease.tag_name}/${asset.name} (already mirrored)`);
        continue;
      }
      if (!Number.isFinite(asset.size) || asset.size < 0) {
        throw new Error(`GitHub asset ${asset.name} does not include a verifiable size`);
      }
      console.log(`Uploading ${githubRelease.tag_name}/${asset.name}`);
      await mirrorAsset(options, githubRelease, asset, { env, fetchImpl, tempDir });
      const uploadedSize = await readExistingAtomGitAssetSize(
        options,
        githubRelease.tag_name,
        asset.name,
        dependencies,
      );
      if (uploadedSize !== asset.size) {
        throw new Error(`AtomGit asset ${asset.name} uploaded with size ${uploadedSize}, expected ${asset.size}`);
      }
    }
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }

  await retainOnlyTargetRelease(options, atomgitProjectId, githubRelease.tag_name, dependencies);

  return {
    tag: githubRelease.tag_name,
    dryRun: false,
    prerelease: Boolean(githubRelease.prerelease),
    assetNames,
  };
}

export async function run(argv = process.argv.slice(2), { env = process.env, fetchImpl = fetch } = {}) {
  const args = parseArgs(argv, env);
  if (args.help) {
    printHelp();
    return;
  }

  const releases = await selectGithubReleases(args, { env, fetchImpl });
  if (releases.length === 0) {
    throw new Error("No published GitHub releases matched the requested selection");
  }

  const summaries = [];
  // Retention keeps one AtomGit Release, so backfills run oldest-to-newest and leave
  // the newest selected GitHub Release as the final mirror target.
  for (const release of [...releases].reverse()) {
    console.log(`${args.dryRun ? "Would mirror" : "Mirroring"} ${release.tag_name} (${release.assets?.length || 0} assets)`);
    summaries.push(await mirrorRelease(args, release, { env, fetchImpl }));
  }
  console.log(JSON.stringify({ mirrored: summaries }, null, 2));
  return summaries;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  run().catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exit(1);
  });
}
