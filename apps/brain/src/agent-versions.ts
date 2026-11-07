import { execFile } from "node:child_process";
import path from "node:path";
import type { AgentVersions } from "@openorc/cloud";
import { harnessCatalog, harnessIds } from "@openorc/protocol";

const releaseOf = (output: string): string | null => /(\d+\.\d+\.\d+)/.exec(output)?.[1] ?? null;

export type Run = (file: string, args: string[], env?: NodeJS.ProcessEnv) => Promise<{ code: number; stdout: string }>;

const run: Run = (file, args, env) =>
  new Promise((resolve) => {
    execFile(file, args, { env: env ?? process.env, timeout: 300_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      const code = typeof error?.code === "number" ? error.code : 1;
      resolve({ code: error ? code : 0, stdout: String(stdout) });
    });
  });

/**
 * The brain's agent CLIs, in its own npm folder, brought to the Mac's versions: a conversation moved either way then
 * resumes. As its setup installs them, never as root. An install that fails leaves the version there, which is answered.
 */
export async function alignAgents(npmPrefix: string, wanted: AgentVersions, exec: Run = run): Promise<{ versions: AgentVersions }> {
  const has = async (bin: string) => {
    const answer = await exec(path.posix.join(npmPrefix, "bin", bin), ["--version"]);
    return answer.code === 0 ? releaseOf(answer.stdout) : null;
  };
  for (const id of harnessIds) {
    const { npm, bin } = harnessCatalog[id].cli;
    const version = wanted[id];
    if (version && (await has(bin)) !== version) await exec("npm", ["install", "--global", "--no-audit", "--no-fund", `${npm}@${version}`], { ...process.env, NPM_CONFIG_PREFIX: npmPrefix });
  }
  const versions = Object.fromEntries(await Promise.all(harnessIds.map(async (id) => [id, await has(harnessCatalog[id].cli.bin)] as const)));
  return { versions: versions as AgentVersions };
}
