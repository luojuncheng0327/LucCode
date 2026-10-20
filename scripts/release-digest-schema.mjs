import announcement from "../desktop/src/shared/post-update-announcement.cjs";

const { compareProductVersions } = announcement;

export const DIGEST_SCHEMA_VERSION = 1;
export const DIGEST_ASSET_NAME = "release-digest.v1.json";

// ── v2 滚动史册（合订本）──
// {schema: 2, entries: [<v1 digest>, ...]}，entries 按版本严格递减
// （新→旧），上限 50 条，生成时裁剪。v1 单版文件保留不删，供旧读取
// 路径与 CI 上传继续使用。版本比较的唯一源是
// desktop/src/shared/post-update-announcement.cjs（客户端切片与此处
// 校验必须用同一把尺子）。
export const DIGEST_HISTORY_SCHEMA_VERSION = 2;
export const DIGEST_HISTORY_ASSET_NAME = "release-digest.v2.json";
export const DIGEST_HISTORY_MAX_ENTRIES = 50;

export const DIGEST_KINDS = ["feature", "fix", "improvement", "migration"];
export const DIGEST_IMPORTANCE = ["high", "medium", "low"];
export const DIGEST_SOURCE_TYPES = ["commit", "release-notes", "pull-request", "issue"];

const localizedTextSchema = {
  type: "object",
  additionalProperties: false,
  required: ["zh", "en"],
  properties: {
    zh: { type: "string" },
    en: { type: "string" },
  },
};

const sourceRefSchema = {
  type: "object",
  additionalProperties: false,
  required: ["type", "ref", "title"],
  properties: {
    type: { type: "string", enum: DIGEST_SOURCE_TYPES },
    ref: { type: "string" },
    title: { type: "string" },
  },
};

export const RELEASE_DIGEST_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "tag",
    "version",
    "previousTag",
    "generatedAt",
    "noUserFacingChanges",
    "summary",
    "counts",
    "source",
    "items",
  ],
  properties: {
    schemaVersion: { type: "integer", enum: [DIGEST_SCHEMA_VERSION] },
    tag: { type: "string" },
    version: { type: "string" },
    previousTag: { type: "string" },
    generatedAt: { type: "string" },
    noUserFacingChanges: { type: "boolean" },
    summary: localizedTextSchema,
    counts: {
      type: "object",
      additionalProperties: false,
      required: ["feature", "fix", "improvement", "migration"],
      properties: {
        feature: { type: "integer", minimum: 0 },
        fix: { type: "integer", minimum: 0 },
        improvement: { type: "integer", minimum: 0 },
        migration: { type: "integer", minimum: 0 },
      },
    },
    source: {
      type: "object",
      additionalProperties: false,
      required: ["owner", "repo", "commitRange", "releaseUrl", "releaseNotes"],
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        commitRange: { type: "string" },
        releaseUrl: { type: "string" },
        releaseNotes: { type: "string" },
      },
    },
    items: {
      type: "array",
      maxItems: 12,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "kind", "importance", "title", "summary", "details", "sources"],
        properties: {
          id: { type: "string" },
          kind: { type: "string", enum: DIGEST_KINDS },
          importance: { type: "string", enum: DIGEST_IMPORTANCE },
          title: localizedTextSchema,
          summary: localizedTextSchema,
          details: {
            type: "array",
            maxItems: 4,
            items: localizedTextSchema,
          },
          sources: {
            type: "array",
            minItems: 1,
            maxItems: 8,
            items: sourceRefSchema,
          },
        },
      },
    },
  },
};

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function expectPlainObject(value, path, errors) {
  if (!isPlainObject(value)) {
    errors.push(`${path} must be an object`);
    return false;
  }
  return true;
}

function expectString(value, path, errors, { allowEmpty = false } = {}) {
  if (typeof value !== "string" || (!allowEmpty && value.trim() === "")) {
    errors.push(`${path} must be a${allowEmpty ? "" : " non-empty"} string`);
    return false;
  }
  return true;
}

