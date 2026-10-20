import fs from "fs";
import path from "path";
import { isValidAgentId } from "../../shared/agent-id.ts";

export function validateId(id) {
  return isValidAgentId(id);
}

export function agentExists(engine, id) {
  return fs.existsSync(path.join(engine.agentsDir, id, "config.yaml"));
}
