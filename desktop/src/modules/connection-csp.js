(function installConnectionCsp() {
  var STORAGE_KEY = "luc-server-connections-v1";
  var BASE_CSP = {
    "default-src": ["'self'"],
    "connect-src": ["'self'", "ws://127.0.0.1:*", "http://127.0.0.1:*"],
    "img-src": ["'self'", "data:", "file:", "http://127.0.0.1:*"],
    "style-src": ["'self'", "'unsafe-inline'"],
    "script-src": ["'self'"],
    "font-src": ["'self'", "data:"],
    "frame-src": ["blob:", "data:", "file:", "http://127.0.0.1:*", "http://localhost:*"],
  };

  function addOrigin(out, value) {
    if (!value || typeof value !== "string") return;
    try {
      var url = new URL(value);
      if (!/^(http|https|ws|wss):$/.test(url.protocol)) return;
      out[url.protocol + "//" + url.host] = true;
    } catch {}
  }

  function readPersistedConnectionSources() {
    var out = {};
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return out;
      var parsed = JSON.parse(raw);
      var connections = parsed && parsed.serverConnections;
      if (!connections || typeof connections !== "object") return out;
      Object.keys(connections).forEach(function (key) {
        var connection = connections[key];
        if (!connection || connection.kind === "local") return;
        addOrigin(out, connection.baseUrl);
        addOrigin(out, connection.wsUrl);
        if (connection.baseUrl && !connection.wsUrl) {
          var base = new URL(connection.baseUrl);
          addOrigin(out, (base.protocol === "https:" ? "wss:" : "ws:") + "//" + base.host);
        }
      });
    } catch {}
    return out;
  }

  function addDevSources(out) {
    try {
      var host = window.location && window.location.host;
      var hostname = window.location && window.location.hostname;
      if (!host || !/^(localhost|127\.0\.0\.1|\[::1\]|::1)$/.test(hostname)) return;
      out["http://" + host] = true;
      out["ws://" + host] = true;
      BASE_CSP["script-src"].push("'unsafe-inline'");
    } catch {}
  }

  var scopedSources = readPersistedConnectionSources();
  addDevSources(scopedSources);
  var connectSources = BASE_CSP["connect-src"].concat(Object.keys(scopedSources));
  var directives = Object.assign({}, BASE_CSP, { "connect-src": connectSources });
  var content = Object.keys(directives)
    .map(function (key) { return key + " " + directives[key].join(" "); })
    .join("; ");

  document.write('<meta http-equiv="Content-Security-Policy" content="' + content.replace(/"/g, "&quot;") + '">');
})();
