function buildSetupCompleteUrl(serverPort) {
  if (!serverPort) throw new Error("Server is not ready");
  return `http://127.0.0.1:${serverPort}/api/preferences/setup-complete`;
}

async function parseSetupCompleteError(res) {
  try {
    const body = await res.json();
    if (body?.error) return String(body.error);
  } catch {}
  return `setup completion failed with HTTP ${res.status}`;
}

async function submitOnboardingCompleteIntent({
  serverPort,
  serverToken,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!serverToken) throw new Error("Server is not ready");
  if (typeof fetchImpl !== "function") throw new Error("fetch is not available");

  const res = await fetchImpl(buildSetupCompleteUrl(serverPort), {
    method: "POST",
    headers: { Authorization: `Bearer ${serverToken}` },
  });
  if (!res.ok) {
    throw new Error(await parseSetupCompleteError(res));
  }

  const body = await res.json();
  if (body?.ok !== true || body?.setupComplete !== true) {
    throw new Error("setup completion was not persisted");
  }
  return body;
}

async function completeOnboardingAndOpenMain({
  serverPort,
  serverToken,
  createMainWindow,
  fetchImpl = globalThis.fetch,
} = {}) {
  await submitOnboardingCompleteIntent({ serverPort, serverToken, fetchImpl });
  if (typeof createMainWindow !== "function") {
    throw new Error("createMainWindow is not available");
  }
  createMainWindow();
}

module.exports = {
  completeOnboardingAndOpenMain,
  submitOnboardingCompleteIntent,
};
