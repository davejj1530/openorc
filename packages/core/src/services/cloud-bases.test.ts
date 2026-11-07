import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalSandboxProvider, runnerFiles, type SandboxProvider } from "@openorc/cloud";
import { cloudWorkspaces, Db, projects, settings, threads } from "@openorc/db";
import { git } from "@openorc/git";
import type { Project, Thread } from "@openorc/protocol";
import { CloudBases, setupInputsChanged } from "./cloud-bases.js";
import { CloudWorkspaceService } from "./cloud-workspaces.js";
import { WorkspaceService } from "./workspace.js";
import { WorkspaceWriters } from "./workspace-writers.js";

const IDENTITY = ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com"];
/** Installs into a folder Git ignores and counts its runs there, as a dependency install does. */
const SETUP = "mkdir -p node_modules/dep && echo installed > node_modules/dep/index.js && echo run >> node_modules/.setup-runs";

let directory: string;
let root: string;
let db: Db;
let project: Project;
let sandboxes: LocalSandboxProvider;
let bases: CloudBases;
let service: WorkspaceService;
let cloud: CloudWorkspaceService;
let lines: string[];

const commit = async (file: string, content: string) => {
  await writeFile(path.join(root, file), content);
  await git(root, ["add", file]);
  await git(root, [...IDENTITY, "commit", "-qm", file]);
  return (await git(root, ["rev-parse", "HEAD"])).stdout.trim();
};

beforeEach(async () => {
  directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "openorc-cloud-bases-")));
  root = path.join(directory, "repository");
  await mkdir(root);
  await git(root, ["init", "-q", "-b", "main"]);
  await writeFile(path.join(root, ".gitignore"), "node_modules/\n");
  await git(root, ["add", ".gitignore"]);
  await commit("package.json", '{ "name": "fixture" }\n');
  db = Db.memory();
  project = projects.insert(db, { name: "Fixture", rootPath: root, gitRemote: null, defaultBranch: "main", settings: { setupScript: SETUP, worktreeInclude: [] } });
  // A sandbox on this Mac runs the Mac's own CLIs: a stand-in, so no real one is needed.
  const bin = path.join(directory, "bin");
  await mkdir(bin);
  await writeFile(path.join(bin, "claude"), "#!/bin/sh\necho '2.1.300 (Claude Code)'\n", { mode: 0o755 });
  sandboxes = new LocalSandboxProvider(path.join(directory, "sandboxes"), () => ({ ...process.env, PATH: `${bin}:${process.env["PATH"] ?? ""}` }));
  lines = [];
  const log = { info: (text: string) => void lines.push(text), warn: (text: string) => void lines.push(`warn: ${text}`), error() {} };
  bases = new CloudBases({ db, provider: () => sandboxes, files: runnerFiles, projectEnv: async () => ({}), log });
  cloud = new CloudWorkspaceService(db, { providers: [sandboxes], bases }, log);
  service = new WorkspaceService(db, { dataDir: path.join(directory, "data"), cloud }, log, new WorkspaceWriters());
});

afterEach(async () => {
  await bases.settled();
  await service.shutdown();
  db.close();
  await rm(directory, { recursive: true, force: true });
});

async function started(): Promise<Thread> {
  const thread = db.transaction(() => {
    const inserted = threads.insert(db, { projectId: project.id, title: "Cloud work", agent: "claude", model: null, mode: "act", permissionMode: "trusted", workspaceMode: "worktree" });
    service.admitCloud(inserted.id, "local");
    return inserted;
  });
  return service.prepareThread(thread, project, "HEAD");
}

const repo = (thread: Thread) => path.join(directory, "sandboxes", cloudWorkspaces.get(db, thread.id)!.sandbox, "repo");
const runs = (thread: Thread) =>
  readFileSync(path.join(repo(thread), "node_modules", ".setup-runs"), "utf8")
    .split("\n")
    .filter(Boolean).length;
const head = (thread: Thread) => execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo(thread), encoding: "utf8" }).trim();
const branchOf = (thread: Thread) => execFileSync("git", ["symbolic-ref", "--short", "HEAD"], { cwd: repo(thread), encoding: "utf8" }).trim();
const status = (thread: Thread) => execFileSync("git", ["status", "--porcelain"], { cwd: repo(thread), encoding: "utf8" }).trim();
const stored = () => Object.values(JSON.parse(settings.get(db, "cloud.bases") ?? "{}") as Record<string, { image: string; commit: string; retired?: unknown[] }>);

