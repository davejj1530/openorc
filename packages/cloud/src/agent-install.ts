import type { HarnessCatalogEntry } from "@openorc/protocol";
import type { Sandbox } from "./sandbox.js";

/**
 * Puts an agent's CLI on the sandbox's PATH unless it is there. A sandbox simulated on a Mac never installs: its CLI is
 * that Mac's own.
 */
export async function ensureAgent(sandbox: Sandbox, cli: HarnessCatalogEntry["cli"], options: { name: string; mayInstall: boolean }): Promise<void> {
  // Plain sh, not a login shell: the runner starts the CLI with the sandbox's default environment.
  if ((await sandbox.exec("sh", ["-c", 'command -v "$1"', "sh", cli.bin])).code === 0) return;
  if (!options.mayInstall) throw new Error(`${options.name} is not installed on this Mac, where this sandbox is simulated.`);
  const install = await sandbox.exec("npm", ["install", "-g", cli.npm], { sudo: true });
  if (install.code !== 0) throw new Error(`${options.name} could not be installed in the cloud workspace: ${install.stderr.trim().slice(-500)}`);
}
