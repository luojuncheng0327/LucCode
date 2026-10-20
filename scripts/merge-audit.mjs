#!/usr/bin/env node
/**
 * merge-audit — 合并双向整文件覆盖审计
 *
 * 检测 merge commit 里"某个双侧都改过的文件被整文件解决成单侧版本"的事故
 * （即另一侧的改动被无声丢弃），并对每处受灾用三方合并判定"当前 HEAD 是否已补回"。
 *
 * 背景：这类事故在 `git log` / `git log -S` 里完全隐形（merge commit 默认不展示
 * diff）。本工具把双侧都改过、却被整文件解决成单侧内容的情况列为 real loss；
 * 修复时应逐项恢复缺失语义，再重新运行同一审计直到结果为 0 real loss。
 *
 * 用法：
 *   node scripts/merge-audit.mjs                 # 审计当前分支全部 first-parent merge
 *   node scripts/merge-audit.mjs --limit 1       # 只审最近一次 merge（AI 代理 merge 后自检用）
 *   node scripts/merge-audit.mjs --merge <sha>   # 审计指定 merge
 *   node scripts/merge-audit.mjs --ref <ref>     # 审计其它分支（补回判定也以该 ref 为基准）
 *   node scripts/merge-audit.mjs --json          # 机器可读输出
 *
 * 退出码：存在 real 级发现（丢失且至今未补回）时为 1，否则 0。
 * package.json / package-lock.json 因双线独立版本号属常规冲突解法，只标注不计入 real。
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EXPECTED_NOISE_PATHS = new Set(["package.json", "package-lock.json"]);
const MISSING = Symbol("missing");

const args = process.argv.slice(2);
const options = { json: false, merge: null, limit: null, ref: "HEAD" };
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === "--json") options.json = true;
  else if (arg === "--merge") options.merge = args[++i];
  else if (arg === "--limit") options.limit = Number(args[++i]);
  else if (arg === "--ref") options.ref = args[++i];
  else {
    process.stderr.write(`unknown argument: ${arg}\n`);
    process.exit(2);
  }
}

function git(gitArgs, { allowFail = false } = {}) {
  const result = spawnSync("git", gitArgs, {
    cwd: process.cwd(),
    encoding: "utf-8",
    maxBuffer: 1024 * 1024 * 512,
  });
  if (result.status !== 0 && !allowFail) {
    throw new Error(`git ${gitArgs.join(" ")} failed: ${result.stderr}`);
  }
  return result.status === 0 ? result.stdout : null;
}

function gitBlob(oid) {
  return execFileSync("git", ["cat-file", "blob", oid], {
    cwd: process.cwd(),
    maxBuffer: 1024 * 1024 * 512,
  });
}

/** commit → Map<path, blobOid>（含子目录全量） */
function treeOf(commit) {
  const out = git(["ls-tree", "-r", "-z", commit]);
  const map = new Map();
  for (const entry of out.split("\0")) {
    if (!entry) continue;
    const tab = entry.indexOf("\t");
    const meta = entry.slice(0, tab).split(" ");
    if (meta[1] !== "blob") continue; // 忽略 submodule 等非 blob 条目
    map.set(entry.slice(tab + 1), meta[2]);
  }
  return map;
}

function blobAt(map, file) {
  return map.has(file) ? map.get(file) : MISSING;
}

/**
 * 判定"丢失侧相对 base 的改动"如今在 ref 上是否已存在：
 * 以 ref 内容为 current、丢失侧内容为 other 做三方合并，结果与 ref 完全一致
 * 说明丢失侧的改动已全部包含（integrated）；不一致为 missing-at-head；
 * 产生冲突则无法机判（conflict，需人工）；ref 上文件已不存在为 file-gone。
 */
