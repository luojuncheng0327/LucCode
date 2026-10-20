import { homedir } from "node:os";
import { join } from "node:path";

export function defaultDevLucHome() {
  return join(homedir(), ".luccode-dev");
}

export function applyDevEnvironment(env = process.env, {
  nodeBin = process.execPath,
} = {}) {
  env.LUC_HOME = defaultDevLucHome();
  env.LUC_DEV_NODE_BIN = nodeBin;
  return env;
}
