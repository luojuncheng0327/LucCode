const MASKED_VALUE = "********";
const SENSITIVE_KEY_RE = /token|secret|password|api[_-]?key|authorization|credential/i;

function isPlainObject(value: any) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isSensitiveKey(key: any) {
  return typeof key === "string" && SENSITIVE_KEY_RE.test(key);
}

function redactSensitive(value: any, parentKey = "") {
  if (isSensitiveKey(parentKey)) return MASKED_VALUE;
  if (Array.isArray(value)) return value.map((item: any) => redactSensitive(item));
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, val]: [string, any]) => [key, redactSensitive(val, key)]),
    );
  }
  return value;
}

export function formatSettingsValue(value: any, { key = "", sensitive = false } = {}) {
  if (sensitive || isSensitiveKey(key)) return MASKED_VALUE;
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  try {
    return JSON.stringify(redactSensitive(value, key));
  } catch {
    return String(value);
  }
}

export function createSettingsUpdate(input: any = {}) {
  const status = input.status || "applied";
  const key = input.key || input.action || "settings";
  const changes = Array.isArray(input.changes)
    ? input.changes.map((change: any) => ({
      key: change?.key || key,
      label: change?.label || change?.key || key,
      before: formatSettingsValue(change?.before, { key: change?.key, sensitive: change?.sensitive }),
      after: formatSettingsValue(change?.after, { key: change?.key, sensitive: change?.sensitive }),
      ...(change?.sensitive ? { sensitive: true } : {}),
    }))
    : [];
  const title = input.title || defaultTitle(status);
  const summary = input.summary || defaultSummary({ status, title, changes });
  return {
    status,
    action: input.action || "settings.apply",
    key,
    title,
    summary,
    ...(input.target ? { target: input.target } : {}),
    changes,
  };
}

export function formatSettingsUpdateText(update: any) {
  if (!update || typeof update !== "object") return "";
  const title = update.title || defaultTitle(update.status);
  const lines = [title];
  if (update.summary && update.summary !== title) {
    lines.push(update.summary);
  }
  const changes = Array.isArray(update.changes) ? update.changes : [];
  if (changes.length > 0) {
    lines.push("Changes:");
    for (const change of changes) {
      const label = change?.label || change?.key || "Setting";
      const before = formatSettingsValue(change?.before, { key: change?.key, sensitive: change?.sensitive });
      const after = formatSettingsValue(change?.after, { key: change?.key, sensitive: change?.sensitive });
      lines.push(`- ${label}: ${before} -> ${after}`);
    }
  }
  return lines.join("\n");
}

export function createSettingsToolResult(update: any, extraDetails: any = {}) {
  const settingsUpdate = createSettingsUpdate(update);
  return {
    content: [{ type: "text", text: formatSettingsUpdateText(settingsUpdate) }],
    details: {
      ...extraDetails,
      settingsUpdate,
    },
  };
}

function defaultTitle(status: any) {
  if (status === "failed") return "Settings change failed";
  if (status === "skipped") return "Settings unchanged";
  if (status === "needs_action") return "Settings need more information";
  return "Settings updated";
}

function defaultSummary({ status, title, changes }: any) {
  if (changes.length === 0) return title;
  const first = changes[0];
  const label = first.label || first.key || "Setting";
  if (status === "failed") return `${label} was not changed.`;
  if (first.before === first.after) return `${label} is already ${first.after}.`;
  return `${label} changed from ${first.before} to ${first.after}.`;
}
