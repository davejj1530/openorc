import type { HarnessCatalogEntry } from "@openorc/protocol";
import { PREBUILT_INSTALL } from "./prebuilt-install.js";
import type { Sandbox } from "./sandbox.js";

export interface AgentInstall {
  name: string;
  /** False on a sandbox simulated on a Mac, whose CLI is that Mac's own and so its version too. */
  mayInstall: boolean;
  /** The version the host that drives the sandbox runs; null takes whatever is there, or the latest. */
  version: string | null;
  /** The release in the CLI's `--version` output. */
  read: (output: string) => string | null;
}

/**
 * Puts an agent's CLI on the sandbox's PATH at the version of the host that drives it, so a conversation that moves
 * between them always resumes; one `--version` when it is current.
 */
export async function ensureAgent(sandbox: Sandbox, cli: HarnessCatalogEntry["cli"], install: AgentInstall): Promise<void> {
  // Plain sh, not a login shell: the runner starts the CLI with the sandbox's default environment.
  const has = async () => {
    const found = await sandbox.exec("sh", ["-c", 'command -v "$1" >/dev/null && "$1" --version', "sh", cli.bin]);
    return found.code === 0 ? (install.read(found.stdout.toString("utf8")) ?? "unknown") : null;
  };
  if (!install.mayInstall) {
    if ((await sandbox.exec("sh", ["-c", 'command -v "$1"', "sh", cli.bin])).code === 0) return;
    throw new Error(`${install.name} is not installed on this Mac, where this sandbox is simulated.`);
  }
  const current = await has();
  if (current && (install.version === null || current === install.version)) return;
  if (cli.prebuilt) {
    // Beside npm's own CLIs, on the PATH they share.
    const placed = await sandbox.exec("sh", ["-c", 'node -e "$1" "$2" "$3" "$(npm prefix -g)/bin/$4"', "sh", PREBUILT_INSTALL, cli.prebuilt, install.version ?? "", cli.bin], { sudo: true });
    if (placed.code !== 0) throw new Error(`${install.name} could not be installed in the cloud workspace: ${placed.stderr.trim().slice(-500)}`);
    return;
  }
  if (!cli.npm) throw new Error(`${install.name} cannot be installed in a cloud workspace yet. Run it on the connected computer.`);
  const wanted = install.version ? `${cli.npm}@${install.version}` : cli.npm;
  let installed = await sandbox.exec("npm", ["install", "-g", wanted], { sudo: true });
  // The image's own copy of the CLI, from another package, holds the command's name: this host's version takes it over.
  if (installed.code !== 0 && /\bEEXIST\b/.test(installed.stderr)) installed = await sandbox.exec("npm", ["install", "-g", "--force", wanted], { sudo: true });
  if (installed.code !== 0) throw new Error(`${install.name} could not be installed in the cloud workspace: ${installed.stderr.trim().slice(-500)}`);
}
