function normalizeDesktopNotificationOptions(rawOptions) {
  const source = rawOptions && typeof rawOptions === "object" && !Array.isArray(rawOptions) ? rawOptions : {};
  return {
    desktopFocusPolicy: source.desktopFocusPolicy === "when_unfocused" ? "when_unfocused" : "always",
  };
}

function shouldSuppressDesktopNotification(rawOptions, deps = {}) {
  const options = normalizeDesktopNotificationOptions(rawOptions);
  if (options.desktopFocusPolicy !== "when_unfocused") return false;
  const focusedWindow = deps.getFocusedWindow?.() || null;
  return !!focusedWindow && focusedWindow.isDestroyed?.() !== true;
}

module.exports = {
  normalizeDesktopNotificationOptions,
  shouldSuppressDesktopNotification,
};
