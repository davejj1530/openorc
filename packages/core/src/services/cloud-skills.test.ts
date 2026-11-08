import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalSandboxProvider, type Sandbox } from "@openorc/cloud";
import { Db } from "@openorc/db";
import type { AgentSkill, HarnessId } from "@openorc/protocol";
import { CloudSkills, SandboxSkills, StoredCloudSkills, parseSkillsPayload, placeSkills, readSkills, sandboxSkillsDir, skillsPayload, storeSkills } from "./cloud-skills.js";

let dir: string;
let db: Db;

beforeEach(async () => {
  dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "openorc-cloud-skills-")));
  db = Db.memory();
});

afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

/** A skill folder on disk, as an agent keeps one. */
async function skill(name: string, files: Record<string, string> = {}): Promise<string> {
  const folder = path.join(dir, "home", name);
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} things\n---\n`);
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(folder, file)), { recursive: true });
    await writeFile(path.join(folder, file), content);
  }
  return folder;
}

/** Each agent's skills as listSkills would find them: user skills and a project's. */
function lister(byAgent: Partial<Record<HarnessId, AgentSkill[]>>) {
  const calls: HarnessId[] = [];
  const list = async ({ agent }: { agent: HarnessId }) => {
    calls.push(agent);
    return byAgent[agent] ?? [];
  };
  return { list: list as never, calls };
}

const user = (name: string, folder: string): AgentSkill => ({ name, description: `${name} things`, source: "user", path: path.join(folder, "SKILL.md") });

describe("choosing the user's skills for cloud sessions", () => {
  it("lists each agent's own skills it uses, not a project's, and remembers which go", async () => {
    const review = await skill("review");
    const { list } = lister({
      claude: [user("review", review), { name: "local", description: "", source: "project", path: "/p/.claude/skills/local/SKILL.md" }],
      codex: [user("review", review), { ...user("drafts", review), enabled: false }],
    });
    const skills = new CloudSkills({ db, root: dir, list });
    expect(await skills.catalog()).toEqual({
      agents: [
        { agent: "codex", skills: [{ name: "review", description: "review things", chosen: false }], error: null },
        { agent: "claude", skills: [{ name: "review", description: "review things", chosen: false }], error: null },
        { agent: "opencode", skills: [], error: null },
      ],
    });
    const of = (view: Awaited<ReturnType<CloudSkills["catalog"]>>, agent: HarnessId) => view.agents.find((each) => each.agent === agent)!.skills[0]!.chosen;
    const chosen = await skills.choose("claude", "review", true);
    expect(of(chosen, "claude")).toBe(true);
    // Each agent's choice is its own.
    expect(of(chosen, "codex")).toBe(false);
    expect(of(await new CloudSkills({ db, root: dir, list }).catalog(), "claude")).toBe(true);
    expect(of(await skills.choose("claude", "review", false), "claude")).toBe(false);
  });

  it("says why an agent could not list its skills, beside the others'", async () => {
    const list = async ({ agent }: { agent: HarnessId }) => {
      if (agent === "codex") throw new Error("Codex is not installed.");
      return [];
    };
    const { agents } = await new CloudSkills({ db, root: dir, list: list as never }).catalog();
    expect(agents.map(({ agent, error }) => [agent, error])).toEqual([
      ["codex", "Codex is not installed."],
      ["claude", null],
      ["opencode", null],
    ]);
  });

  it("bundles only the chosen skills the agent still has, asking the agent again only after a minute", async () => {
    const review = await skill("review", { "scripts/run.sh": "#!/bin/sh\necho hi\n" });
    await chmod(path.join(review, "scripts/run.sh"), 0o755);
    const other = await skill("other");
    const { list, calls } = lister({ claude: [user("review", review), user("other", other)] });
    const skills = new CloudSkills({ db, root: dir, list });
    expect((await skills.bundle("claude")).skills).toEqual([]);
    await skills.choose("claude", "review", true);
    await skills.choose("claude", "gone", true);
    const bundle = await skills.bundle("claude");
    expect(bundle.skills.map((each) => each.name)).toEqual(["review"]);
    expect(bundle.skills[0]!.files.map(({ path: file, executable }) => [file, executable]).sort()).toEqual([
      ["SKILL.md", false],
      ["scripts/run.sh", true],
    ]);
    const asked = calls.length;
    await skills.bundle("claude");
    expect(calls.length).toBe(asked);
  });
});

describe("reading a skill's folder", () => {
  it("leaves out what a skill never needs and files too large, and names the same skills the same", async () => {
    const folder = await skill("big", { "node_modules/x/index.js": "x", ".git/HEAD": "ref", "huge.bin": "x".repeat(1024 * 1024 + 1), "docs/a.md": "a" });
    await writeFile(path.join(folder, ".DS_Store"), "");
    const bundle = await readSkills([{ name: "big", folder }]);
    expect(bundle.skills[0]!.files.map((file) => file.path).sort()).toEqual(["SKILL.md", "docs/a.md"]);
    expect(bundle.skipped).toEqual(["big/huge.bin"]);
    expect((await readSkills([{ name: "big", folder }])).digest).toBe(bundle.digest);
    await writeFile(path.join(folder, "docs/a.md"), "changed");
    expect((await readSkills([{ name: "big", folder }])).digest).not.toBe(bundle.digest);
  });

  it("skips a name no agent folder can hold", async () => {
    const folder = await skill("fine");
    expect((await readSkills([{ name: "../escape", folder }])).skills).toEqual([]);
  });
});

describe("the skills a Mac sends its cloud brain", () => {
  it("arrive as the brain keeps them, named by the same digests, and replace what it kept before", async () => {
    const review = await skill("review", { "bin/tool": "#!/bin/sh\n" });
    await chmod(path.join(review, "bin/tool"), 0o755);
    const { list } = lister({ claude: [user("review", review)], opencode: [user("review", review)] });
    const mac = new CloudSkills({ db, root: dir, list });
    await mac.choose("claude", "review", true);
    const sent = await skillsPayload(mac);
    expect(sent.count).toBe(1);
    const kept = path.join(dir, "brain", "cloud-skills");
    await mkdir(path.join(kept, "codex", "stale"), { recursive: true });
    expect(await storeSkills(kept, parseSkillsPayload(sent.bytes.toString("utf8")))).toBe(1);
    const brain = new StoredCloudSkills(kept);
    expect((await brain.bundle("claude")).digest).toBe((await mac.bundle("claude")).digest);
    expect((await stat(path.join(kept, "claude", "review", "bin", "tool"))).mode & 0o111).not.toBe(0);
    expect(existsSync(path.join(kept, "codex", "stale"))).toBe(false);
    expect((await skillsPayload(brain)).digest).toBe(sent.digest);
  });

  it("are refused whole when a name or a path would leave the brain's folder, or the file is not skills", async () => {
    const kept = path.join(dir, "kept");
    const payload = (name: string, file: string) => ({ v: 1 as const, agents: { claude: [{ name, files: [{ path: file, data: "", executable: false }] }], codex: [], opencode: [] } });
    await expect(storeSkills(kept, payload("../up", "SKILL.md"))).rejects.toThrow(/cannot be kept/);
    await expect(storeSkills(kept, payload("ok", "../../etc/passwd"))).rejects.toThrow(/outside its folder/);
    await expect(storeSkills(kept, payload("ok", "/etc/passwd"))).rejects.toThrow(/outside its folder/);
    expect(existsSync(kept)).toBe(false);
    expect(() => parseSkillsPayload(JSON.stringify({ v: 2, agents: {} }))).toThrow(/not in a form/);
    expect(() => parseSkillsPayload(JSON.stringify({ v: 1, agents: { claude: [{ name: "x", files: [{ path: 1 }] }] } }))).toThrow(/not in a form/);
  });
});

describe("skills in a sandbox", () => {
  let sandbox: Sandbox;
  let home: string;

  beforeEach(async () => {
    home = path.join(dir, "sandbox-home");
    await mkdir(home, { recursive: true });
    // A home of its own: the agents' folders here are never this Mac's.
    sandbox = await new LocalSandboxProvider(path.join(dir, "sandboxes"), () => ({ PATH: process.env["PATH"], HOME: home })).open("one");
  });

  it("go where each agent finds its user's skills, under the turn's folders", async () => {
    expect(await sandboxSkillsDir(sandbox, "claude", { CLAUDE_CONFIG_DIR: "/state/claude" })).toBe("/state/claude/skills");
    expect(await sandboxSkillsDir(sandbox, "claude", {})).toBe(path.join(home, ".claude", "skills"));
    expect(await sandboxSkillsDir(sandbox, "codex", { CODEX_HOME: "/state/codex" })).toBe("/state/codex/skills");
    expect(await sandboxSkillsDir(sandbox, "opencode", { XDG_DATA_HOME: "/state/opencode" })).toBe(path.join(home, ".config", "opencode", "skills"));
  });

  it("replace the skills OpenOrc put there before, leave the agent's others alone, and keep scripts runnable", async () => {
    const target = path.join(home, ".claude", "skills");
    await mkdir(path.join(target, "theirs"), { recursive: true });
    await writeFile(path.join(target, "theirs", "SKILL.md"), "the sandbox's own");
    const review = await skill("review", { "run.sh": "#!/bin/sh\n" });
    await chmod(path.join(review, "run.sh"), 0o755);
    const first = await readSkills([
      { name: "review", folder: review },
      { name: "draft", folder: await skill("draft") },
    ]);
    await placeSkills(sandbox, target, first);
    expect((await readdir(target)).sort()).toEqual([".openorc-skills.json", "draft", "review", "theirs"]);
    expect((await stat(path.join(target, "review", "run.sh"))).mode & 0o111).not.toBe(0);
    await writeFile(path.join(target, "review", "leftover.md"), "from before");
    await placeSkills(sandbox, target, await readSkills([{ name: "review", folder: review }]));
    expect((await readdir(target)).sort()).toEqual([".openorc-skills.json", "review", "theirs"]);
    expect(existsSync(path.join(target, "review", "leftover.md"))).toBe(false);
    expect(await readFile(path.join(target, "theirs", "SKILL.md"), "utf8")).toBe("the sandbox's own");
  });

  it("write nothing where none were ever sent", async () => {
    const target = path.join(home, ".codex", "skills");
    await placeSkills(sandbox, target, await readSkills([]));
    expect(existsSync(target)).toBe(false);
  });

  it("are placed once per sandbox while they are unchanged, and a failure lets the turn run without them", async () => {
    const review = await skill("review");
    const bundle = await readSkills([{ name: "review", folder: review }]);
    let reads = 0;
    const source = {
      bundle: async () => {
        reads++;
        return bundle;
      },
    };
    const warnings: string[] = [];
    const runs: string[] = [];
    const counted = {
      exec: (cmd: string, args: string[], options?: object) => (runs.push(cmd), sandbox.exec(cmd, args, options)),
      readFile: (file: string) => sandbox.readFile(file),
      writeFile: (file: string, bytes: Buffer) => sandbox.writeFile(file, bytes),
    } as unknown as Sandbox;
    const skills = new SandboxSkills(source, (message) => warnings.push(message));
    const folders = { CLAUDE_CONFIG_DIR: path.join(dir, "state", "claude") };
    await skills.place(counted, "claude", folders);
    expect(existsSync(path.join(folders.CLAUDE_CONFIG_DIR, "skills", "review", "SKILL.md"))).toBe(true);
    const asked = runs.length;
    await skills.place(counted, "claude", folders);
    expect(runs.length).toBe(asked);
    expect(reads).toBe(2);
    const broken = { exec: async () => ({ code: 1, stdout: Buffer.alloc(0), stderr: "gone" }) } as unknown as Sandbox;
    await skills.place(broken, "codex", { CODEX_HOME: "/nowhere" });
    expect(warnings).toEqual(["codex's skills did not reach its sandbox, so this turn runs without them: The sandbox did not say where codex's skills go."]);
  });
});
