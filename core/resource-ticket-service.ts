import crypto from "crypto";
import fs from "fs";
import path from "path";
import { atomicWriteSync } from "../shared/safe-fs.ts";
import { securityDirPath } from "./security-dir.ts";

export const RESOURCE_TICKET_KEY_FILE = "resource-ticket-key";
export const RESOURCE_TICKET_ACTION = "resources.content";
export const DEFAULT_RESOURCE_TICKET_TTL_MS = 5 * 60 * 1000;

export class ResourceTicketError extends Error {
  declare code: string;
  declare status: number;

  constructor(message: any, { code = "resource_ticket_invalid", status = 403 } = {}) {
    super(message);
    this.name = "ResourceTicketError";
    this.code = code;
    this.status = status;
  }
}

export function issueResourceTicket({
  lucHome,
  resourceId,
  studioId,
  principalId,
  now = new Date().toISOString(),
  ttlMs = DEFAULT_RESOURCE_TICKET_TTL_MS,
}: any = {}) {
  assertNonEmpty(lucHome, "lucHome");
  assertNonEmpty(resourceId, "resourceId");
  assertNonEmpty(studioId, "studioId");
  assertNonEmpty(principalId, "principalId");
  const issuedAtMs = Date.parse(now);
  if (!Number.isFinite(issuedAtMs)) throw new Error("now must be an ISO timestamp");
  const safeTtlMs = Math.max(1, Math.min(Number(ttlMs) || DEFAULT_RESOURCE_TICKET_TTL_MS, DEFAULT_RESOURCE_TICKET_TTL_MS));
  const payload = {
    schemaVersion: 1,
    ticketId: `rt_${crypto.randomUUID()}`,
    resourceId,
    studioId,
    action: RESOURCE_TICKET_ACTION,
    principalId,
    issuedAt: new Date(issuedAtMs).toISOString(),
    expiresAt: new Date(issuedAtMs + safeTtlMs).toISOString(),
  };
  const body = base64UrlEncode(JSON.stringify(payload));
  const signature = signBody(lucHome, body);
  return {
    ...payload,
    ticket: `${body}.${signature}`,
  };
}

export function verifyResourceTicket({
  lucHome,
  ticket,
  resourceId,
  now = new Date().toISOString(),
}: any = {}) {
  assertNonEmpty(lucHome, "lucHome");
  assertNonEmpty(resourceId, "resourceId");
  if (typeof ticket !== "string" || !ticket.trim()) {
    throw new ResourceTicketError("resource ticket required");
  }
  const [body, signature, extra] = ticket.split(".");
  if (!body || !signature || extra !== undefined) {
    throw new ResourceTicketError("resource ticket malformed");
  }
  const expected = signBody(lucHome, body);
  if (!timingSafeEqual(signature, expected)) {
    throw new ResourceTicketError("resource ticket signature invalid");
  }

  let payload;
  try {
    payload = JSON.parse(base64UrlDecode(body));
  } catch {
    throw new ResourceTicketError("resource ticket payload invalid");
  }
  if (payload?.schemaVersion !== 1 || payload.action !== RESOURCE_TICKET_ACTION) {
    throw new ResourceTicketError("resource ticket action invalid");
  }
  if (payload.resourceId !== resourceId) {
    throw new ResourceTicketError("resource ticket resource mismatch");
  }
  const expiresAtMs = Date.parse(payload.expiresAt);
  const nowMs = Date.parse(now);
  if (!Number.isFinite(expiresAtMs) || !Number.isFinite(nowMs)) {
    throw new ResourceTicketError("resource ticket timestamp invalid");
  }
  if (expiresAtMs <= nowMs) {
    throw new ResourceTicketError("resource ticket expired", { code: "resource_ticket_expired" });
  }
  return Object.freeze({
    schemaVersion: 1,
    ticketId: payload.ticketId,
    resourceId: payload.resourceId,
    studioId: payload.studioId,
    action: payload.action,
    principalId: payload.principalId,
    issuedAt: payload.issuedAt,
    expiresAt: payload.expiresAt,
  });
}

export function resourceTicketKeyPath(lucHome: any) {
  assertNonEmpty(lucHome, "lucHome");
  return path.join(securityDirPath(lucHome), RESOURCE_TICKET_KEY_FILE);
}

function signBody(lucHome: any, body: any) {
  return crypto
    .createHmac("sha256", readOrCreateTicketKey(lucHome))
    .update(body)
    .digest("base64url");
}

function readOrCreateTicketKey(lucHome: any) {
  const filePath = resourceTicketKeyPath(lucHome);
  try {
    const existing = fs.readFileSync(filePath, "utf-8").trim();
    if (existing) return existing;
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const key = crypto.randomBytes(32).toString("base64url");
  atomicWriteSync(filePath, `${key}\n`, { mode: 0o600 });
  return key;
}

function base64UrlEncode(value: any) {
  return Buffer.from(value, "utf-8").toString("base64url");
}

function base64UrlDecode(value: any) {
  return Buffer.from(value, "base64url").toString("utf-8");
}

function timingSafeEqual(a: any, b: any) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function assertNonEmpty(value: any, label: any) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} required`);
}
