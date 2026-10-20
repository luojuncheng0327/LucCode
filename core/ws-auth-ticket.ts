import crypto from "crypto";
import { normalizePrincipal } from "./security-principal.ts";

const DEFAULT_TTL_MS = 30_000;
const DEFAULT_MAX_TICKETS = 512;

export function createWebSocketTicketService({
  now = () => new Date().toISOString(),
  ttlMs = DEFAULT_TTL_MS,
  maxTickets = DEFAULT_MAX_TICKETS,
}: {
  now?: () => string;
  ttlMs?: number;
  maxTickets?: number;
} = {}) {
  const tickets = new Map<string, Readonly<{
    principal: any;
    connectionKind: string;
    path: string;
    expiresAtMs: number;
  }>>();
  const resolvedTtlMs = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : DEFAULT_TTL_MS;
  const resolvedMaxTickets = Number.isInteger(maxTickets) && maxTickets > 0
    ? maxTickets
    : DEFAULT_MAX_TICKETS;

  function issueTicket(principal: any, {
    connectionKind,
    path = "/ws",
  }: {
    connectionKind?: string | null;
    path?: string;
  } = {}) {
    const normalizedPrincipal = normalizePrincipal(principal);
    const routePath = normalizeWsPath(path);
    const transportKind = normalizeConnectionKind(connectionKind || normalizedPrincipal.connectionKind);
    if (!transportKind) throw new Error("connectionKind required");
    const issuedAtMs = Date.parse(now());
    if (!Number.isFinite(issuedAtMs)) throw new Error("invalid ws ticket clock");
    const expiresAtMs = issuedAtMs + resolvedTtlMs;

    pruneExpired(issuedAtMs);
    pruneOverflow(resolvedMaxTickets - 1);

    const ticket = `luc_ws_${crypto.randomBytes(32).toString("base64url")}`;
    tickets.set(ticket, Object.freeze({
      principal: normalizedPrincipal,
      connectionKind: transportKind,
      path: routePath,
      expiresAtMs,
    }));
    return Object.freeze({
      ticket,
      expiresAt: new Date(expiresAtMs).toISOString(),
    });
  }

  function consumeTicket(ticket: string | null | undefined, {
    connectionKind,
    path = "/ws",
  }: {
    connectionKind?: string | null;
    path?: string;
  } = {}) {
    if (!isNonEmptyString(ticket)) return null;
    const record = tickets.get(ticket);
    tickets.delete(ticket);
    if (!record) return null;
    const currentMs = Date.parse(now());
    if (!Number.isFinite(currentMs) || record.expiresAtMs <= currentMs) return null;
    if (record.path !== normalizeWsPath(path)) return null;
    if (record.connectionKind !== normalizeConnectionKind(connectionKind)) return null;
    return normalizePrincipal({
      ...record.principal,
      connectionKind: record.connectionKind,
    });
  }

  function pruneExpired(currentMs = Date.parse(now())) {
    if (!Number.isFinite(currentMs)) return;
    for (const [ticket, record] of tickets) {
      if (record.expiresAtMs <= currentMs) tickets.delete(ticket);
    }
  }

  function pruneOverflow(limit: number) {
    while (tickets.size > Math.max(0, limit)) {
      const oldest = tickets.keys().next().value;
      if (!oldest) return;
      tickets.delete(oldest);
    }
  }

  return Object.freeze({
    issueTicket,
    consumeTicket,
  });
}

function normalizeWsPath(path: string) {
  return path === "/ws" ? "/ws" : String(path || "");
}

function normalizeConnectionKind(value: any) {
  if (value === "local" || value === "lan" || value === "custom_remote" || value === "relay" || value === "cloud") {
    return value;
  }
  return null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
