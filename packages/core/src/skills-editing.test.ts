import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { projects } from "@openorc/db";
import type { AgentSkill, FileScope, HarnessId } from "@openorc/protocol";
import { createSkillsHandlers } from "./handlers/skills.js";
import { OpenOrc } from "./openorc.js";
import { rpcClient } from "./rpc-test-client.js";
import { removalTarget } from "./services/skill-library.js";

let root: string;
let home: string;
let claudeDir: string;
let repo: string;
let scope: FileScope;
let trashed: string[];
let core: OpenOrc;

const call = rpcClient(() => core);
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

async function skill(dir: string, name: string, files: Record<string, string> = {}): Promise<string> {
  const folder = path.join(dir, name);
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, "SKILL.md"), `---\nname: ${name}\ndescription: The ${name} fixture.\n---\n\nDo it.\n`);
  for (const [file, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(folder, file)), { recursive: true });
    await writeFile(path.join(folder, file), text);
  }
  return path.join(folder, "SKILL.md");
}

const listed = async (agent: HarnessId, name: string): Promise<AgentSkill | undefined> => (await call("skills.list", { scope, agent })).find((each) => each.name === name);
const ref = (skillPath: string, agent: HarnessId = "claude") => ({ agent, scope, skill: skillPath });

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "openorc-skill-editing-")));
  home = path.join(root, "home");
  claudeDir = path.join(root, "claude");
  repo = path.join(root, "repo");
  await mkdir(path.join(repo, ".git"), { recursive: true });
  await mkdir(home, { recursive: true });
  // Every agent's personal skills resolve under these, never in the real home.
  vi.stubEnv("HOME", home);
  vi.stubEnv("XDG_CONFIG_HOME", path.join(home, ".config"));
  vi.stubEnv("CLAUDE_CONFIG_DIR", claudeDir);
  trashed = [];
  // No shell probe: an ephemeral core keeps this process's agent binaries, the test config's missing ones, so no agent's
  // CLI starts and each listing reads the folders.
  core = await OpenOrc.create({
    dataDir: path.join(root, "data"),
    ephemeral: true,
    transport: { push: () => {} },
    // Records what would go to the Trash and moves nothing, so a test sees that nothing was deleted either.
    trash: async (file) => void trashed.push(file),
  });
  const project = projects.insert(core.db, { name: "Repo", rootPath: repo, gitRemote: null, defaultBranch: null, settings: {} });
  scope = { kind: "project", id: project.id };
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await core?.close();
  await rm(root, { recursive: true, force: true });
});

describe("a skill's files", () => {
  it("lists, reads and saves files inside the skill's folder and nothing outside it", async () => {
    await writeFile(path.join(root, "secret.txt"), "not the skill's");
    const notes = await skill(path.join(claudeDir, "skills"), "notes", { "references/sources.md": "Sources.", ".env": "TOKEN=1", "assets/logo.png": "png" });
    await symlink(path.join(root, "secret.txt"), path.join(path.dirname(notes), "escape.txt"));

    expect(await call("skills.files", ref(notes))).toEqual([
      { path: "assets", kind: "directory" },
      { path: "assets/logo.png", kind: "file" },
      { path: "references", kind: "directory" },
      { path: "references/sources.md", kind: "file" },
      { path: "SKILL.md", kind: "file" },
    ]);
    const read = await call("skills.readFile", { ...ref(notes), file: "SKILL.md" });
    expect(read).toMatchObject({ kind: "text", readOnly: null });
    expect(await call("skills.readFile", { ...ref(notes), file: "assets/logo.png" })).toEqual({ kind: "binary", bytes: 3 });
    for (const file of ["../../secret.txt", "/etc/hosts", "escape.txt", ".env"]) {
      await expect(call("skills.readFile", { ...ref(notes), file })).rejects.toThrow("outside the skill's folder");
    }

    if (read.kind !== "text") throw new Error("expected text");
    const saved = await call("skills.writeFile", { ...ref(notes), file: "SKILL.md", text: "---\nname: notes\ndescription: Edited.\n---\n", expected: read.version });
    expect(saved.kind).toBe("saved");
    expect(await readFile(notes, "utf8")).toContain("Edited.");
    expect((await listed("claude", "notes"))?.description).toBe("Edited.");
    const stale = await call("skills.writeFile", { ...ref(notes), file: "SKILL.md", text: "lost", expected: read.version });
    expect(stale).toMatchObject({ kind: "conflict", current: { kind: "text" } });
    await expect(call("skills.writeFile", { ...ref(notes), file: "escape.txt", text: "x", expected: read.version })).rejects.toThrow("outside the skill's folder");
    expect(await readFile(path.join(root, "secret.txt"), "utf8")).toBe("not the skill's");
  });

  it("opens nothing for a path the agent doesn't list", async () => {
    const stray = await skill(path.join(root, "elsewhere"), "stray");
    await expect(call("skills.files", ref(stray))).rejects.toThrow("no longer there");
  });

  it("refuses to change a skill a claude.ai sync keeps, and says why", async () => {
    const synced = await skill(path.join(home, ".claude", "skills", "synced", "account"), "pptx");
    const read = await call("skills.readFile", { ...ref(synced, "opencode"), file: "SKILL.md" });
    expect(read).toMatchObject({ kind: "text", readOnly: "Synced from claude.ai" });
    if (read.kind !== "text") throw new Error("expected text");
    await expect(call("skills.writeFile", { ...ref(synced, "opencode"), file: "SKILL.md", text: "x", expected: read.version })).rejects.toThrow("Synced from claude.ai, so it can't be changed here.");
    await expect(call("skills.setIcon", { ...ref(synced, "opencode"), image: `data:image/png;base64,${PNG}` })).rejects.toThrow("can't be changed here");
    await expect(call("skills.remove", ref(synced, "opencode"))).rejects.toThrow("can't be changed here");
    expect(trashed).toEqual([]);
    expect(await readFile(synced, "utf8")).toContain("pptx");
  });
});

