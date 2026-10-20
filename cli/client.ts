import WebSocket from "ws";

export class LucCliClient {
  declare baseUrl: string;
  declare token: string;
  declare queryTokenAllowed: boolean;

  constructor({ baseUrl, token = "", queryTokenAllowed = false }) {
    this.baseUrl = String(baseUrl || "").replace(/\/+$/, "");
    this.token = token;
    this.queryTokenAllowed = queryTokenAllowed;
  }

  async request(path, opts: Record<string, any> = {}) {
    const headers: Record<string, string> = { ...(opts.headers || {}) };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    let body = opts.body;
    if (body && typeof body === "object" && !(body instanceof Uint8Array)) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(body);
    }
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...opts,
      headers,
      body,
    });
    const text = await res.text();
    const data = text ? safeJson(text) : null;
    if (!res.ok) {
      const detail = data?.detail || data?.reason || data?.error || text || res.statusText;
      const err: any = new Error(`HTTP ${res.status}: ${detail}`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  health() {
    return this.request("/api/health");
  }

  identity() {
    return this.request("/api/server/identity");
  }

  agents() {
    return this.request("/api/agents");
  }

  sessions() {
    return this.request("/api/sessions");
  }

  newSession() {
    return this.request("/api/sessions/new", { method: "POST", body: {} });
  }

  switchSession(sessionPath) {
    return this.request("/api/sessions/switch", {
      method: "POST",
      body: { path: sessionPath },
    });
  }

  createWebSocket() {
    const url = new URL(this.baseUrl.replace(/^http/i, "ws"));
    url.pathname = "/ws";
    url.search = "";
    const headers: Record<string, string> = {};
    if (this.token && this.queryTokenAllowed) {
      url.searchParams.set("token", this.token);
    } else if (this.token) {
      headers.Authorization = `Bearer ${this.token}`;
    }
    return new WebSocket(url.toString(), { headers });
  }
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
