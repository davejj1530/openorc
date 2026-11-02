import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalSandboxProvider } from "@openorc/cloud";
import { cloudWorkspaces, Db, projects, threads } from "@openorc/db";
import { git } from "@openorc/git";
import type { Project, Thread } from "@openorc/protocol";
import { CloudWorkspaceService } from "./cloud-workspaces.js";
import { WorkspaceService } from "./workspace.js";
import { WorkspaceWriters } from "./workspace-writers.js";

const quiet = { info() {}, warn() {}, error() {} };

let directory: string;
let root: string;
let db: Db;
let project: Project;
let sandboxes: LocalSandboxProvider;
let service: WorkspaceService;

beforeEach(async () => {
  directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "openorc-cloud-workspace-")));
  root = path.join(directory, "repository");
  await mkdir(root);
  await git(root, ["init", "-q", "-b", "main"]);
  await writeFile(path.join(root, "README.md"), "# Fixture\n");
  await git(root, ["add", "README.md"]);
  await git(root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "-qm", "Fixture"]);
  await git(root, ["remote", "add", "origin", "https://github.com/example/fixture.git"]);
  db = Db.memory();
  project = projects.insert(db, {
    name: "Fixture",
    rootPath: root,
    gitRemote: null,
    defaultBranch: "main",
    settings: { setupScript: 'printf "%s %s\\n" "$OPENORC_CLOUD" "$OPENORC_ROOT_PATH" >> setup-runs.txt', worktreeInclude: [] },
  });
  sandboxes = new LocalSandboxProvider(path.join(directory, "sandboxes"));
  const cloud = new CloudWorkspaceService(db, { provider: sandboxes }, quiet);
  service = new WorkspaceService(db, { dataDir: path.join(directory, "data"), cloud }, quiet, new WorkspaceWriters());
});

afterEach(async () => {
  await service.shutdown();
  db.close();
  await rm(directory, { recursive: true, force: true });
});

function cloudThread(): Thread {
  return db.transaction(() => {
    const thread = threads.insert(db, { projectId: project.id, title: "Cloud work", agent: "claude", model: null, mode: "act", permissionMode: "trusted", workspaceMode: "worktree" });
    service.admitCloud(thread.id);
    return thread;
  });
}

const sandboxRepo = (thread: Thread) => path.join(directory, "sandboxes", `openorc-${thread.id}`, "repo");

describe("cloud workspace preparation", () => {
  it("makes the Mac's worktree, gives the sandbox its branch and runs the setup script only in the sandbox", async () => {
    const prepared = await service.prepareThread(cloudThread(), project, "HEAD");
    const repo = sandboxRepo(prepared);
    expect(prepared.worktreePath).toBeTruthy();
    expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" })).toBe(execFileSync("git", ["rev-parse", "HEAD"], { cwd: prepared.worktreePath!, encoding: "utf8" }));
    expect(execFileSync("git", ["symbolic-ref", "--short", "HEAD"], { cwd: repo, encoding: "utf8" }).trim()).toBe(prepared.branch);
    expect(execFileSync("git", ["remote", "get-url", "origin"], { cwd: repo, encoding: "utf8" }).trim()).toBe("https://github.com/example/fixture.git");
    expect(readFileSync(path.join(repo, "setup-runs.txt"), "utf8")).toBe(`1 ${repo}\n`);
    expect(existsSync(path.join(prepared.worktreePath!, "setup-runs.txt"))).toBe(false);
    const record = cloudWorkspaces.get(db, prepared.id)!;
    expect(record.state).toBe("ready");
    expect(record.mirror).toEqual({ snapshot: null, tree: expect.stringMatching(/^[0-9a-f]{40}$/), known: [expect.stringMatching(/^[0-9a-f]{40}$/)] });
  });

  it("leaves a ready workspace alone when the conversation continues", async () => {
    const prepared = await service.prepareThread(cloudThread(), project, "HEAD");
    const before = cloudWorkspaces.get(db, prepared.id);
    await service.prepareThread(threads.get(db, prepared.id)!, project);
    expect(cloudWorkspaces.get(db, prepared.id)).toEqual(before);
    expect(
      readFileSync(path.join(sandboxRepo(prepared), "setup-runs.txt"), "utf8")
        .split("\n")
        .filter(Boolean),
    ).toHaveLength(1);
  });

  it("records a failed setup and tries again on the next preparation", async () => {
    const failing = { ...project, settings: { ...project.settings, setupScript: "echo 'npm missing' >&2; exit 4" } };
    const thread = cloudThread();
    await expect(service.prepareThread(thread, failing, "HEAD")).rejects.toThrow(/setup script failed in the cloud workspace \(exit 4\)\.\nnpm missing/);
    expect(cloudWorkspaces.get(db, thread.id)).toMatchObject({ state: "failed", error: expect.stringMatching(/npm missing/), mirror: null });

    await service.prepareThread(threads.get(db, thread.id)!, { ...project, settings: { ...project.settings, setupScript: "touch fixed.txt" } });
    expect(cloudWorkspaces.get(db, thread.id)).toMatchObject({ state: "ready", error: null });
    expect(existsSync(path.join(sandboxRepo(thread), "fixed.txt"))).toBe(true);
  });

  it("runs a project without a cloud workspace on the Mac as before", async () => {
    const local = threads.insert(db, { projectId: project.id, title: "Local work", agent: "claude", model: null, mode: "act", permissionMode: "trusted", workspaceMode: "worktree" });
    const prepared = await service.prepareThread(local, project, "HEAD");
    expect(readFileSync(path.join(prepared.worktreePath!, "setup-runs.txt"), "utf8")).toBe(` ${root}\n`);
    expect(existsSync(path.join(directory, "sandboxes", `openorc-${prepared.id}`))).toBe(false);
    expect(cloudWorkspaces.get(db, prepared.id)).toBeNull();
  });
});