describe("turning a skill on and off", () => {
  it("writes Claude's skillOverrides in the account's settings, keeping the rest, and lists the skill off", async () => {
    const notes = await skill(path.join(claudeDir, "skills"), "notes");
    await writeFile(path.join(claudeDir, "settings.json"), '{\n  "model": "opus",\n  "enabledPlugins": { "figma@official": true }\n}\n');

    expect(await call("skills.setEnabled", { ...ref(notes), enabled: false })).toEqual({ enabled: false });
    expect(JSON.parse(await readFile(path.join(claudeDir, "settings.json"), "utf8"))).toEqual({ model: "opus", enabledPlugins: { "figma@official": true }, skillOverrides: { notes: "off" } });
    expect((await listed("claude", "notes"))?.enabled).toBe(false);

    expect(await call("skills.setEnabled", { ...ref(notes), enabled: true })).toEqual({ enabled: true });
    expect(JSON.parse(await readFile(path.join(claudeDir, "settings.json"), "utf8"))).toEqual({ model: "opus", enabledPlugins: { "figma@official": true } });
  });

  it("says when a project's settings keep the skill off", async () => {
    const notes = await skill(path.join(claudeDir, "skills"), "notes");
    await mkdir(path.join(repo, ".claude"), { recursive: true });
    await writeFile(path.join(repo, ".claude", "settings.local.json"), JSON.stringify({ skillOverrides: { notes: "off" } }));
    await expect(call("skills.setEnabled", { ...ref(notes), enabled: true })).rejects.toThrow("This project's Claude Code settings keep this skill off.");
  });

  it("asks Codex to switch a skill by its file, and refuses a skill with no switch", async () => {
    const rows: AgentSkill[] = [
      { name: "review", description: "", source: "user", path: path.join(home, ".agents", "skills", "review", "SKILL.md"), enabled: true, editable: true },
      { name: "init", description: "", source: "system", path: path.join(home, "builtin", "SKILL.md"), editable: false },
    ];
    const switched: unknown[] = [];
    const handlers = createSkillsHandlers({
      db: core.db,
      files: core.files,
      list: async () => rows,
      setEnabled: async (input) => {
        switched.push({ agent: input.agent, path: input.skill.path, enabled: input.enabled });
        return input.enabled;
      },
    });
    expect(await handlers["skills.setEnabled"]({ agent: "codex", scope, skill: rows[0]!.path, enabled: false })).toEqual({ enabled: false });
    expect(switched).toEqual([{ agent: "codex", path: rows[0]!.path, enabled: false }]);
    await expect(handlers["skills.setEnabled"]({ agent: "codex", scope, skill: rows[1]!.path, enabled: false })).rejects.toThrow("Codex has no switch for this skill.");
  });
});

