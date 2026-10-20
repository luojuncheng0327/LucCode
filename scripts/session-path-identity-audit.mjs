#!/usr/bin/env node
import fs from "fs";
import path from "path";

const DEFAULT_ROOTS = ["core", "lib", "server", "desktop/src/react", "shared", "tests", "scripts"];
const TEXT_EXTENSIONS = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
]);
const EXCLUDED_SEGMENTS = new Set([
  ".cache",
  ".claude",
  ".git",
  "coverage",
  "dist",
  "dist-computer-use",
  "dist-sandbox",
  "dist-server",
  "node_modules",
]);

const APPROVED_IDENTITY_BOUNDARY_RULES = [
  {
    file: /(^|\/)lib\/browser\/browser-manager\.ts$/,
    patterns: [
      /\b_sessionKeyForPath\b/,
      /\b_coldStateLookupKeys\b/,
      /\b_coldStateRecordForSession\b/,
      /\b_deleteColdStateKeysForSession\b/,
      /\bsession identity key\b/i,
      /\bbrowser session identity lookup\b/i,
      /new Set\(\[identityKey,\s*sessionPath\]/,
      /this\._sessions\.get\(key\).*sessionPath/,
      /this\._sessions\.set\(key,.*sessionPath/,
      /this\._sessions\.delete\(sessionPath\)/,
      /state\[key\].*sessionPath/,
      /\bsessionPath\s*=\s*entry\?\.sessionPath\s*\|\|/,
      /\bkey\s*!==\s*sessionPath\b/,
      /\bentry\?\.sessionPath\s*\|\|\s*key\b/,
      /\bpressKey\(key,\s*sessionPath\b/,
      /\bparams(?:\s*:\s*\w+)?\s*=\s*\{\s*key,\s*sessionPath\s*\}/,
      /\bgetBrowserSessionStates\b/,
      /\.map\(\(\[sessionPath,\s*state\]/,
    ],
  },
  {
    file: /(^|\/)core\/computer-use\/lease-registry\.ts$/,
    patterns: [
      /\bleaseOwnerKey\(sessionId,\s*sessionPath\)/,
      /\bsessionId\s*\|\|\s*sessionPath\s*\|\|\s*null\b/,
      /\bleaseKey\(lease\.sessionId,\s*lease\.sessionPath\b/,
      /\bleaseKey\(ref\.sessionId,\s*ref\.sessionPath\b/,
    ],
  },
  {
    file: /(^|\/)core\/current-turn-native-media\.ts$/,
    patterns: [
      /\bkey:\s*sessionId\s*\|\|\s*sessionPath\b/,
      /\bkey:\s*sessionPath\b/,
      /\bnormalizeSessionRef\b/,
    ],
  },
  {
    file: /(^|\/)(core\/capability-policy|core\/grant-registry)\.ts$/,
    patterns: [
      /"sessionId".*"sessionPath"/,
      /"sessionPath".*"sessionId"/,
    ],
  },
  {
    file: /(^|\/)core\/desktop-session-submit\.ts$/,
    patterns: [
      /\bref\.sessionId\s*\|\|\s*ref\.sessionPath\b/,
      /\bsessionId\s*\|\|\s*sessionPath\b/,
    ],
  },
  {
    file: /(^|\/)core\/engine\.ts$/,
    patterns: [
      /\b_sessionRuntimeKeyForPath\b/,
      /\b_deleteSessionRuntimeMapEntry\b/,
      /\b_deleteSessionRuntimeSetEntry\b/,
      /\b_uiContextBySession\.delete\(sessionPath\)/,
      /\b_uiContextBySession\.get\(sessionPath\)/,
      /\bsessionPaths:\s*affectedSessions\.map\(session => session\.path\)/,
    ],
  },
  {
    file: /(^|\/)core\/session-coordinator\.ts$/,
    patterns: [
      /\b_sessionRuntimeKeyForPath\b/,
      /\b_getSessionEntryByPath\b/,
      /\b_setRuntimeValueForPath\b/,
      /\b_getRuntimeValueForPath\b/,
      /\b_deleteRuntimeValueForPath\b/,
      /\b_hasRuntimeValueForPath\b/,
      /\bsession runtime key lookup failed\b/,
      /this\._sessions\.get\(key\).*sessionPath/,
      /\bmap\.delete\(sessionPath\)/,
      /\bmap\.get\(sessionPath\)/,
      /\bmap\.has\(sessionPath\)/,
      /\bSession cache snapshot unavailable\b/,
      /\bsession memory requires sessionPath\b/,
      /\bswitchSession: path must be\b/,
      /\bpath must be an active desktop session\b/,
      /确保 sessionPath 已加载/,
    ],
  },
  {
    file: /(^|\/)core\/migrations\.ts$/,
    patterns: [
      /\brememberChildSessionIdentity\b/,
      /\bchildSessionCandidates\b/,
      /!sessionPath\s*\|\|\s*!identity/,
      /\bsessionIdFromFilename\(path\.basename\(sessionPath\)\)/,
    ],
  },
  {
    file: /(^|\/)core\/agent\.ts$/,
    patterns: [
      /\bgetBridgeContextForSessionPath\b/,
    ],
  },
  {
    file: /(^|\/)core\/slash-commands\/rc-pending-handler\.ts$/,
    patterns: [
      /\bsummarizeSessionForRc\(engine,\s*agent,\s*sessionPath\)/,
    ],
  },
  {
    file: /(^|\/)core\/vision-bridge\.ts$/,
    patterns: [
      /\b_sessionRefForPath\b/,
      /\b_sessionIdForPath\b/,
      /\b_noteCacheKeys\b/,
      /\b_lookupNote\(sessionPath\b/,
      /\b_rememberNote\(sessionPath\b/,
      /\b_persistNote\(sessionPath\b/,
      /\bsessionId\s*\|\|\s*legacyKey\b/,
      /\bentry\?\.sessionId\b/,
      /\bsessionRef\.sessionId\b/,
    ],
  },
  {
    file: /(^|\/)lib\/memory\/memory-ticker\.ts$/,
    patterns: [
      /\b_sessionIdentityForPath\b/,
      /\bgetSessionIdForPath\b/,
      /\bsessionIdFromFilename\(path\.basename\(sessionPath\)\)/,
      /\b_turnCounts\.set\(_sessionIdentityForPath\(sessionPath\)/,
      /\bpath\.basename\(sessionPath\)/,
    ],
  },
  {
    file: /(^|\/)lib\/session-files\/session-file-registry\.ts$/,
    patterns: [
      /\b_sessionKeyForPath\b/,
      /\bsessionFileOwnerKey\b/,
      /\bnormalizeSessionId\(sessionId\)/,
      /\b_resolveSessionIdForPath\(sessionPath\)/,
      /new Set\(\[entry\.sessionPath,\s*requestedSessionPath\]/,
      /\bsessionId\s*\?\s*new Set\(\[sessionId\]\)/,
    ],
  },
  {
    file: /(^|\/)lib\/terminal\/terminal-session-manager\.ts$/,
    patterns: [
      /\b_sessionKeyForPath\b/,
      /\b_entryMatchesSessionPath\b/,
      /this\._bySession\.get\(this\._sessionKeyForPath\(normalizedSessionPath\)\)/,
    ],
  },
  {
    file: /(^|\/)lib\/session-files\/(bridge-inbound-files|browser-screenshot-file)\.ts$/,
    patterns: [
      /\bsessionFilesCacheDir\(lucHome,\s*\{\s*sessionId,\s*sessionPath\s*\}\)/,
      /\b\.\.\.\(sessionId\s*\?\s*\{\s*sessionId\s*\}\s*:\s*\{\}\)/,
    ],
  },
  {
    file: /(^|\/)lib\/sandbox\/read-office-media\.ts$/,
    patterns: [
      /\bofficeMediaResourceKey\b/,
      /\bh\.update\(sessionId\s*\|\|\s*sessionPath\s*\|\|\s*""\)/,
      /\bsessionFilesCacheDir\(lucHome,\s*\{\s*sessionId,\s*sessionPath\s*\}\)/,
      /\b\.\.\.\(sessionId\s*\?\s*\{\s*sessionId\s*\}\s*:\s*\{\}\)/,
    ],
  },
  {
    file: /(^|\/)server\/routes\/upload\.ts$/,
    patterns: [
      /\bconst sessionId = engine\?\.getSessionIdForPath\?\.\(sessionPath\)/,
      /\bsessionFilesCacheDir\(engine\.luccodeHome,\s*\{\s*sessionId,\s*sessionPath\s*\}\)/,
      /\bsession-files\/<session-hash>/,
    ],
  },
  {
    file: /(^|\/)server\/routes\/chat\.ts$/,
    patterns: [
      /\bsessionIdForPath\b/,
      /\bsessionStateKey\b/,
      /\bsessionState\.has\(sessionPath\)/,
      /\bsessionState\.set\(key,\s*sessionState\.get\(sessionPath\)\)/,
    ],
  },
  {
    file: /(^|\/)lib\/tools\/browser-tool\.ts$/,
    patterns: [
      /\bactionLogKey\b/,
      /\bbrowser\.pressKey\(params\.key,\s*sessionPath\b/,
      /\bstatusFields\(sessionPath\)/,
    ],
  },
  {
    file: /(^|\/)lib\/tools\/session-folders-tool\.ts$/,
    patterns: [
      /\bstableSessionKey\b/,
      /\bstableKey\s*\|\|\s*sessionPath\s*\|\|\s*"session"/,
    ],
  },
  {
    file: /(^|\/)lib\/confirm-store\.ts$/,
    patterns: [
      /\bMap<string,\s*\{\s*resolve,\s*timer,\s*sessionId,\s*sessionPath\b/,
    ],
  },
  {
    file: /(^|\/)lib\/tools\/current-status-tool\.ts$/,
    patterns: [
      /\bdeps\.listSessionFiles\(sessionPath\)/,
      /\bdeps\.listOpenSubagentThreads\(sessionPath\)/,
    ],
  },
  {
    file: /(^|\/)lib\/tools\/workflow-tool\.ts$/,
    patterns: [
      /\bhub\?\.upsert\(\{.*sessionId:\s*parentSessionId,\s*sessionPath:\s*parentSessionPath\b/,
    ],
  },
  {
    file: /(^|\/)server\/routes\/sessions\.ts$/,
    patterns: [
      /\bsessionIdFromFilename\(path\.basename\(sessionPath\)\)/,
    ],
  },
  {
    file: /(^|\/)desktop\/src\/react\/stores\/message-live-version\.ts$/,
    patterns: [
      /\bmessageLiveSessionKey\b/,
      /\b_messageLiveVersionBySession\b/,
      /\bkeyForSession\b/,
      /\bkey\s*!==\s*sessionPath\b/,
    ],
  },
  {
    file: /(^|\/)desktop\/src\/react\/stores\/session-slice\.ts$/,
    patterns: [
      /\bsessionIdForPathFromLocatorState\b/,
      /\bsessionScopedKey\b/,
      /\bsessionScopedValue\b/,
      /\bsessionScopedListIncludes\b/,
      /\bputSessionScopedListValue\b/,
      /\bdeleteSessionScopedListValue\b/,
      /\bputSessionScopedValue\b/,
      /\bdeleteSessionScopedValue\b/,
      /\bsessionLocatorsById\b/,
      /\bsetCurrentSessionPath\b/,
      /\btodosLiveVersionBySession\b/,
      /\bkey\s*!==\s*sessionPath\b/,
      /\blist\.includes\(sessionPath\)/,
      /\blist\.filter\(\(item\) => item !== key && item !== sessionPath\)/,
    ],
  },
  {
    file: /(^|\/)desktop\/src\/react\/stores\/selection-slice\.ts$/,
    patterns: [
      /\bsessionScopedKey\b/,
      /\bsessionScopedValue\b/,
      /\btoggleMessageSelection\b/,
      /\bsetMessageSelection\b/,
      /\baddMessagesToSelection\b/,
      /\bclearSelection\b/,
      /\bdelete copy\[sessionPath\]/,
    ],
  },
  {
    file: /(^|\/)desktop\/src\/react\/stores\/computer-overlay-slice\.ts$/,
    patterns: [
      /\bsessionScopedKey\b/,
      /\bsessionScopedValue\b/,
      /\bsetComputerOverlayForSession\b/,
      /\bclearComputerOverlayForSession\b/,
      /\bdelete computerOverlayBySession\[sessionPath\]/,
    ],
  },
  {
    file: /(^|\/)desktop\/src\/react\/stores\/browser-slice\.ts$/,
    patterns: [
      /\bsessionScopedKey\b/,
      /\bsessionScopedValue\b/,
      /\bbrowserBySession\b/,
      /\bkey\s*!==\s*sessionPath\b/,
    ],
  },
  {
    file: /(^|\/)desktop\/src\/react\/stores\/create-keyed-slice\.ts$/,
    patterns: [
      /\bupdateKeyed\b/,
      /\bsessionScopedKey\b/,
      /\bdelete keyed\[sessionPath\]/,
    ],
  },
  {
    file: /(^|\/)desktop\/src\/react\/stores\/agent-activity-slice\.ts$/,
    patterns: [
      /\bsessionScopedKey\b/,
      /\bsessionScopedValue\b/,
      /\bagentActivitiesBySession\b/,
    ],
  },
  {
    file: /(^|\/)desktop\/src\/react\/components\/ChannelsPanel\.tsx$/,
    patterns: [
      /\bactivitySessionPath\b/,
      /\bhistory\.map\(activitySessionPath\)/,
    ],
  },
  {
    file: /(^|\/)desktop\/src\/react\/components\/app\/ChatPage\.tsx$/,
    patterns: [
      /\bcurrentSessionPath\b/,
      /<InputArea key=\{currentSessionPath/,
    ],
  },
  {
    file: /(^|\/)desktop\/src\/react\/components\/chat\/AssistantMessage\.tsx$/,
    patterns: [
      /\blazyScreenshot\b/,
      /\bfn\(message\.id,\s*sessionPath\)/,
      /\[message\.id,\s*sessionPath\]/,
    ],
  },
  {
    file: /(^|\/)desktop\/src\/react\/components\/chat\/SubagentSessionPreview\.tsx$/,
    patterns: [
      /\bsessionId\s*=\s*null,\s*sessionPath\b/,
      /\bSubagentSessionPreview\b/,
    ],
  },
  {
    file: /(^|\/)desktop\/src\/react\/components\/chat\/UserMessage\.tsx$/,
    patterns: [
      /\blinkContext=\{\{\s*origin:\s*'session',\s*sessionPath,\s*messageId\b/,
    ],
  },
  {
    file: /(^|\/)desktop\/src\/react\/hooks\/use-box-selection\.ts$/,
    patterns: [
      /\bsetMessageSelection\(sessionPath\b/,
      /\baddMessagesToSelection\(sessionPath\b/,
      /\btoggleMessageSelection\(sessionPath\b/,
    ],
  },
  {
    file: /(^|\/)desktop\/src\/react\/services\/ws-message-handler\.ts$/,
    patterns: [
      /\baddStreamingSession\(sessionPath,\s*identity\)/,
      /\bremoveStreamingSession\(sessionPath,\s*identity\)/,
      /\bsession_confirmation missing sessionPath\b/,
      /\bsession_branch_reset missing sessionPath\b/,
    ],
  },
  {
    file: /(^|\/)desktop\/src\/react\/stores\/message-turn-actions\.ts$/,
    patterns: [
      /\bsessionScopedListIncludes\b/,
      /!sessionPath\s*\|\|\s*!message\?\.id/,
    ],
  },
  {
    file: /(^|\/)desktop\/src\/react\/stores\/selectors\/file-refs\.ts$/,
    patterns: [
      /\bsessionScopedKey\b/,
      /\bsessionScopedValue\b/,
      /\bsessionCacheKey\b/,
      /\bcached\.sessionPath\s*===\s*sessionPath\b/,
      /\bcachedSession\.set\(cacheKey,\s*\{\s*sessionPath,\s*sessionKey\b/,
      /不传 sessionPath 时清空整张 Map/,
    ],
  },
  {
    file: /(^|\/)desktop\/src\/react\/stores\/session-actions\.ts$/,
    patterns: [
      /\bputSessionScopedStateValue\b/,
      /\bdeleteSessionScopedStateValue\b/,
      /\bfilterSessionScopedStateList\b/,
      /\bsessionScopedKey\b/,
      /\bkey\s*!==\s*sessionPath\b/,
      /\breturn sessionPath !== key && sessionPath !== path\b/,
    ],
  },
  {
    file: /(^|\/)desktop\/src\/react\/stores\/session-project-actions\.ts$/,
    patterns: [
      /\bpathSet\s*=\s*new Set\(sessionPaths\)/,
      /\bsessions:\s*state\.sessions\.map\(session => session\.path === sessionPath\b/,
    ],
  },
  {
    file: /(^|\/)desktop\/src\/react\/stores\/subagent-preview-slice\.ts$/,
    patterns: [
      /\bopenSubagentPreview\b/,
      /\bsetSubagentPreviewSessionPath\b/,
    ],
  },
  {
    file: /(^|\/)desktop\/src\/react\/stores\/input-slice\.ts$/,
    patterns: [
      /\binputSessionKey\b/,
      /\bsyncAttachmentsForSession\b/,
      /\bsyncCurrentSessionAttachments\b/,
      /\bselectAttachedFilesForSession\b/,
      /\bsessionScopedKey\b/,
      /\battachedFilesBySession\b/,
      /\bdrafts\b/,
      /\bkey\s*!==\s*sessionPath\b/,
    ],
  },
  {
    file: /(^|\/)desktop\/src\/react\/services\/stream-resume\.ts$/,
    patterns: [
      /\bStreamSessionInput\b/,
      /\bResolvedStreamSession\b/,
      /\bstreamRefFromInput\b/,
      /\bresolveStreamSession\b/,
      /\bstreamIdentityKey\b/,
      /\breturn \{ sessionId, sessionPath, key, isCurrent \}/,
      /\btarget\.key\s*\|\|\s*target\.sessionPath\b/,
      /!target\.key\s*&&\s*!target\.sessionPath\b/,
      /\btarget\.sessionPath\s*&&\s*target\.sessionPath\s*!==\s*key\b/,
      /\btarget\.sessionPath\s*&&\s*key\s*!==\s*target\.sessionPath\b/,
    ],
  },
  {
    file: /(^|\/)desktop\/src\/react\/hooks\/use-stream-buffer\.ts$/,
    patterns: [
      /\bbufferKeyForSession\b/,
      /\bsessionScopedKey\b/,
      /\bbufferKeysByPath\b/,
      /\badoptBufferKey\b/,
      /\bdeleteBufferKey\b/,
      /\blookupBuffer\(sessionPath,\s*sessionId\)/,
      /\bkey\s*!==\s*sessionPath\b/,
    ],
  },
  {
    file: /(^|\/)lib\/bridge\/bridge-manager\.ts$/,
    patterns: [
      /\b_sessionIdentityKeyForPath\b/,
      /\bthis\._rcMirrorStreams\.(?:set|get|delete)\(streamKey/,
      /\bstreamKey\s*!==\s*sessionPath\b/,
    ],
  },
  {
    file: /(^|\/)scripts\/session-path-identity-audit\.mjs$/,
    patterns: [
      /.*/,
    ],
  },
];

function parseArgs(argv) {
  const args = {
    roots: [],
    json: false,
    failOnRisk: false,
  };
  for (const arg of argv) {
    if (arg === "--json") args.json = true;
    else if (arg === "--fail-on-risk") args.failOnRisk = true;
    else args.roots.push(arg);
  }
  if (args.roots.length === 0) args.roots = DEFAULT_ROOTS;
  return args;
}

function shouldSkip(fullPath) {
  return fullPath.split(path.sep).some((segment) => EXCLUDED_SEGMENTS.has(segment));
}

function walk(root, files = []) {
  if (!fs.existsSync(root) || shouldSkip(root)) return files;
  const stat = fs.statSync(root);
  if (stat.isFile()) {
    if (TEXT_EXTENSIONS.has(path.extname(root))) files.push(root);
    return files;
  }
  if (!stat.isDirectory()) return files;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    walk(path.join(root, entry.name), files);
  }
  return files;
}

function matchesApprovedIdentityBoundary(file, line) {
  const normalizedFile = file.split(path.sep).join("/");
  return APPROVED_IDENTITY_BOUNDARY_RULES.some((rule) => (
    rule.file.test(normalizedFile)
    && rule.patterns.some((pattern) => pattern.test(line))
  ));
}

function isPathKeyedSessionMetaLine(line) {
  return /\b(?:meta|raw|fileData)\s*\[[^\]]*path\.basename\(sessionPath(?:ForMeta)?\)/.test(line);
}

function isLegacySessionMetaBoundaryFile(normalizedFile) {
  return /(^|\/)core\/session-manifest\/legacy-migration\.ts$/.test(normalizedFile)
    || /(^|\/)core\/session-coordinator\.ts$/.test(normalizedFile)
    || /(^|\/)core\/migrations\.ts$/.test(normalizedFile)
    || /(^|\/)lib\/subagent-executor-metadata\.ts$/.test(normalizedFile);
}

// A-2 判决同族启发式：server/ 下裸 sessionPath 相等/不等过滤，是 ws-scope.ts
// 归档断流 bug 的确切代码形状。命中不代表有 bug（可能是已理解的兼容回退），
// 但值得单列出来供人工复核，而不是被 transport-or-ui-locator 的宽泛 server/
// 归类悄悄吞掉。
function isEqualityFilterReviewLine(normalizedFile, line) {
  if (!normalizedFile.startsWith("server/")) return false;
  return /sessionPath\s*!==/.test(line)
    || /!==\s*target\.sessionPath/.test(line)
    || /===\s*sessionPath\b/.test(line);
}

function classify(file, line) {
  const normalizedFile = file.split(path.sep).join("/");
  const text = line.toLowerCase();
  // "keyed" 与 "key" 共享词干但不共享 \b 边界：\bkey\b 匹配不到 "keyed"，
  // 会让 "keyed by sessionPath" 这类误导性注释被漏判成 uncategorized（假阴性）。
  const storageLike = /\b(map|set|cache|key|keyed|hash|summary|memory|pinned|pin|identity|id)\b/i.test(line)
    || text.includes("sessionfilescachedir")
    || text.includes("sessionidfromfilename");
  if (
    normalizedFile.startsWith("tests/")
    || normalizedFile.includes("/tests/")
    || normalizedFile.includes("/__tests__/")
  ) {
    return "test-fixture";
  }
  if (isPathKeyedSessionMetaLine(line)) {
    return isLegacySessionMetaBoundaryFile(normalizedFile)
      ? "legacy-session-meta-boundary"
      : "identity-risk";
  }
  if (matchesApprovedIdentityBoundary(normalizedFile, line)) {
    return "approved-identity-boundary";
  }
  if (normalizedFile.includes("/session-manifest/") || text.includes("locator") || text.includes("legacy")) {
    return "manifest-or-legacy-boundary";
  }
  if (
    /\bsession(scoped|ref|runtimekey|idforpath|idforpathfrom|identitypatch)/i.test(line)
    || text.includes("_sessionruntimekeyforpath")
    || text.includes("_getruntimevalueforpath")
    || text.includes("_setruntimevalueforpath")
    || text.includes("_deleteruntimevalueforpath")
    || text.includes("_hasruntimevalueforpath")
    || text.includes("_bridgecontextidentitykey")
    || text.includes("_bridgecontextlookupkeys")
    || text.includes("_bridgecontextwritekeys")
    || /\bgetsessionidforpath\b/i.test(line)
    || /\bsessionrefversion\b/i.test(line)
  ) {
    return "identity-adapter-boundary";
  }
  if (text.includes("currentsessionpath") && !storageLike) {
    return "focus-or-transport-locator";
  }
  if (
    storageLike
    || text.includes("currentsessionpath")
  ) {
    return "identity-risk";
  }
  if (isEqualityFilterReviewLine(normalizedFile, line)) {
    return "equality-filter-review";
  }
  if (
    /\b(fs|path)\./.test(line)
    || /\b(readfile|writefile|existssync|realpath|basename|dirname|sessiondir)\b/i.test(line)
  ) {
    return "filesystem-locator";
  }
  if (
    normalizedFile.startsWith("server/")
    || normalizedFile.startsWith("desktop/src/react/")
    || text.includes("payload")
    || text.includes("event")
  ) {
    return "transport-or-ui-locator";
  }
  return "uncategorized";
}

function collectMatches(roots) {
  const matches = [];
  for (const root of roots) {
    for (const file of walk(root)) {
      const rel = path.relative(process.cwd(), file);
      const lines = fs.readFileSync(file, "utf-8").split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        if (!line.includes("sessionPath") && !line.includes("currentSessionPath")) continue;
        matches.push({
          file: rel,
          line: index + 1,
          category: classify(rel, line),
          text: line.trim(),
        });
      }
    }
  }
  return matches;
}

function summarize(matches) {
  const counts = {};
  for (const match of matches) {
    counts[match.category] = (counts[match.category] || 0) + 1;
  }
  return {
    total: matches.length,
    counts,
    identityRisk: matches.filter((match) => match.category === "identity-risk"),
    equalityFilterReview: matches.filter((match) => match.category === "equality-filter-review"),
  };
}

function printText(report, matches) {
  console.log("Session path identity audit");
  console.log("===========================");
  console.log(`Total matches: ${report.total}`);
  for (const [category, count] of Object.entries(report.counts).sort()) {
    console.log(`- ${category}: ${count}`);
  }
  if (report.identityRisk.length > 0) {
    console.log("");
    console.log("Identity-risk samples:");
    for (const match of report.identityRisk.slice(0, 80)) {
      console.log(`${match.file}:${match.line}: ${match.text}`);
    }
    if (report.identityRisk.length > 80) {
      console.log(`... ${report.identityRisk.length - 80} more identity-risk matches`);
    }
  }
  if (report.equalityFilterReview.length > 0) {
    console.log("");
    console.log("Equality-filter-review samples (server/ 下裸 sessionPath 相等/不等过滤，人工复核):");
    for (const match of report.equalityFilterReview.slice(0, 40)) {
      console.log(`${match.file}:${match.line}: ${match.text}`);
    }
    if (report.equalityFilterReview.length > 40) {
      console.log(`... ${report.equalityFilterReview.length - 40} more equality-filter-review matches`);
    }
  }
  const uncategorized = matches.filter((match) => match.category === "uncategorized");
  if (uncategorized.length > 0) {
    console.log("");
    console.log("Uncategorized samples:");
    for (const match of uncategorized.slice(0, 40)) {
      console.log(`${match.file}:${match.line}: ${match.text}`);
    }
  }
}

const args = parseArgs(process.argv.slice(2));
const matches = collectMatches(args.roots);
const report = summarize(matches);

if (args.json) {
  console.log(JSON.stringify({ ...report, matches }, null, 2));
} else {
  printText(report, matches);
}

if (args.failOnRisk && report.identityRisk.length > 0) {
  process.exitCode = 1;
}
