import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentSkill } from "@openorc/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostedSkills } from "./hosted-skills.js";

let home: string;
beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "openorc-hosted-skills-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

type Listed = Pick<AgentSkill, "name" | "path" | "source"> & Partial<AgentSkill>;

/** A skill folder under `dir` with these files, and how its agent lists it. */
async function skill(dir: string, name: string, files: Record<string, string> = { "SKILL.md": `Use ${name}.` }, listed: Partial<AgentSkill> = {}): Promise<Listed> {
  for (const [file, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(home, dir, name, file)), { recursive: true });
    await writeFile(path.join(home, dir, name, file), text);
  }
  return { name, description: "", source: "user", path: path.join(home, dir, name, "SKILL.md"), ...listed };
}

const skillsOf = (listed: () => Listed[] | Promise<Listed[]>, now: () => number = Date.now) => {
  const list = vi.fn(async () => (await listed()) as AgentSkill[]);
  return { skills: new HostedSkills({ root: home, list, now }), list };
};

async function packOf(own: { pack(): AsyncIterable<Uint8Array> }): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of own.pack()) chunks.push(chunk);
  return Buffer.concat(chunks);
}

const frame = (file: string, mode: "x" | "-", text: string) => `${file}\0${mode}\0${Buffer.byteLength(text)}\0${text}`;