describe("a skill's image", () => {
  it("writes the image into the skill's assets, points its interface file at it, and lists it", async () => {
    const notes = await skill(path.join(claudeDir, "skills"), "notes", { "agents/openai.yaml": 'interface:\n  display_name: "Notes"\n' });
    const folder = path.dirname(notes);

    const set = await call("skills.setIcon", { ...ref(notes), image: `data:image/png;base64,${PNG}` });
    expect(set.icon).toBe(`data:image/png;base64,${PNG}`);
    expect((await readFile(path.join(folder, "assets", "icon.png"))).toString("base64")).toBe(PNG);
    expect(await readFile(path.join(folder, "agents", "openai.yaml"), "utf8")).toBe('interface:\n  display_name: "Notes"\n  icon_small: "./assets/icon.png"\n  icon_large: "./assets/icon.png"\n');
    expect(await listed("claude", "notes")).toMatchObject({ displayName: "Notes", icon: `data:image/png;base64,${PNG}` });

    const svg = `data:image/svg+xml;base64,${Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"/>').toString("base64")}`;
    expect((await call("skills.setIcon", { ...ref(notes), image: svg })).icon).toBe(svg);
    await expect(lstat(path.join(folder, "assets", "icon.png"))).rejects.toThrow();
    expect((await listed("claude", "notes"))?.icon).toBe(svg);

    expect(await call("skills.setIcon", { ...ref(notes), image: null })).toEqual({ icon: null });
    await expect(lstat(path.join(folder, "assets", "icon.svg"))).rejects.toThrow();
    expect(await readFile(path.join(folder, "agents", "openai.yaml"), "utf8")).toBe('interface:\n  display_name: "Notes"\n');
    expect(await listed("claude", "notes")).not.toHaveProperty("icon");
  });

  it("refuses what is not the image it says it is", async () => {
    const notes = await skill(path.join(claudeDir, "skills"), "notes");
    await expect(call("skills.setIcon", { ...ref(notes), image: `data:image/png;base64,${Buffer.from("<svg/>").toString("base64")}` })).rejects.toThrow("could not be read");
    await expect(call("skills.setIcon", { ...ref(notes), image: "data:image/gif;base64,R0lGODlhAQABAAAAACw=" })).rejects.toThrow("Choose a PNG, JPEG, WebP or SVG image.");
    await expect(lstat(path.join(path.dirname(notes), "assets"))).rejects.toThrow();
  });
});

describe("new skills", () => {
  it("creates a skill where its agent finds it, and never over one already there", async () => {
    const created = await call("skills.create", { agent: "claude", scope, place: "user", name: "release-notes", description: "Drafts release notes: short ones.", instructions: "Read the log." });
    expect(created.skill).toBe(path.join(claudeDir, "skills", "release-notes", "SKILL.md"));
    expect(await listed("claude", "release-notes")).toMatchObject({ description: "Drafts release notes: short ones.", source: "user", editable: true, enabled: true });
    await expect(call("skills.create", { agent: "claude", scope, place: "user", name: "release-notes", description: "Again.", instructions: "" })).rejects.toThrow("already there");
    expect(await readFile(created.skill, "utf8")).toContain("Read the log.");

    const project = await call("skills.create", { agent: "opencode", scope, place: "project", name: "deploy", description: "Ships it.", instructions: "" });
    expect(project.skill).toBe(path.join(repo, ".opencode", "skills", "deploy", "SKILL.md"));
    expect(await listed("opencode", "deploy")).toMatchObject({ source: "project", path: project.skill });

    const codex = await call("skills.create", { agent: "codex", scope, place: "user", name: "triage", description: "Sorts issues.", instructions: "" });
    expect(codex.skill).toBe(path.join(home, ".agents", "skills", "triage", "SKILL.md"));
  });

  it("imports a skill folder, leaving out hidden entries and links that lead outside it", async () => {
    await writeFile(path.join(root, "secret.txt"), "not the skill's");
    const source = path.dirname(await skill(path.join(root, "downloads"), "pdf-tools", { "scripts/run.sh": "#!/bin/sh\n", ".git/config": "[core]", "references/notes.md": "Notes." }));
    await chmod(path.join(source, "scripts", "run.sh"), 0o755);
    await symlink(path.join(root, "secret.txt"), path.join(source, "secret.txt"));
    await symlink(path.join(source, "references", "notes.md"), path.join(source, "notes-link.md"));

    const imported = await call("skills.import", { agent: "claude", scope, place: "project", from: source });
    const folder = path.join(repo, ".claude", "skills", "pdf-tools");
    expect(imported.skill).toBe(path.join(folder, "SKILL.md"));
    expect(await call("skills.files", ref(imported.skill))).toEqual([
      { path: "notes-link.md", kind: "file" },
      { path: "references", kind: "directory" },
      { path: "references/notes.md", kind: "file" },
      { path: "scripts", kind: "directory" },
      { path: "scripts/run.sh", kind: "file" },
      { path: "SKILL.md", kind: "file" },
    ]);
    await expect(lstat(path.join(folder, ".git"))).rejects.toThrow();
    await expect(lstat(path.join(folder, "secret.txt"))).rejects.toThrow();
    expect((await lstat(path.join(folder, "notes-link.md"))).isSymbolicLink()).toBe(false);
    expect((await stat(path.join(folder, "scripts", "run.sh"))).mode & 0o777).toBe(0o755);

    await expect(call("skills.import", { agent: "claude", scope, place: "project", from: source })).rejects.toThrow("already there");
    await mkdir(path.join(root, "Not A Skill"), { recursive: true });
    await expect(call("skills.import", { agent: "claude", scope, place: "project", from: path.join(root, "Not A Skill") })).rejects.toThrow("lowercase words joined by hyphens");
    await mkdir(path.join(root, "empty-folder"), { recursive: true });
    await expect(call("skills.import", { agent: "claude", scope, place: "project", from: path.join(root, "empty-folder") })).rejects.toThrow("SKILL.md");
  });
});