function expectInteger(value, path, errors) {
  if (!Number.isInteger(value) || value < 0) {
    errors.push(`${path} must be a non-negative integer`);
    return false;
  }
  return true;
}

function validateLocalizedText(value, path, errors) {
  if (!expectPlainObject(value, path, errors)) return;
  expectString(value.zh, `${path}.zh`, errors);
  expectString(value.en, `${path}.en`, errors);
}

function validateSourceRef(value, path, errors) {
  if (!expectPlainObject(value, path, errors)) return;
  if (!DIGEST_SOURCE_TYPES.includes(value.type)) {
    errors.push(`${path}.type must be a known source type`);
  }
  expectString(value.ref, `${path}.ref`, errors);
  expectString(value.title, `${path}.title`, errors);
}

export function validateReleaseDigest(value) {
  const errors = [];

  if (!expectPlainObject(value, "digest", errors)) {
    return { ok: false, errors };
  }

  if (value.schemaVersion !== DIGEST_SCHEMA_VERSION) {
    errors.push(`digest.schemaVersion must be ${DIGEST_SCHEMA_VERSION}`);
  }
  expectString(value.tag, "digest.tag", errors);
  expectString(value.version, "digest.version", errors);
  expectString(value.previousTag, "digest.previousTag", errors);
  expectString(value.generatedAt, "digest.generatedAt", errors);
  if (typeof value.noUserFacingChanges !== "boolean") {
    errors.push("digest.noUserFacingChanges must be a boolean");
  }

  validateLocalizedText(value.summary, "digest.summary", errors);

  if (expectPlainObject(value.counts, "digest.counts", errors)) {
    for (const key of DIGEST_KINDS) {
      expectInteger(value.counts[key], `digest.counts.${key}`, errors);
    }
  }

  if (expectPlainObject(value.source, "digest.source", errors)) {
    expectString(value.source.owner, "digest.source.owner", errors);
    expectString(value.source.repo, "digest.source.repo", errors);
    expectString(value.source.commitRange, "digest.source.commitRange", errors);
    expectString(value.source.releaseUrl, "digest.source.releaseUrl", errors, { allowEmpty: true });
    expectString(value.source.releaseNotes, "digest.source.releaseNotes", errors, { allowEmpty: true });
  }

  if (!Array.isArray(value.items)) {
    errors.push("digest.items must be an array");
  } else {
    if (!value.noUserFacingChanges && value.items.length === 0) {
      errors.push("digest.items must not be empty unless noUserFacingChanges is true");
    }
    if (value.items.length > 12) {
      errors.push("digest.items must contain at most 12 items");
    }
    value.items.forEach((item, index) => {
      const path = `digest.items[${index}]`;
      if (!expectPlainObject(item, path, errors)) return;
      expectString(item.id, `${path}.id`, errors);
      if (!DIGEST_KINDS.includes(item.kind)) {
        errors.push(`${path}.kind must be one of ${DIGEST_KINDS.join(", ")}`);
      }
      if (!DIGEST_IMPORTANCE.includes(item.importance)) {
        errors.push(`${path}.importance must be one of ${DIGEST_IMPORTANCE.join(", ")}`);
      }
      validateLocalizedText(item.title, `${path}.title`, errors);
      validateLocalizedText(item.summary, `${path}.summary`, errors);
      if (!Array.isArray(item.details)) {
        errors.push(`${path}.details must be an array`);
      } else if (item.details.length > 4) {
        errors.push(`${path}.details must contain at most 4 entries`);
      } else {
        item.details.forEach((detail, detailIndex) => {
          validateLocalizedText(detail, `${path}.details[${detailIndex}]`, errors);
        });
      }
      if (!Array.isArray(item.sources) || item.sources.length === 0) {
        errors.push(`${path}.sources must be a non-empty array`);
      } else {
        item.sources.forEach((source, sourceIndex) => {
          validateSourceRef(source, `${path}.sources[${sourceIndex}]`, errors);
        });
      }
    });
  }

  return { ok: errors.length === 0, errors };
}