describe("a project's cloud base", () => {
  it("is made after its first cloud conversation, which starts the ordinary way, and the next starts from it without running the setup again", async () => {
    const first = await started();
    expect(runs(first)).toBe(1);
    await bases.settled();
    const [base] = stored();
    expect(base).toMatchObject({ commit: (await git(root, ["rev-parse", "main"])).stdout.trim() });
    expect(lines.some((line) => line.startsWith("cloud base of project Fixture on local made"))).toBe(true);

    const second = await started();
    expect(lines.some((line) => /opened from its project's base/.test(line))).toBe(true);
    expect(readFileSync(path.join(repo(second), "node_modules", "dep", "index.js"), "utf8")).toBe("installed\n");
    // The base's run, copied with it; none of its own.
    expect(runs(second)).toBe(1);
    expect(branchOf(second)).toBe(second.branch);
    expect(head(second)).toBe(execFileSync("git", ["rev-parse", "HEAD"], { cwd: second.worktreePath!, encoding: "utf8" }).trim());
    expect(status(second)).toBe("");
  });

  it("brings a conversation started after new commits to them, running the setup again only when what it installs from changed", async () => {
    await started();
    await bases.settled();
    await commit("README.md", "# Docs only\n");
    const docs = await started();
    expect(head(docs)).toBe((await git(root, ["rev-parse", "main"])).stdout.trim());
    expect(readFileSync(path.join(repo(docs), "README.md"), "utf8")).toBe("# Docs only\n");
    expect(runs(docs)).toBe(1);

    await commit("package.json", '{ "name": "fixture", "dependencies": { "left-pad": "1.3.0" } }\n');
    const dependency = await started();
    expect(runs(dependency)).toBe(2);
  });

  it("is made again when its setup inputs change, the old one kept a while for sandboxes still starting from it", async () => {
    await started();
    await bases.settled();
    const [first] = stored();
    await commit("package.json", '{ "name": "fixture", "version": "2.0.0" }\n');
    await started();
    await bases.settled();
    const [second] = stored();
    expect(second!.image).not.toBe(first!.image);
    expect(second!.retired).toEqual([{ image: first!.image, at: expect.any(Number) }]);
    expect(await readdir(path.join(directory, "sandboxes", ".bases"))).toEqual(expect.arrayContaining([first!.image, second!.image]));
  });

  it("is forgotten when its service no longer has it, and the conversation starts the ordinary way", async () => {
    await started();
    await bases.settled();
    const [base] = stored();
    await rm(path.join(directory, "sandboxes", ".bases", base!.image), { recursive: true, force: true });
    const thread = await started();
    expect(runs(thread)).toBe(1);
    expect(lines.some((line) => line.includes("could not start from its project's base, so it starts empty"))).toBe(true);
    await bases.settled();
    expect(stored()[0]!.image).not.toBe(base!.image);
  });

  it("is kept out of the list of cloud conversations' sandboxes", async () => {
    await started();
    await bases.settled();
    expect((await sandboxes.list()).map((each) => each.name).filter((name) => !name.startsWith("openorc-"))).toEqual([]);
    expect(existsSync(path.join(directory, "sandboxes", ".bases"))).toBe(true);
    expect((await sandboxes.list()).every((each) => !each.name.startsWith("openorc-base-"))).toBe(true);
  });
});

describe("a project with a lockfile and no setup script", () => {
  it("installs its dependencies while its first cloud conversation starts, and once more only in its base", async () => {
    // Takes a moment, as an install does, and counts its runs where the checkout keeps them.
    const pnpm = '#!/bin/sh\nif [ "$1" = install ]; then sleep 1; mkdir -p node_modules; echo run >> node_modules/.installs; fi\n';
    await writeFile(path.join(directory, "bin", "pnpm"), pnpm, { mode: 0o755 });
    await commit("pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
    project = projects.updateSettings(db, project.id, { setupScript: null });
    const installs = (thread: Thread) =>
      readFileSync(path.join(repo(thread), "node_modules", ".installs"), "utf8")
        .split("\n")
        .filter(Boolean).length;
    const installed = (thread: Thread) => vi.waitFor(() => expect(existsSync(path.join(repo(thread), "..", ".openorc", "deps.exit"))).toBe(true), { timeout: 10_000 });

    const first = await started();
    expect(existsSync(path.join(repo(first), "node_modules", ".installs"))).toBe(false);
    await installed(first);
    expect(installs(first)).toBe(1);

    await bases.settled();
    const second = await started();
    expect(lines.some((line) => /opened from its project's base/.test(line))).toBe(true);
    expect(installs(second)).toBe(1);
  });
});

describe("what a project's setup installs from", () => {
  it("changed when a manifest or lockfile did, anywhere in the tree, and not for other files", async () => {
    const before = (await git(root, ["rev-parse", "HEAD"])).stdout.trim();
    const docs = await commit("README.md", "# Docs\n");
    expect(await setupInputsChanged(root, before, docs)).toBe(false);
    await mkdir(path.join(root, "packages", "app"), { recursive: true });
    const nested = await commit("packages/app/package.json", "{}\n");
    expect(await setupInputsChanged(root, docs, nested)).toBe(true);
    expect(await setupInputsChanged(root, before, "0".repeat(40))).toBe(true);
    expect(await setupInputsChanged(root, docs, docs)).toBe(false);
  });
});

describe("a sandbox made ahead", () => {
  const madeAhead = () => /cloud sandbox (\S+) being made ahead/.exec(lines.find((line) => line.includes("being made ahead")) ?? "")?.[1];
  const connected = (name: string) => lines.some((line) => line === `cloud workspace ${name} connected`);

  it("is taken by the next cloud conversation in its project, open from its base with its agent and connected", async () => {
    await started();
    await bases.settled();
    lines.length = 0;
    await cloud.warm(project, "claude");
    const name = madeAhead()!;
    await vi.waitFor(() => expect(connected(name)).toBe(true), { timeout: 10_000 });
    const thread = await started();
    expect(cloudWorkspaces.get(db, thread.id)!.sandbox).toBe(name);
    expect(lines.some((line) => line.startsWith(`cloud workspace ${name} opened from its project's base`))).toBe(true);
    // Opened once, ahead: the conversation opened nothing of its own.
    expect(lines.filter((line) => / opened( |$)/.test(line))).toHaveLength(1);
    expect(runs(thread)).toBe(1);
    expect(branchOf(thread)).toBe(thread.branch);
    expect(JSON.parse(settings.get(db, "cloud.warm") ?? "[]")).toEqual([]);
  });

  it("on a service that keeps no bases, holds the branch's commit alone, and the conversation that takes it gets the whole history after", async () => {
    const plain: SandboxProvider = { id: "local", open: (name, needs) => sandboxes.open(name, needs), remove: (name) => sandboxes.remove(name), list: () => sandboxes.list() };
    const log = { info: (text: string) => void lines.push(text), warn: (text: string) => void lines.push(`warn: ${text}`), error() {} };
    const noBases = new CloudBases({ db, provider: () => plain, files: runnerFiles, projectEnv: async () => ({}), log });
    cloud = new CloudWorkspaceService(db, { providers: [plain], bases: noBases }, log);
    await service.shutdown();
    service = new WorkspaceService(db, { dataDir: path.join(directory, "data-plain"), cloud }, log, new WorkspaceWriters());
    await cloud.warm(project, "claude");
    const name = madeAhead()!;
    await vi.waitFor(() => expect(connected(name)).toBe(true), { timeout: 10_000 });
    const later = await commit("later.txt", "after the warm-up\n");

    const thread = await started();
    expect(cloudWorkspaces.get(db, thread.id)!.sandbox).toBe(name);
    expect(head(thread)).toBe(later);
    expect(status(thread)).toBe("");
    expect(runs(thread)).toBe(1);
    await vi.waitFor(() => expect(lines.some((line) => line.startsWith(`cloud workspace ${name} got its history`))).toBe(true), { timeout: 10_000 });
    const count = (cwd: string) => execFileSync("git", ["rev-list", "--count", later], { cwd, encoding: "utf8" }).trim();
    expect(count(repo(thread))).toBe(count(root));
    expect(execFileSync("git", ["rev-parse", "--is-shallow-repository"], { cwd: repo(thread), encoding: "utf8" }).trim()).toBe("false");
  });

  it("is one per project while typing goes on, and is deleted when OpenOrc closes without a conversation taking it", async () => {
    await cloud.warm(project, "claude");
    await cloud.warm(project, "claude");
    const name = madeAhead()!;
    expect(lines.filter((line) => line.includes("being made ahead"))).toHaveLength(1);
    await vi.waitFor(() => expect(connected(name)).toBe(true), { timeout: 10_000 });
    await cloud.close();
    expect(existsSync(path.join(directory, "sandboxes", name))).toBe(false);
    expect(JSON.parse(settings.get(db, "cloud.warm") ?? "[]")).toEqual([]);
  });

  it("left from before OpenOrc last closed is deleted when the next is made", async () => {
    const left = (await sandboxes.open("openorc-left-from-before")).name;
    settings.set(db, "cloud.warm", JSON.stringify([{ name: left, provider: "local" }]));
    await cloud.warm(project, "claude");
    await vi.waitFor(() => expect(existsSync(path.join(directory, "sandboxes", left))).toBe(false), { timeout: 10_000 });
    expect(JSON.parse(settings.get(db, "cloud.warm") ?? "[]")).toEqual([{ name: madeAhead(), provider: "local" }]);
  });
});
