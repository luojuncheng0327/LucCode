import crypto from "crypto";
import fs from "fs";
import path from "path";
import { capabilityDecisionSummary } from "./capability-policy.ts";
import { principalSummary } from "./security-principal.ts";
import { MASKED_SECRET } from "../shared/secret-custody.ts";

export const SECURITY_AUDIT_LOG_FILE = "security-audit.jsonl";

export function securityAuditLogPath(lucHome) {
  if (!lucHome) throw new Error("lucHome required");
  return path.join(lucHome, "logs", SECURITY_AUDIT_LOG_FILE);
}

export function appendSecurityAuditEvent(lucHome, event, {
  now = new Date().toISOString(),
  eventId = `sec_${crypto.randomUUID()}`,
} = {}) {
  if (!lucHome) return null;
  const record = normalizeAuditEvent(event, { now, eventId });
  const filePath = securityAuditLogPath(lucHome);
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, "utf-8");
    return record;
  } catch {
    return null;
  }
}

export function buildSecurityAuditActor(principal) {
  if (!principal || typeof principal !== "object") {
    return { kind: "unknown" };
  }
  return sanitizeObject(principalSummary(principal));
}

function normalizeAuditEvent(event, { now, eventId }) {
  const source = event && typeof event === "object" ? event : {};
  return sanitizeObject({
    schemaVersion: 1,
    eventId,
    timestamp: now,
    action: source.action || "unknown",
    target: source.target || null,
    result: source.result || "unknown",
    actor: buildSecurityAuditActor(source.actor || source.principal),
    decision: capabilityDecisionSummary(source.decision) || null,
    leaseId: source.leaseId || null,
    errorCode: source.errorCode || null,
    secretFields: normalizeStringArray(source.secretFields),
    metadata: sanitizeObject(source.metadata || {}),
  });
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => typeof item === "string" && item.trim().length > 0)
    .map((item) => sanitizeString(item.trim()));
}

function sanitizeObject(value) {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => sanitizeObject(item));
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) continue;
    const safeKey = sanitizeString(key);
    out[safeKey] = isSecretLikeKey(key) ? maskAuditSecret(entry) : sanitizeValue(entry);
  }
  return out;
}

function sanitizeValue(value) {
  if (typeof value === "string") return sanitizeString(value);
  if (Array.isArray(value) || (value && typeof value === "object")) return sanitizeObject(value);
  return value;
}

function sanitizeString(value) {
  return String(value).replace(/[\r\n\t]/g, " ").slice(0, 500);
}

function isSecretLikeKey(key) {
  const normalized = String(key || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return normalized === "apikey"
    || normalized === "apitoken"
    || normalized === "bottoken"
    || normalized === "appsecret"
    || normalized === "secret"
    || normalized === "password"
    || normalized === "accesstoken"
    || normalized === "refreshtoken"
    || normalized.endsWith("secret")
    || normalized.endsWith("token")
    || normalized.endsWith("password");
}

function maskAuditSecret(value) {
  if (value === "" || value === null || value === undefined) return "";
  return MASKED_SECRET;
}
