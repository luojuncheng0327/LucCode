import { Hono } from "hono";
import { readAuthPrincipal } from "../http/capability-guard.ts";

export function createWebSocketAuthRoute({ ticketService }: { ticketService: any }) {
  if (!ticketService?.issueTicket) throw new Error("ticketService required");
  const route = new Hono();

  route.post("/ws-ticket", (c) => {
    const principal = readAuthPrincipal(c);
    if (!principal) return c.json({ error: "missing_principal" }, 403);
    const issued = ticketService.issueTicket(principal, {
      connectionKind: readTransportConnectionKind(c) || principal.connectionKind,
      path: "/ws",
    });
    return c.json({
      ticket: issued.ticket,
      expiresAt: issued.expiresAt,
    });
  });

  return route;
}

function readTransportConnectionKind(c) {
  if (typeof c?.get !== "function") return null;
  try {
    return c.get("transportConnectionKind") || null;
  } catch {
    return null;
  }
}
