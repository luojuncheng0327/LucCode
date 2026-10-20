import fs from "fs/promises";
import path from "path";

export const USER_PROFILE_FILENAME = "user.md";

export function userProfilePath(userDir: string) {
  return path.join(userDir, USER_PROFILE_FILENAME);
}

export async function readUserProfile(userDir: string) {
  try {
    return await fs.readFile(userProfilePath(userDir), "utf-8");
  } catch (err: any) {
    if (err?.code === "ENOENT") return "";
    throw err;
  }
}

export async function writeUserProfile(userDir: string, content: string) {
  await fs.mkdir(userDir, { recursive: true });
  await fs.writeFile(userProfilePath(userDir), content, "utf-8");
}