export function assertValidReleaseDigest(value) {
  const result = validateReleaseDigest(value);
  if (!result.ok) {
    throw new Error(`Invalid release digest:\n${result.errors.map(error => `- ${error}`).join("\n")}`);
  }
  return value;
}

/**
 * 校验 v2 滚动史册：schema 标记、entries 非空且 ≤ 上限、每条通过 v1
 * 单版校验、版本严格递减（语义化比较，不做字典序）。版本"连续性"
 * 不强制（允许中间版本缺席），但顺序必须严格递减。
 */
export function validateReleaseDigestHistory(value) {
  const errors = [];

  if (!isPlainObject(value)) {
    return { ok: false, errors: ["history must be an object"] };
  }
  if (value.schema !== DIGEST_HISTORY_SCHEMA_VERSION) {
    errors.push(`history.schema must be ${DIGEST_HISTORY_SCHEMA_VERSION}`);
  }
  if (!Array.isArray(value.entries)) {
    errors.push("history.entries must be an array");
    return { ok: false, errors };
  }
  if (value.entries.length === 0) {
    errors.push("history.entries must not be empty");
  }
  if (value.entries.length > DIGEST_HISTORY_MAX_ENTRIES) {
    errors.push(`history.entries must contain at most ${DIGEST_HISTORY_MAX_ENTRIES} entries`);
  }

  value.entries.forEach((entry, index) => {
    const result = validateReleaseDigest(entry);
    if (!result.ok) {
      for (const error of result.errors) {
        errors.push(`history.entries[${index}]: ${error}`);
      }
    }
  });

  for (let i = 0; i + 1 < value.entries.length; i += 1) {
    const newer = value.entries[i] && value.entries[i].version;
    const older = value.entries[i + 1] && value.entries[i + 1].version;
    const cmp = compareProductVersions(newer, older);
    if (cmp === null) {
      errors.push(`history.entries[${i}]/[${i + 1}] versions must be semver-comparable (got ${newer} / ${older})`);
    } else if (cmp <= 0) {
      errors.push(`history.entries must be strictly decreasing by version (entries[${i}] ${newer} <= entries[${i + 1}] ${older})`);
    }
  }

  return { ok: errors.length === 0, errors };
}

export function assertValidReleaseDigestHistory(value) {
  const result = validateReleaseDigestHistory(value);
  if (!result.ok) {
    throw new Error(`Invalid release digest history:\n${result.errors.map(error => `- ${error}`).join("\n")}`);
  }
  return value;
}

/**
 * 追加语义（每次发版"追加一节"而非替换文件）：
 * - history 为空/缺失 → 以 digest 为唯一条目新建史册（首次迁移）。
 * - digest.version > 头部 → 插到头部，老 entries 原样保留。
 * - digest.version = 头部 → 覆盖头部条目（手写工作流修订后幂等重跑）。
 * - digest.version < 头部 → 抛错，拒绝旧版本倒灌。
 * - 超过上限时裁掉最老的条目。不修改输入，返回新对象。
 */
export function appendDigestToHistory(history, digest) {
  assertValidReleaseDigest(digest);

  const baseEntries = isPlainObject(history) && Array.isArray(history.entries) ? history.entries : [];
  if (baseEntries.length === 0) {
    return { schema: DIGEST_HISTORY_SCHEMA_VERSION, entries: [digest] };
  }

  const head = baseEntries[0];
  const cmp = compareProductVersions(digest.version, head && head.version);
  if (cmp === null) {
    throw new Error(`cannot compare digest version ${digest.version} with history head ${head && head.version}`);
  }

  let entries;
  if (cmp > 0) {
    entries = [digest, ...baseEntries];
  } else if (cmp === 0) {
    entries = [digest, ...baseEntries.slice(1)];
  } else {
    throw new Error(
      `digest version ${digest.version} is older than history head ${head.version}; history must stay strictly decreasing`,
    );
  }

  return {
    schema: DIGEST_HISTORY_SCHEMA_VERSION,
    entries: entries.slice(0, DIGEST_HISTORY_MAX_ENTRIES),
  };
}
