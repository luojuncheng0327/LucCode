/**
 * The one place that names the directory holding signing keys and grant records.
 *
 * The name used to be spelled independently by everything that touched it: two
 * registries each declared their own copy of the constant, four key services
 * wrote the string inline, and the startup check that reports which registries
 * it created wrote it twice more. Nothing forced those spellings to agree, and
 * a list of directories that drifted from the name its writer actually used has
 * already cost real coverage in this area once: a pass ended up walking a path
 * that never existed and silently did nothing. Import the name from here rather
 * than spelling it again.
 */
import path from "path";

/** Directory under the data directory that holds security key material. */
export const SECURITY_DIR = "security";

/** Absolute path to the security directory inside a data directory. */
export function securityDirPath(lucHome: string): string {
  return path.join(lucHome, SECURITY_DIR);
}
