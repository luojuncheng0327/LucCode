/**
 * agent-avatar-path.cjs — resolve an agent's custom avatar file from disk.
 *
 * Pure, dependency-free helper shared by the Electron main process (notification
 * icons, splash) so the avatar lookup can be unit-tested without Electron.
 *
 * Avatar storage convention (single source of truth across the app):
 *   {lucHome}/agents/{agentId}/avatars/agent.{png|jpg|jpeg|webp}
 * Mirrors server/routes/agents.ts (GET /agents/:id/avatar) and server/routes/avatar.ts.
 *
 * Identity is keyed strictly by the supplied agentId. A missing or unsafe agentId
 * returns null so callers fall back to no-icon — never to a globally-focused agent
 * (otherwise concurrent multi-agent notifications would show the wrong face).
 */
const fs = require("fs");
const path = require("path");

const AVATAR_EXTS = ["png", "jpg", "jpeg", "webp"];

// Same guard as server/utils/validation.ts validateId: agentId is a directory
// segment, so reject traversal and separators before joining it onto a path.
function isSafeAgentId(agentId) {
  return (
    typeof agentId === "string" &&
    agentId.length > 0 &&
    !agentId.includes("..") &&
    !agentId.includes("/") &&
    !agentId.includes("\\")
  );
}

/**
 * @param {string|null|undefined} lucHome - resolved LUC_HOME data root
 * @param {string|null|undefined} agentId - id of the agent that triggered the notification
 * @returns {string|null} absolute path to the avatar file, or null when none/unsafe
 */
function resolveAgentAvatarPath(lucHome, agentId) {
  if (typeof lucHome !== "string" || lucHome.length === 0) return null;
  if (!isSafeAgentId(agentId)) return null;

  const avatarDir = path.join(lucHome, "agents", agentId, "avatars");
  for (const ext of AVATAR_EXTS) {
    const candidate = path.join(avatarDir, `agent.${ext}`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

module.exports = { resolveAgentAvatarPath, AVATAR_EXTS };