describe("the person's own skills on this Mac, for their cloud turns", () => {
  it("gives the agent's own skills that are on, by their folder, and none of a project's, a plugin's or the agent's built-ins", async () => {
    const listed = [
      await skill("user", "review"),
      await skill("user", "off", undefined, { enabled: false }),
      await skill("project", "deploy", undefined, { source: "project" }),
      await skill("plugin", "lint", undefined, { source: "plugin" }),
      { name: "init", description: "", source: "system" as const, path: "" },
    ];
    const { skills, list } = skillsOf(() => listed);
    expect((await skills.own("claude")).map((own) => own.name)).toEqual(["review"]);
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ projectRoot: home, agent: "claude" }));
  });

  it("packs each file under the skill's folder in the order of their paths, marks the ones that run, and names the pack by its SHA-256", async () => {
    const review = await skill("user", "review", { "SKILL.md": "Read the diff.", "scripts/check.sh": "#!/bin/sh\necho ok\n", "notes/a.md": "A" });
    await chmod(path.join(home, "user/review/scripts/check.sh"), 0o755);
    const [own] = await skillsOf(() => [review]).skills.own("codex");
    const pack = await packOf(own!);
    expect(pack.toString()).toBe(frame("review/SKILL.md", "-", "Read the diff.") + frame("review/notes/a.md", "-", "A") + frame("review/scripts/check.sh", "x", "#!/bin/sh\necho ok\n"));
    expect(own!.digest).toBe(createHash("sha256").update(pack).digest("hex"));
  });

  it("names a skill by the folder its agent finds it in, and reads through a link to it and a link to a file inside it", async () => {
    await skill("shared", "ask", { "SKILL.md": "Ask first.", "extra.md": "More." });
    await mkdir(path.join(home, "claude"), { recursive: true });
    await symlink(path.join(home, "shared", "ask"), path.join(home, "claude", "ask-first"));
    await writeFile(path.join(home, "elsewhere.md"), "Linked in.");
    await symlink(path.join(home, "elsewhere.md"), path.join(home, "shared", "ask", "linked.md"));
    const listed: Listed = { name: "ask", description: "", source: "user", path: path.join(home, "claude", "ask-first", "SKILL.md") };
    const [own] = await skillsOf(() => [listed]).skills.own("claude");
    expect(own!.name).toBe("ask-first");
    expect((await packOf(own!)).toString()).toBe(frame("ask-first/SKILL.md", "-", "Ask first.") + frame("ask-first/extra.md", "-", "More.") + frame("ask-first/linked.md", "-", "Linked in."));
  });

  it("leaves out what a skill never needs in the cloud, and nothing else", async () => {
    const review = await skill("user", "review", {
      "SKILL.md": "Read the diff.",
      ".DS_Store": "x",
      ".git/config": "x",
      "node_modules/pkg/index.js": "x",
      "__pycache__/a.pyc": "x",
      ".venv/bin/python": "x",
      "assets/big.bin": "b".repeat(3 * 1024 * 1024),
      ".hidden/keep.md": "Kept.",
    });
    const [own] = await skillsOf(() => [review]).skills.own("claude");
    const pack = await packOf(own!);
    const paths = [...pack.toString("latin1").matchAll(/review\/[^\0]+(?=\0[x-]\0)/g)].map((match) => match[0]);
    expect(paths).toEqual(["review/.hidden/keep.md", "review/SKILL.md", "review/assets/big.bin"]);
    expect(pack.length).toBeGreaterThan(3 * 1024 * 1024);
  });

  it("keeps a skill's digest while its files are as they were, without reading them again, and changes it when one changes", async () => {
    const review = await skill("user", "review", { "SKILL.md": "Read the diff." });
    const { skills } = skillsOf(() => [review]);
    const first = (await skills.own("claude"))[0]!.digest;
    const file = path.join(home, "user/review/SKILL.md");
    // A file that can no longer be read still has the digest it had: it was not opened.
    await chmod(file, 0o000);
    expect((await skills.own("claude"))[0]!.digest).toBe(first);
    await chmod(file, 0o644);
    await writeFile(file, "Read it twice.");
    await utimes(file, new Date(), new Date(Date.now() + 5_000));
    const second = (await skills.own("claude"))[0]!.digest;
    expect(second).not.toBe(first);
    await chmod(file, 0o755);
    expect((await skills.own("claude"))[0]!.digest).not.toBe(second);
  });

  it("keeps the first of two skills in folders of one name", async () => {
    const listed = [await skill("claude", "review", { "SKILL.md": "First." }), await skill("agents", "review", { "SKILL.md": "Second." })];
    const own = await skillsOf(() => listed).skills.own("claude");
    expect(own).toHaveLength(1);
    expect((await packOf(own[0]!)).toString()).toBe(frame("review/SKILL.md", "-", "First."));
  });

  it("leaves out a skill that can't be read, says which and why in plain words, and gives the rest", async () => {
    const gone: Listed = { name: "gone", description: "", source: "user", path: path.join(home, "user", "gone", "SKILL.md") };
    const locked = await skill("user", "tdd", { "SKILL.md": "Test first.", "notes/private.md": "Mine." });
    await chmod(path.join(home, "user/tdd/notes/private.md"), 0o000);
    const linked = await skill("user", "ux", { "SKILL.md": "Design well." });
    await symlink(path.join(home, "deleted-folder"), path.join(home, "user/ux/data"));
    const { skills } = skillsOf(async () => [await skill("user", "review"), gone, locked, linked]);
    expect((await skills.own("claude")).map((own) => own.name)).toEqual(["review"]);
    expect(skills.leftOut("claude")).toEqual([
      { name: "gone", cause: "its folder is no longer there." },
      { name: "tdd", cause: "its file notes/private.md can't be read." },
      { name: "ux", cause: "its link data points to something that is no longer there." },
    ]);
    await chmod(path.join(home, "user/tdd/notes/private.md"), 0o644);
  });

  it("says what it left out once, and again only when a skill or its cause changes", async () => {
    let now = 1_000_000;
    const linked = await skill("user", "ux", { "SKILL.md": "Design well." });
    await symlink(path.join(home, "deleted-folder"), path.join(home, "user/ux/data"));
    const changed = vi.fn();
    const list = vi.fn(async () => [await skill("user", "review"), linked] as AgentSkill[]);
    const skills = new HostedSkills({ root: home, list, now: () => now, changed });
    await skills.own("codex");
    now += 120_000;
    await skills.own("codex");
    expect(changed).toHaveBeenCalledTimes(1);
    await rm(path.join(home, "user/ux/data"));
    await mkdir(path.join(home, "deleted-folder"));
    await symlink(path.join(home, "deleted-folder"), path.join(home, "user/ux/data"));
    now += 120_000;
    expect((await skills.own("codex")).map((own) => own.name)).toEqual(["review", "ux"]);
    expect(skills.leftOut("codex")).toEqual([]);
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it("refuses to send a skill whose file changed since it was listed", async () => {
    const review = await skill("user", "review", { "SKILL.md": "Read the diff." });
    const [own] = await skillsOf(() => [review]).skills.own("claude");
    await writeFile(path.join(home, "user/review/SKILL.md"), "Read the diff, then read it again.");
    await expect(packOf(own!)).rejects.toThrow("The skill review changed while it was being sent. Send again.");
    await rm(path.join(home, "user/review/SKILL.md"));
    await expect(packOf(own!)).rejects.toThrow("The skill review changed while it was being sent. Send again.");
  });

  it("asks the agent for its skills once a minute at most, and gives what it last said while it is asked again", async () => {
    let now = 1_000_000;
    let listed = [await skill("user", "review")];
    const { skills, list } = skillsOf(
      () => listed,
      () => now,
    );
    expect((await skills.own("codex")).map((own) => own.name)).toEqual(["review"]);
    listed = [...listed, await skill("user", "ship")];
    now += 30_000;
    expect((await skills.own("codex")).map((own) => own.name)).toEqual(["review"]);
    expect(list).toHaveBeenCalledTimes(1);
    // A minute on, this call still answers at once with the last listing, and the next has the new one.
    now += 31_000;
    expect((await skills.own("codex")).map((own) => own.name)).toEqual(["review"]);
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    await vi.waitFor(async () => expect((await skills.own("codex")).map((own) => own.name)).toEqual(["review", "ship"]));
    // Each agent is asked for its own.
    await skills.own("claude");
    expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ agent: "claude" }));
  });

  it("says why when the agent cannot list its skills, asks again the next time, and keeps its last listing through a later failure", async () => {
    let now = 1_000_000;
    let fails = true;
    const review = await skill("user", "review");
    const { skills, list } = skillsOf(
      () => {
        if (fails) throw new Error("Codex could not list skills for this project.");
        return [review];
      },
      () => now,
    );
    await expect(skills.own("codex")).rejects.toThrow("Codex could not list skills for this project.");
    fails = false;
    expect((await skills.own("codex")).map((own) => own.name)).toEqual(["review"]);
    fails = true;
    now += 61_000;
    expect((await skills.own("codex")).map((own) => own.name)).toEqual(["review"]);
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(3));
    expect((await skills.own("codex")).map((own) => own.name)).toEqual(["review"]);
  });

  it("lists Claude's skills as its default account finds them", async () => {
    const list = vi.fn(async (_asked: { agent: string; env?: NodeJS.ProcessEnv }) => [] as AgentSkill[]);
    const skills = new HostedSkills({ root: home, list, claudeEnv: () => ({ CLAUDE_CONFIG_DIR: "/accounts/default" }) });
    await skills.own("claude");
    await skills.own("codex");
    expect(list.mock.calls.map(([asked]) => [asked.agent, asked.env?.["CLAUDE_CONFIG_DIR"]])).toEqual([
      ["claude", "/accounts/default"],
      ["codex", undefined],
    ]);
  });
});
