import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HarnessId } from "@openorc/protocol";
import { StoredSkills, parseSkillsPayload, readSkills, skillsPayload, storeSkills, type SkillSource } from "./skill-bundle.js";

let dir: string;

beforeEach(async () => {
  dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "openorc-skill-bundle-")));
});

afterEach(async () => {
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

/** A source that gives each agent the skills in the folders named for it, as a person's choice would. */
const chosen = (byAgent: Partial<Record<HarnessId, { name: string; folder: string }[]>>): SkillSource => ({ bundle: (agent) => readSkills(byAgent[agent] ?? []) });

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

describe("a payload of skills", () => {
  it("is kept on disk as it was read, named by the same digests, and replaces what was kept before", async () => {
    const review = await skill("review", { "bin/tool": "#!/bin/sh\n" });
    await chmod(path.join(review, "bin/tool"), 0o755);
    const source = chosen({ claude: [{ name: "review", folder: review }] });
    const sent = await skillsPayload(source);
    expect(sent.count).toBe(1);
    const kept = path.join(dir, "kept", "skills");
    await mkdir(path.join(kept, "codex", "stale"), { recursive: true });
    expect(await storeSkills(kept, parseSkillsPayload(sent.bytes.toString("utf8")))).toBe(1);
    const stored = new StoredSkills(kept);
    expect((await stored.bundle("claude")).digest).toBe((await source.bundle("claude")).digest);
    expect((await stored.bundle("opencode")).skills).toEqual([]);
    expect((await stat(path.join(kept, "claude", "review", "bin", "tool"))).mode & 0o111).not.toBe(0);
    expect(existsSync(path.join(kept, "codex", "stale"))).toBe(false);
    expect((await skillsPayload(stored)).digest).toBe(sent.digest);
  });

  it("is refused whole when a name or a path would leave the folder, or the file is not skills", async () => {
    const kept = path.join(dir, "kept");
    const payload = (name: string, file: string) => ({
      v: 1 as const,
      agents: { claude: [{ name, files: [{ path: file, data: "", executable: false }] }], codex: [], opencode: [], omp: [], cursor: [], pi: [], antigravity: [], fx: [] },
    });
    await expect(storeSkills(kept, payload("../up", "SKILL.md"))).rejects.toThrow(/cannot be kept/);
    await expect(storeSkills(kept, payload("ok", "../../etc/passwd"))).rejects.toThrow(/outside its folder/);
    await expect(storeSkills(kept, payload("ok", "/etc/passwd"))).rejects.toThrow(/outside its folder/);
    expect(existsSync(kept)).toBe(false);
    expect(() => parseSkillsPayload(JSON.stringify({ v: 2, agents: {} }))).toThrow(/not in a form/);
    expect(() => parseSkillsPayload(JSON.stringify({ v: 1, agents: { claude: [{ name: "x", files: [{ path: 1 }] }] } }))).toThrow(/not in a form/);
  });
});
