import { statSync } from "node:fs";
import { isAbsolute } from "node:path";

/**
 * The one place automation cannot reach: the native folder chooser. A QA run
 * names the repository up front in OPENORC_QA_DIRECTORY and the chooser is
 * answered from it. Only QA builds read the variable, and only when it names an
 * existing directory by absolute path; anything else falls through to the real
 * dialog, so neither a release build nor a mistyped value changes what the app does.
 */
export const QA_DIRECTORY_VARIABLE = "OPENORC_QA_DIRECTORY";

export function qaDirectory(env: NodeJS.ProcessEnv = process.env, isDirectory: (path: string) => boolean = existingDirectory, qa: boolean = __OPENORC_QA__): string | null {
  if (!qa) return null;
  const value = env[QA_DIRECTORY_VARIABLE];
  if (!value || !isAbsolute(value)) return null;
  return isDirectory(value) ? value : null;
}

function existingDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
