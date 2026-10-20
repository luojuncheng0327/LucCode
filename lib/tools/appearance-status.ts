import crypto from "crypto";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import {
  readAgentAppearanceProfileResource,
  readAgentAvatarResource,
} from "../agent-appearance-summary.ts";
import { modelSupportsDirectImageInput } from "../../shared/model-capabilities.ts";

const AVATAR_EXTENSIONS = ["png", "jpg", "jpeg", "webp"];
const MIME_BY_EXT = Object.freeze({
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
});

const APPEARANCE_SUMMARY_REQUEST = [
  "Summarize this custom avatar appearance for current_status.",
  "Focus on stable visible traits: subject, style, colors, clothing, facial expression, pose, and notable visual motifs.",
  "Do not infer private identity, age, ethnicity, gender, or other sensitive attributes beyond what is visually necessary.",
  "Keep the summary concise and useful for a text-only model.",
].join(" ");

function sha256(parts) {
  const h = crypto.createHash("sha256");
  for (const part of parts) {
    h.update(String(part ?? ""));
    h.update("\0");
  }
  return h.digest("hex");
}

function contentHash(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function isMissingFileError(err) {
  return err?.code === "ENOENT" || err?.code === "ENOTDIR";
}

function readFailureReason(err) {
  return err?.code ? `avatar_read_failed:${err.code}` : "avatar_read_failed";
}

async function readCustomAvatar(baseDir, role) {
  if (!baseDir) return { resource: null, error: null };
  const avatarDir = path.join(baseDir, "avatars");
  for (const ext of AVATAR_EXTENSIONS) {
    const filePath = path.join(avatarDir, `${role}.${ext}`);
    try {
      const stat = await fsp.stat(filePath);
      const bytes = await fsp.readFile(filePath);
      const hash = contentHash(bytes);
      const mimeType = MIME_BY_EXT[ext] || "image/png";
      return {
        resource: {
          role,
          key: `visual-resource:appearance:${role}:${sha256([role, hash])}`,
          label: `${role} custom avatar`,
          image: { type: "image", mimeType, data: bytes.toString("base64") },
          mimeType,
          size: stat.size,
        },
        error: null,
      };
    } catch (err) {
      if (isMissingFileError(err)) continue;
      return { resource: null, error: readFailureReason(err) };
    }
  }
  return { resource: null, error: null };
}

function compactAvatar(resource) {
  if (!resource) {
    return {
      available: false,
      source: null,
      mime: null,
      size: null,
    };
  }
  return {
    available: true,
    source: "custom_avatar",
    mime: resource.mimeType,
    size: resource.size,
  };
}

function subjectBase(meta, resource) {
  return {
    role: meta.role,
    id: meta.id || null,
    name: meta.name || null,
    avatar: compactAvatar(resource),
    summaryAvailable: false,
    summary: null,
    vision: {
      status: "missing_avatar",
      reason: "no custom avatar",
      reused: false,
    },
    directImage: {
      included: false,
      contentIndex: null,
    },
  };
}

function missingSubject(meta) {
  return subjectBase(meta, null);
}

function readFailedSubject(meta, reason) {
  return {
    ...subjectBase(meta, null),
    vision: {
      status: "read_failed",
      reason,
      reused: false,
    },
  };
}

function summarizedSubject(meta, resource, note) {
  return {
    ...subjectBase(meta, resource),
    summaryAvailable: true,
    summary: note.note,
    vision: {
      status: "summarized",
      reason: null,
      reused: note.reused === true,
    },
  };
}

function profileResourceSubject(meta, resource, profile) {
  return {
    ...subjectBase(meta, resource),
    summaryAvailable: true,
    summary: profile.summary,
    vision: {
      status: "profile_resource",
      reason: null,
      reused: true,
      updatedAt: profile.updatedAt || null,
      model: profile.model || null,
    },
  };
}

function missingProfileResourceSubject(meta, resource) {
  return {
    ...subjectBase(meta, resource),
    vision: {
      status: "profile_resource_missing",
      reason: "agent appearance profile resource is not generated",
      reused: false,
    },
  };
}

function directSubject(meta, resource, contentIndex, visionStatus) {
  return {
    ...subjectBase(meta, resource),
    vision: visionStatus,
    directImage: {
      included: true,
      contentIndex,
    },
  };
}

function unavailableSubject(meta, resource, visionStatus) {
  return {
    ...subjectBase(meta, resource),
    vision: visionStatus,
  };
}

function classifyVisionError(err) {
  const message = String(err?.message || err || "");
  if (message.includes("vision auxiliary model is required")) {
    return {
      status: "not_configured",
      reason: "vision auxiliary model is not configured",
      reused: false,
    };
  }
  if (message.includes("vision auxiliary model must support image input")) {
    return {
      status: "invalid_config",
      reason: "vision auxiliary model cannot read images",
      reused: false,
    };
  }
  return {
    status: "summary_failed",
    reason: "auxiliary vision summary failed",
    reused: false,
  };
}

function unavailableVisionStatus(summaryStatus) {
  if (summaryStatus) return summaryStatus;
  return {
    status: "not_configured",
    reason: "vision auxiliary model is not configured",
    reused: false,
  };
}

function modeForSubjects(subjects) {
  const hasSummary = subjects.some((item) => item.summaryAvailable);
  const hasDirect = subjects.some((item) => item.directImage.included);
  if (hasSummary && hasDirect) return "mixed";
  if (hasSummary) return "vision_summary";
  if (hasDirect) return "direct_image";
  return "unavailable";
}

function agentName(agent) {
  return agent?.agentName || agent?.config?.agent?.name || agent?.id || null;
}

function userName(agent) {
  return agent?.userName || agent?.config?.user?.name || null;
}

async function loadSubjects(agent, userDir) {
  const userBaseDir = userDir || agent?.userDir || null;
  const agentBaseDir = agent?.agentDir || null;
  const userAvatar = await readCustomAvatar(userBaseDir, "user");
  const agentAvatar = readAgentProfileAvatar(agentBaseDir);
  return [
    {
      meta: { role: "user", id: "user", name: userName(agent) },
      ...userAvatar,
      profile: null,
    },
    {
      meta: { role: "agent", id: agent?.id || null, name: agentName(agent) },
      ...agentAvatar,
    },
  ];
}

function readAgentProfileAvatar(agentDir) {
  if (!agentDir) return { resource: null, error: null, profile: null };
  try {
    const avatar = readAgentAvatarResource(agentDir);
    if (!avatar) return { resource: null, error: null, profile: null };
    const stat = fs.statSync(avatar.path);
    return {
      resource: {
        role: "agent",
        key: avatar.key,
        label: "agent custom avatar",
        image: avatar.image,
        mimeType: avatar.image.mimeType,
        size: stat.size,
      },
      error: null,
      profile: readAgentAppearanceProfileResource(agentDir),
    };
  } catch (err) {
    if (isMissingFileError(err)) return { resource: null, error: null, profile: null };
    return { resource: null, error: readFailureReason(err), profile: null };
  }
}

export async function getAppearanceStatus({
  agent,
  userDir,
  visionBridge,
  currentModel,
  sessionPath,
  signal,
}: {
  agent?: any;
  userDir?: any;
  visionBridge?: any;
  currentModel?: any;
  sessionPath?: any;
  signal?: any;
} = {}) {
  const loaded = await loadSubjects(agent, userDir);
  const resources = loaded
    .filter((item) => item.meta.role !== "agent")
    .map((item) => item.resource)
    .filter(Boolean);
  const directCapable = modelSupportsDirectImageInput(currentModel);
  let summaryStatus = null;
  let notesByKey = new Map();

  if (resources.length && typeof visionBridge?.summarizeResources === "function") {
    try {
      const prepared = await visionBridge.summarizeResources({
        sessionPath,
        userRequest: APPEARANCE_SUMMARY_REQUEST,
        resources,
        signal,
      });
      notesByKey = new Map((prepared?.notes || [])
        .filter((note) => note?.key && note.note)
        .map((note) => [note.key, note]));
      if (notesByKey.size === 0) {
        summaryStatus = {
          status: "summary_unavailable",
          reason: "auxiliary vision returned no summary",
          reused: false,
        };
      }
    } catch (err) {
      summaryStatus = classifyVisionError(err);
    }
  }

  const contentBlocks = [];
  const directImages = [];
  const subjects = loaded.map((item) => {
    const { meta, resource, error } = item;
    const profile = item.profile || null;
    if (error) return readFailedSubject(meta, error);
    if (!resource) return missingSubject(meta);
    if (meta.role === "agent") {
      if (profile) return profileResourceSubject(meta, resource, profile);
      return missingProfileResourceSubject(meta, resource);
    }

    const note = notesByKey.get(resource.key);
    if (note) return summarizedSubject(meta, resource, note);

    const status = unavailableVisionStatus(summaryStatus);
    if (directCapable) {
      const contentIndex = 1 + contentBlocks.length;
      contentBlocks.push(resource.image);
      directImages.push({
        subject: meta.role,
        label: resource.label,
        contentIndex,
        mime: resource.mimeType,
      });
      return directSubject(meta, resource, contentIndex, status);
    }
    return unavailableSubject(meta, resource, status);
  });

  const [user, agentSubject] = subjects;
  const mode = modeForSubjects(subjects);
  return {
    payload: {
      appearance: {
        mode,
        user,
        agent: agentSubject,
        directImages,
      },
    },
    contentBlocks,
    details: {
      appearanceMode: mode,
      directImageBlocks: contentBlocks.length,
    },
  };
}
