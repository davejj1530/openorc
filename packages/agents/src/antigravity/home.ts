import { stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const antigravityConfig = (env: NodeJS.ProcessEnv): string => path.join(env["HOME"] || os.homedir(), ".gemini", "config");

/** Workspace customizations are inherited only inside a repository; outside one, only the working folder applies. */
export async function antigravityProjectDirectories(folder: string): Promise<string[]> {
  const directories = [path.resolve(folder)];
  for (;;) {
    const current = directories[directories.length - 1]!;
    if (
      await stat(path.join(current, ".git")).then(
        () => true,
        () => false,
      )
    )
      return directories.reverse();
    const parent = path.dirname(current);
    if (parent === current) return [path.resolve(folder)];
    directories.push(parent);
  }
}
