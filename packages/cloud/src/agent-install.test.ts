import { expect, it } from "vitest";
import { ensureAgent } from "./agent-install.js";
import type { Sandbox, SandboxCommandOptions } from "./sandbox.js";

/** A sandbox whose PATH holds the CLIs in `installed` at their versions; npm as root installs `pkg@version`. */
function sandbox(installed: Map<string, string>) {
  const runs: { cmd: string; args: string[]; sudo: boolean }[] = [];
  const box = {
    exec: async (cmd: string, args: string[], options: SandboxCommandOptions = {}) => {
      runs.push({ cmd, args, sudo: Boolean(options.sudo) });
      if (cmd === "sh") {
        const version = installed.get(args.at(-1)!);
        return { code: version ? 0 : 1, stdout: Buffer.from(version && args[1]!.includes("--version") ? `opencode v${version}\n` : ""), stderr: "" };
      }
      if (cmd === "npm" && options.sudo) {
        const [, version = "9.9.9"] = args.at(-1)!.replace("@opencode/cli", "").split("@");
        installed.set("opencode", version);
        return { code: 0, stdout: Buffer.alloc(0), stderr: "" };
      }
      return { code: 1, stdout: Buffer.alloc(0), stderr: "npm ERR! EACCES" };
    },
  } as unknown as Sandbox;
  return { box, runs, npm: () => runs.filter((run) => run.cmd === "npm").map((run) => run.args.at(-1)) };
}

const opencode = { npm: "@opencode/cli", bin: "opencode" };
const read = (output: string) => /(\d+\.\d+\.\d+)/.exec(output)?.[1] ?? null;
const pinned = (version: string | null) => ({ name: "OpenCode", mayInstall: true, version, read });

it("installs the host's version as root when the sandbox has another or none, and asks only its version when it matches", async () => {
  const older = sandbox(new Map([["opencode", "2.0.10"]]));
  await ensureAgent(older.box, opencode, pinned("2.0.11"));
  expect(older.npm()).toEqual(["@opencode/cli@2.0.11"]);
  expect(older.runs.find((run) => run.cmd === "npm")?.sudo).toBe(true);
  const missing = sandbox(new Map());
  await ensureAgent(missing.box, opencode, pinned("2.0.11"));
  expect(missing.npm()).toEqual(["@opencode/cli@2.0.11"]);
  const current = sandbox(new Map([["opencode", "2.0.11"]]));
  await ensureAgent(current.box, opencode, pinned("2.0.11"));
  expect(current.runs.map((run) => run.cmd)).toEqual(["sh"]);
});

it("takes whatever is there, or the latest, when the host's version is unknown", async () => {
  const any = sandbox(new Map([["opencode", "1.0.0"]]));
  await ensureAgent(any.box, opencode, pinned(null));
  expect(any.npm()).toEqual([]);
  const missing = sandbox(new Map());
  await ensureAgent(missing.box, opencode, pinned(null));
  expect(missing.npm()).toEqual(["@opencode/cli"]);
});

it("never installs on a sandbox simulated on a Mac, whose CLI is the Mac's", async () => {
  const local = sandbox(new Map([["opencode", "2.0.10"]]));
  await ensureAgent(local.box, opencode, { ...pinned("2.0.11"), mayInstall: false });
  expect(local.npm()).toEqual([]);
  await expect(ensureAgent(sandbox(new Map()).box, opencode, { ...pinned("2.0.11"), mayInstall: false })).rejects.toThrow("OpenCode is not installed on this Mac, where this sandbox is simulated.");
});

it("takes the command's name over from the image's own copy of the CLI, which npm otherwise refuses to replace", async () => {
  const installed = new Map([["opencode", "1.0.0"]]);
  const { box, runs } = sandbox(installed);
  const exec = box.exec.bind(box);
  box.exec = async (cmd, args, options) =>
    cmd === "npm" && !args.includes("--force") ? { code: 1, stdout: Buffer.alloc(0), stderr: "npm error code EEXIST\nnpm error File exists: /usr/local/bin/opencode" } : exec(cmd, args, options);
  await ensureAgent(box, opencode, pinned("2.0.11"));
  expect(runs.filter((run) => run.cmd === "npm").map((run) => run.args)).toEqual([["install", "-g", "--force", "@opencode/cli@2.0.11"]]);
  expect(installed.get("opencode")).toBe("2.0.11");
});

it("passes on an install that fails for another reason, without forcing it", async () => {
  const { box, runs } = sandbox(new Map());
  box.exec = async (cmd, args) => (runs.push({ cmd, args, sudo: true }), cmd === "sh" ? { code: 1, stdout: Buffer.alloc(0), stderr: "" } : { code: 1, stdout: Buffer.alloc(0), stderr: "npm error 404 Not Found" });
  await expect(ensureAgent(box, opencode, pinned("2.0.11"))).rejects.toThrow("OpenCode could not be installed in the cloud workspace: npm error 404 Not Found");
  expect(runs.filter((run) => run.cmd === "npm")).toHaveLength(1);
});