describe("removing a skill", () => {
  it("moves the skill's folder to the Trash and deletes nothing itself", async () => {
    const notes = await skill(path.join(claudeDir, "skills"), "notes", { "references/a.md": "A." });
    expect(await call("skills.remove", ref(notes))).toEqual({ removed: true });
    expect(trashed).toEqual([path.dirname(notes)]);
    expect(await readFile(path.join(path.dirname(notes), "references", "a.md"), "utf8")).toBe("A.");
  });

  it("creates a skill whose agent can't list skills right now without leaving that failure unhandled", async () => {
    const unhandled: unknown[] = [];
    const note = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", note);
    try {
      const handlers = createSkillsHandlers({ db: core.db, files: core.files, list: () => Promise.reject(new Error("Codex could not start")) });
      const created = await handlers["skills.create"]({ agent: "codex", scope, place: "user", name: "triage", description: "Sorts issues.", instructions: "" });
      expect(created.skill).toBe(path.join(home, ".agents", "skills", "triage", "SKILL.md"));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", note);
    }
  });

  it("leaves the skill in place where there is no Trash", async () => {
    const notes = await skill(path.join(claudeDir, "skills"), "notes");
    const handlers = createSkillsHandlers({ db: core.db, files: core.files, claudeEnvironment: () => process.env });
    await expect(handlers["skills.remove"](ref(notes))).rejects.toThrow("no Trash");
    expect(await readFile(notes, "utf8")).toContain("notes");
  });

  it("never moves a folder that holds other skills", async () => {
    const group = await skill(path.join(home, ".config", "opencode", "skills"), "group");
    await skill(path.dirname(group), "inner");
    await expect(call("skills.remove", ref(group, "opencode"))).rejects.toThrow("holds other skills");
    expect(trashed).toEqual([]);
  });

  it("moves an added Claude account's linked personal skill itself, which the link would otherwise bring back", async () => {
    const shared = path.join(root, "cli-login");
    const account = path.join(root, "account");
    const installed = path.dirname(await skill(path.join(shared, "skills"), "notes"));
    await mkdir(path.join(account, "skills"), { recursive: true });
    await symlink(installed, path.join(account, "skills", "notes"));
    const env = { CLAUDE_CONFIG_DIR: account, OPENORC_CLAUDE_SHARED_CONFIG_DIR: shared };
    expect(await removalTarget("claude", { path: path.join(account, "skills", "notes", "SKILL.md") }, env)).toBe(installed);
    expect(await removalTarget("claude", { path: path.join(claudeDir, "skills", "own", "SKILL.md") }, env)).toBe(path.join(claudeDir, "skills", "own"));
  });
});
