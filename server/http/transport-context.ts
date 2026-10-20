export function inferHttpConnectionKind({
  hostHeader,
  remoteAddress,
  networkMode = "loopback",
}: { hostHeader?: string; remoteAddress?: string; networkMode?: string } = {}) {
  const mode = typeof networkMode === "string" && networkMode.trim()
    ? networkMode.trim()
    : "loopback";
  const host = normalizeHostHeader(hostHeader);
  const hasRemoteAddress = typeof remoteAddress === "string" && remoteAddress.trim().length > 0;
  const remoteIsLoopback = hasRemoteAddress ? isLoopbackAddress(remoteAddress) : null;
  const hostIsLoopback = !host || isLoopbackHost(host);

  if (mode === "loopback") {
    if (!hostIsLoopback) return { connectionKind: null, reason: "loopback_host_mismatch" };
    if (remoteIsLoopback === false) return { connectionKind: null, reason: "loopback_remote_mismatch" };
    return { connectionKind: "local", reason: null };
  }

  if (hostIsLoopback && remoteIsLoopback === true) {
    return { connectionKind: "local", reason: null };
  }
  if (mode === "lan") return { connectionKind: "lan", reason: null };
  if (mode === "custom_remote") return { connectionKind: "custom_remote", reason: null };
  return { connectionKind: null, reason: "invalid_network_mode" };
}

export function isLoopbackHost(hostHeader) {
  const host = normalizeHostHeader(hostHeader);
  if (!host) return false;
  if (host === "localhost" || host === "::1" || host === "[::1]") return true;
  if (/^127(?:\.\d{1,3}){3}$/.test(host)) return true;
  return false;
}

function normalizeHostHeader(hostHeader) {
  const raw = String(hostHeader || "").trim().toLowerCase();
  if (!raw) return "";
  if (raw.startsWith("[")) {
    const end = raw.indexOf("]");
    if (end >= 0) return raw.slice(0, end + 1);
  }
  const colon = raw.lastIndexOf(":");
  if (colon > -1 && raw.indexOf(":") === colon) {
    return raw.slice(0, colon);
  }
  return raw;
}

function isLoopbackAddress(remoteAddress) {
  const value = String(remoteAddress || "").trim().toLowerCase();
  if (!value) return false;
  if (value === "localhost" || value === "::1" || value === "[::1]") return true;
  if (value.startsWith("::ffff:")) {
    return isLoopbackAddress(value.slice("::ffff:".length));
  }
  if (/^127(?:\.\d{1,3}){3}$/.test(value)) return true;
  return false;
}
