import { expect, it } from "vitest";
import { ensureAgent } from "./agent-install.js";
import type { Sandbox, SandboxCommandOptions } from "./sandbox.js";

/** A sandbox whose PATH holds `installed`; npm installs a package's binary when it runs as root. */
function sandbox(installed: string[]) {
  const runs: { cmd: string; args: string[]; sudo: boolean }[] = [];
  const box = {
    exec: async (cmd: string, args: string[], options: SandboxCommandOptions = {}) => {
      runs.push({ cmd, args, sudo: Boolean(options.sudo) });
      if (cmd === "sh") return { code: installed.includes(args.at(-1)!) ? 0 : 1, stdout: Buffer.alloc(0), stderr: "" };
      if (cmd === "npm" && options.sudo) installed.push(args.at(-1)!.replace("@opencode/cli", "opencode"));
      return { code: cmd === "npm" && options.sudo ? 0 : 1, stdout: Buffer.alloc(0), stderr: "npm ERR! EACCES" };
    },
  } as unknown as Sandbox;
  return { box, runs };
}

const opencode = { npm: "@opencode/cli", bin: "opencode" };

it("installs an agent's own package as root only when its binary is missing", async () => {
  const missing = sandbox([]);
  await ensureAgent(missing.box, opencode, { name: "OpenCode", mayInstall: true });
  expect(missing.runs.filter((run) => run.cmd === "npm")).toEqual([{ cmd: "npm", args: ["install", "-g", "@opencode/cli"], sudo: true }]);
  const present = sandbox(["opencode"]);
  await ensureAgent(present.box, opencode, { name: "OpenCode", mayInstall: true });
  expect(present.runs.map((run) => run.cmd)).toEqual(["sh"]);
});

it("never installs on a sandbox simulated on a Mac, whose CLI is the Mac's", async () => {
  await expect(ensureAgent(sandbox([]).box, opencode, { name: "OpenCode", mayInstall: false })).rejects.toThrow("OpenCode is not installed on this Mac, where this sandbox is simulated.");
});