function integrationStatus(refTree, baseOid, lostOid, file) {
  if (lostOid === MISSING) return "not-applicable";
  const refOid = blobAt(refTree, file);
  if (refOid === MISSING) return "file-gone";
  if (refOid === lostOid) return "integrated";

  const refContent = gitBlob(refOid);
  const lostContent = gitBlob(lostOid);
  const baseContent = baseOid === MISSING ? Buffer.alloc(0) : gitBlob(baseOid);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "merge-audit-"));
  try {
    const current = path.join(dir, "current");
    const base = path.join(dir, "base");
    const lost = path.join(dir, "lost");
    fs.writeFileSync(current, refContent);
    fs.writeFileSync(base, baseContent);
    fs.writeFileSync(lost, lostContent);
    const merged = spawnSync("git", ["merge-file", "-p", current, base, lost], {
      cwd: process.cwd(),
      maxBuffer: 1024 * 1024 * 512,
    });
    if (merged.status === null || merged.status < 0) return "conflict";
    if (merged.status > 0) return "conflict";
    return merged.stdout.equals(refContent) ? "integrated" : "missing-at-head";
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function auditMerge(mergeSha, refTree) {
  const parentsOut = git(["rev-parse", `${mergeSha}^1`, `${mergeSha}^2`], { allowFail: true });
  if (!parentsOut) return null; // 非 merge commit
  const [p1, p2] = parentsOut.split("\n").filter(Boolean);
  const baseOut = git(["merge-base", p1, p2], { allowFail: true });
  if (!baseOut) return { sha: mergeSha, skipped: "no-merge-base", findings: [] };
  const base = baseOut.split("\n")[0].trim();

  const [treeM, treeP1, treeP2, treeB] = [mergeSha, p1, p2, base].map(treeOf);
  const paths = new Set([...treeM.keys(), ...treeP1.keys(), ...treeP2.keys(), ...treeB.keys()]);
  const findings = [];

  for (const file of paths) {
    const m = blobAt(treeM, file);
    const bp1 = blobAt(treeP1, file);
    const bp2 = blobAt(treeP2, file);
    const bb = blobAt(treeB, file);
    if (bp1 === bp2) continue; // 双侧一致，无所谓取哪侧

    // merge 结果整体等于 P2，而 P1 侧自 base 起有自己的改动 → 第一父侧被覆盖
    if (m === bp2 && bp1 !== bb) {
      findings.push({ path: file, lostSide: "first-parent", base, lostCommit: p1, lostOid: bp1, baseOid: bb });
    }
    // merge 结果整体等于 P1，而 P2 侧自 base 起有自己的改动 → 第二父侧被覆盖
    if (m === bp1 && bp2 !== bb) {
      findings.push({ path: file, lostSide: "second-parent", base, lostCommit: p2, lostOid: bp2, baseOid: bb });
    }
  }

  for (const finding of findings) {
    finding.status = integrationStatus(refTree, finding.baseOid, finding.lostOid, finding.path);
    finding.expected = EXPECTED_NOISE_PATHS.has(finding.path);
    delete finding.lostOid;
    delete finding.baseOid;
  }
  return { sha: mergeSha, findings };
}

function main() {
  const refSha = git(["rev-parse", options.ref]).trim();
  const refTree = treeOf(refSha);

  let mergeShas;
  if (options.merge) {
    mergeShas = [git(["rev-parse", options.merge]).trim()];
  } else {
    const listArgs = ["rev-list", "--merges", "--first-parent", refSha];
    if (Number.isInteger(options.limit) && options.limit > 0) {
      listArgs.splice(1, 0, `--max-count=${options.limit}`);
    }
    mergeShas = git(listArgs).split("\n").filter(Boolean);
  }

  const merges = [];
  let realCount = 0;
  let expectedCount = 0;
  let conflictCount = 0;

  for (const sha of mergeShas) {
    const audited = auditMerge(sha, refTree);
    if (!audited) continue;
    const subject = git(["log", "-1", "--format=%h %ad %s", "--date=format:%Y-%m-%d", sha]).trim();
    const entry = { sha, subject, skipped: audited.skipped ?? null, findings: audited.findings };
    merges.push(entry);
    for (const finding of entry.findings) {
      if (finding.expected) expectedCount += 1;
      else if (finding.status === "missing-at-head" || finding.status === "file-gone") realCount += 1;
      else if (finding.status === "conflict") conflictCount += 1;
    }
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ref: refSha, merges, realCount, expectedCount, conflictCount }, null, 2)}\n`);
  } else {
    for (const merge of merges) {
      if (merge.findings.length === 0 && !merge.skipped) continue;
      process.stdout.write(`== ${merge.subject}${merge.skipped ? ` [skipped: ${merge.skipped}]` : ""}\n`);
      for (const f of merge.findings) {
        const tag = f.expected ? "expected" : f.status;
        process.stdout.write(`   [${tag}] 丢${f.lostSide === "first-parent" ? "第一父(ours)" : "第二父(theirs)"}侧 ${f.path}\n`);
      }
    }
    process.stdout.write(
      `\naudited ${merges.length} merge(s): ${realCount} real loss, ${conflictCount} conflict (needs human), ${expectedCount} expected noise\n`,
    );
    if (realCount > 0) {
      process.stdout.write("real loss = 该侧改动至今不在被审计 ref 上。逐项恢复缺失语义后，重新运行同一审计确认归零。\n");
    }
  }

  // 不用 process.exit()：piped stdout 的缓冲会被硬退出截断（大 JSON 输出 64KB 处断裂）。
  process.exitCode = realCount > 0 ? 1 : 0;
}

main();
