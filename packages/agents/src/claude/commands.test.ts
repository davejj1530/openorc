import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listSkills } from "../skills.js";
import { SHARED_CLAUDE_CONFIG_DIR } from "./config-dir.js";
import { listClaudeCommands } from "./commands.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function temp(prefix: string): Promise<string> {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

/** A stand-in CLI that answers initialize with `commands`, and notes where and how it was started. */
async function cli(commands: unknown[]) {
  const dir = await temp("openorc-claude-commands-");
  const binary = path.join(dir, "claude");
  const calls = path.join(dir, "calls");
  await writeFile(
    binary,
    `#!${process.execPath}
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(calls)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  process.stdout.write(JSON.stringify({ type: "control_response", response: { request_id: request.request_id, subtype: "success", response: { commands: ${JSON.stringify(commands)} } } }) + "\\n");
});
setInterval(() => {}, 1000);
`,
    { mode: 0o755 },
  );
  return { binary, started: async () => JSON.parse(await readFile(calls, "utf8")) as { args: string[]; cwd: string } };
}

describe.skipIf(process.platform === "win32")("Claude Code's own command list", () => {
  it("is asked for where a run starts, with a run's settings and an added account's plugins, and leaves out what cannot be picked", async () => {
    const folder = await temp("openorc-claude-commands-project-");
    const shared = await temp("openorc-claude-commands-shared-");
    const plugin = path.join(shared, "plugins", "cache", "demo");
    await mkdir(plugin, { recursive: true });
    await writeFile(
      path.join(shared, "plugins", "installed_plugins.json"),
      JSON.stringify({ plugins: { "demo@market": [{ installPath: plugin }], "off@market": [{ installPath: path.join(shared, "off") }] } }),
    );
    await writeFile(path.join(shared, "settings.json"), JSON.stringify({ enabledPlugins: { "demo@market": true, "off@market": false } }));
    const f = await cli([
      { name: "code-review", description: "Review the current diff", builtin: true, aliases: ["review"] },
      { name: "demo:audit", description: "(demo) Audit it", aliases: ["audit"] },
      { name: "__remote-workflow", description: "Internal", builtin: true },
      { name: "my notes", description: "A name with a space (project)" },
      { name: "model", description: "Set the model", builtin: true },
      { name: 7 },
    ]);

    const commands = await listClaudeCommands({ binary: f.binary, env: { ...process.env, [SHARED_CLAUDE_CONFIG_DIR]: shared } }, folder);

    expect(commands).toEqual([
      { name: "code-review", description: "Review the current diff", builtin: true, aliases: ["review"] },
      { name: "demo:audit", description: "(demo) Audit it", builtin: false, aliases: ["audit"] },
    ]);
    const started = await f.started();
    expect(started.cwd).toBe(folder);
    expect(started.args).not.toContain("--setting-sources");
    expect(started.args.filter((_arg, index) => started.args[index - 1] === "--plugin-dir")).toEqual([plugin]);
  });

  it("makes the skills list, built-ins and all, with what the folders know about each, and falls back to the folders when it cannot be asked", async () => {
    const project = await temp("openorc-claude-commands-skills-");
    const configDir = await temp("openorc-claude-commands-config-");
    await mkdir(path.join(project, ".claude", "skills", "deploy"), { recursive: true });
    await writeFile(path.join(project, ".claude", "skills", "deploy", "SKILL.md"), "---\nname: deploy\ndescription: Ship it.\n---\n");
    const f = await cli([
      { name: "deploy", description: "Ship it. (project)" },
      { name: "parent-skill", description: "From a folder above the project. (project)" },
      { name: "notes", description: "Personal. (user)" },
      { name: "pstack:how", description: "(pstack (Claude Code port)) How it works", aliases: ["how"] },
      { name: "init", description: "Initialize a CLAUDE.md", builtin: true },
    ]);
    const env = { ...process.env, CLAUDE_CONFIG_DIR: configDir };

    const skills = await listSkills({ projectRoot: project, agent: "claude", home: configDir, launch: { binary: f.binary, env } });

    expect(skills).toEqual([
      { name: "deploy", description: "Ship it.", source: "project", path: path.join(project, ".claude", "skills", "deploy", "SKILL.md") },
      { name: "init", description: "Initialize a CLAUDE.md", source: "system", path: "" },
      { name: "notes", description: "Personal.", source: "user", path: "" },
      { name: "parent-skill", description: "From a folder above the project.", source: "project", path: "" },
      { name: "pstack:how", description: "How it works", source: "plugin", path: "", aliases: ["how"] },
    ]);
    const missing = await listSkills({ projectRoot: project, agent: "claude", home: configDir, launch: { binary: path.join(configDir, "no-claude"), env } });
    expect(missing.map((skill) => skill.name)).toEqual(["deploy"]);
  });
});
