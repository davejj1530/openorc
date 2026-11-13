import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { HarnessId } from "@openorc/protocol";
import type { AgentInstallation, UpdateCommand } from "./agent-update-installation.js";
import { resolveBinary } from "./shell-environment.js";

export const OMP_FORMULA = "https://raw.githubusercontent.com/can1357/homebrew-tap/HEAD/Formula/omp.rb";
const receipt = z.object({ source: z.object({ tap: z.string(), spec: z.string() }) });
const formulas = {
  opencode: { name: "opencode", tap: "homebrew/core", releaseUrl: "https://formulae.brew.sh/api/formula/opencode.json" },
  omp: { name: "omp", tap: "can1357/tap", releaseUrl: OMP_FORMULA },
};
interface BrewPackage {
  name: string;
  releaseUrl: string;
}

function cask(id: HarnessId, name: string): BrewPackage | null {
  if (!((id === "codex" && name === "codex") || (id === "claude" && /^claude-code(?:@latest)?$/.test(name)))) return null;
  return { name, releaseUrl: `https://formulae.brew.sh/api/cask/${name}.json` };
}

async function formula(id: HarnessId, prefix: string, name: string, version: string): Promise<BrewPackage | null> {
  if (id !== "omp" && id !== "opencode") return null;
  const known = formulas[id];
  if (name !== known.name) return null;
  try {
    const installed = receipt.safeParse(JSON.parse(await readFile(path.join(prefix, "Cellar", name, version, "INSTALL_RECEIPT.json"), "utf8")));
    if (!installed.success || installed.data.source.tap !== known.tap || installed.data.source.spec !== "stable") return null;
    return { name: `${known.tap}/${name}`, releaseUrl: known.releaseUrl };
  } catch {
    return null;
  }
}

/** Use the installed formula's owner and channel, never replace it with the agent's native installer. */
export async function homebrewInstallation(id: HarnessId, manual: AgentInstallation): Promise<AgentInstallation | null> {
  const match = /^(.*)\/(Caskroom|Cellar)\/([^/]+)\/([^/]+)\//.exec(manual.identity);
  if (!match) return null;
  const prefix = match[1]!,
    kind = match[2]!,
    name = match[3]!,
    version = match[4]!;
  const unsupported = { ...manual, method: "Homebrew", message: "OpenOrc could not verify this Homebrew formula or release channel. Update it with Homebrew, then check again." };
  const pkg = kind === "Caskroom" ? cask(id, name) : await formula(id, prefix, name, version);
  if (!pkg) return unsupported;
  if (kind === "Cellar" && (await pinned(path.join(prefix, "var/homebrew/pinned", name))))
    return { ...unsupported, releaseUrl: pkg.releaseUrl, message: `Homebrew has pinned ${name}. Run brew unpin ${name} before updating it here.` };
  const brew = await resolveBinary("brew", path.join(prefix, "bin"));
  const command = (verb: string): UpdateCommand | null => (brew ? { binary: brew, args: [verb, kind === "Caskroom" ? "--cask" : "--formula", pkg.name] } : null);
  return {
    ...manual,
    method: "Homebrew",
    releaseUrl: pkg.releaseUrl,
    command: command("upgrade"),
    repair: command("reinstall"),
    message: brew ? null : "Homebrew could not be found. Update in a terminal, then check again.",
  };
}

async function pinned(file: string): Promise<boolean> {
  try {
    return Boolean(await lstat(file));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}
