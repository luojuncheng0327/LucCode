/**
 * post-update-announcement.cjs — 升级后首启公告的触发决策与合订本切片
 *
 * 契约：
 * - lastSeenVersion 记录在 {LUC_HOME}/user/last-seen-version.json，只在
 *   用户确认公告（ack）或全新安装播种（seed）时写入。它同时就是累积
 *   更新摘要（合订本）的书签——"看到哪一版"只有一个语义，只有这一个
 *   状态归属，禁止另设第二个书签文件。
 * - 全新安装（未完成 onboarding 且无记录）静默播种当前版本，永不为
 *   "从无到有"弹公告；已完成 onboarding 却无记录 = 从没有此功能的老版本
 *   升级而来，视为升级后首启。
 * - 非打包环境不弹也不写（LUC_FORCE_ANNOUNCEMENT=1 可在开发期强制视为打包）。
 * - 弹窗内容来自随包 release digest 史册（release-digest.v2.json，v1 单版
 *   文件作 read-time 兜底），按 (书签, 当前] 区间切片、新→旧展示。
 */
function resolvePostUpdateAnnouncement({ currentVersion, lastSeenVersion, isPackagedLike, setupComplete }) {
  if (!isPackagedLike) return { pending: false, seedVersion: null };
  if (typeof currentVersion !== "string" || !currentVersion) return { pending: false, seedVersion: null };
  if (lastSeenVersion === currentVersion) return { pending: false, seedVersion: null };
  if (!lastSeenVersion && !setupComplete) return { pending: false, seedVersion: currentVersion };
  return { pending: true, seedVersion: null };
}

/**
 * 解析产品版本为数值三元组（容忍前缀 v，忽略 -prerelease / +build 后缀）。
 * 排序只看 major.minor.patch，不引入 prerelease 先后语义。不可解析返回 null。
 */
function parseProductVersion(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/.exec(String(version == null ? "" : version).trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * 语义化版本比较：a > b 返回正数，a < b 返回负数，相等返回 0。
 * 任一侧不可解析返回 null，调用方必须自行防御（禁止把 null 当 0 用）。
 */
function compareProductVersions(a, b) {
  const left = parseProductVersion(a);
  const right = parseProductVersion(b);
  if (!left || !right) return null;
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return 0;
}

/**
 * read-time compat（项目铁律：改持久化结构必须兼容老数据）：
 * 优先取 v2 史册（{schema: 2, entries: [...]}）的 entries；v2 缺失或
 * 结构不对时，把 v1 单版摘要当作单条史册；两者皆无返回空数组。
 * 只做结构甄别，不做逐条校验——条目级的有效性由消费侧
 * （normalizeReleaseDigest / sliceDigestHistory）负责。
 */
function coerceDigestHistory(v2Value, v1Value) {
  if (
    v2Value
    && typeof v2Value === "object"
    && !Array.isArray(v2Value)
    && v2Value.schema === 2
    && Array.isArray(v2Value.entries)
    && v2Value.entries.length > 0
  ) {
    return v2Value.entries;
  }
  if (v1Value && typeof v1Value === "object" && !Array.isArray(v1Value)) {
    return [v1Value];
  }
  return [];
}

/**
 * 书签区间切片：
 * - 常规：取 (lastSeenVersion, currentVersion] 区间的全部条目，新→旧。
 *   书签比史册最老条目还老（"书签不在史册里"）时自然取到全部 ≤ 当前的条目。
 * - 无书签（老用户首次遇到本机制）或书签不可解析：只取当前版本一节，
 *   不追溯轰炸。
 * - 版本比当前更新的条目（史册超前于本地安装）一律排除。
 * - 无版本或版本不可解析的条目丢弃；输出始终按版本新→旧排序。
 */
function sliceDigestHistory({ entries, lastSeenVersion, currentVersion }) {
  if (!Array.isArray(entries) || !parseProductVersion(currentVersion)) return [];
  const usable = entries
    .filter((entry) => entry && typeof entry === "object" && parseProductVersion(entry.version))
    .filter((entry) => compareProductVersions(entry.version, currentVersion) <= 0)
    .sort((a, b) => compareProductVersions(b.version, a.version));

  const markerParsed = parseProductVersion(lastSeenVersion);
  if (!markerParsed) {
    // 无书签 / 书签损坏：只展示当前版本一节，避免第一次升级时追溯轰炸。
    return usable.filter((entry) => compareProductVersions(entry.version, currentVersion) === 0);
  }
  return usable.filter((entry) => compareProductVersions(entry.version, lastSeenVersion) > 0);
}

module.exports = {
  resolvePostUpdateAnnouncement,
  parseProductVersion,
  compareProductVersions,
  coerceDigestHistory,
  sliceDigestHistory,
};
