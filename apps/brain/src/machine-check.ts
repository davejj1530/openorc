import path from "node:path";
import { resolveBinary } from "@openorc/core";
import type { BrainLayout } from "@openorc/cloud";

const SYSTEM_PATH = ["/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin"];
/** ps reads agent processes back after a restart, git carries projects, and flock is how only one brain runs. */
const TOOLS = ["ps", "git", "flock"];
const NODE_MAJOR = 24;

/**
 * The brain's PATH, decided here rather than by a login shell: nobody's dotfiles live on the brain, and Ubuntu sets
 * PATH through PAM, which a login shell started under a bare PATH never runs. The agent CLIs setup installed come first.
 */
export function brainPath(layout: BrainLayout, node = process.execPath): string {
  return [path.posix.join(layout.npm, "bin"), path.dirname(node), ...SYSTEM_PATH].join(":");
}

/** What the brain cannot run without and machine setup provides, by name; empty when all of it is there. */
export async function missingTools(envPath: string, nodeVersion = process.versions.node): Promise<string[]> {
  const found = await Promise.all(TOOLS.map(async (tool) => ((await resolveBinary(tool, envPath)) ? null : tool)));
  const missing = found.filter((tool): tool is string => tool !== null);
  if (Number(nodeVersion.split(".")[0]) < NODE_MAJOR) missing.push(`Node ${NODE_MAJOR} or newer`);
  return missing;
}
