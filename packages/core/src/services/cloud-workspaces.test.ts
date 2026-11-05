import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalSandboxProvider } from "@openorc/cloud";
import { cloudWorkspaces, Db, projects, threads } from "@openorc/db";
import { git } from "@openorc/git";
import type { Project, Thread } from "@openorc/protocol";
import { CloudWorkspaceService, cloudSandboxProviders, LOCAL_LAUNCH_REFUSED } from "./cloud-workspaces.js";
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
  const cloud = new CloudWorkspaceService(db, { providers: [sandboxes] }, quiet);
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
    service.admitCloud(thread.id, "local");
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
    expect(record.mirror).toEqual({
      snapshot: null,
      tree: expect.stringMatching(/^[0-9a-f]{40}$/),
      head: expect.stringMatching(/^[0-9a-f]{40}$/),
      known: [expect.stringMatching(/^[0-9a-f]{40}$/)],
    });
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

describe("a cloud workspace's last pull", () => {
  it("fails when the conversation leaves its sandbox and its session does not come too, and only warns after a turn", async () => {
    const sessions = { send: async () => undefined, keep: async () => Promise.reject(new Error("The session did not come.")) };
    const cloud = new CloudWorkspaceService(db, { providers: [sandboxes], sessions: sessions as never }, quiet);
    const workspaces = new WorkspaceService(db, { dataDir: path.join(directory, "data-leaving"), cloud }, quiet, new WorkspaceWriters());
    try {
      const thread = db.transaction(() => {
        const created = threads.insert(db, { projectId: project.id, title: "Leaving", agent: "claude", model: null, mode: "act", permissionMode: "trusted", workspaceMode: "worktree" });
        workspaces.admitCloud(created.id, "local");
        return created;
      });
      const prepared = await workspaces.prepareThread(thread, project, "HEAD");
      await expect(cloud.sync(prepared, { turnEnded: true })).resolves.toEqual(expect.any(Boolean));
      await expect(cloud.sync(prepared, { turnEnded: true, leaving: true })).rejects.toThrow("The session did not come.");
    } finally {
      await workspaces.shutdown();
    }
  });
});

describe("where cloud conversations run", () => {
  it("puts new conversations on Vercel once it is connected, and on this Mac until then", async () => {
    let access: { token: string; teamId: string; projectId: string } | null = null;
    const cloud = new CloudWorkspaceService(db, cloudSandboxProviders({ dataDir: directory, env: () => process.env, credentials: async () => access }), quiet);
    expect(await cloud.place({ agent: "claude" }, project)).toBe("local");
    access = { token: "tok", teamId: "team", projectId: "proj" };
    expect(await cloud.place({ agent: "claude" }, project)).toBe("vercel");
    await expect(cloud.place({ agent: "codex" }, project)).rejects.toThrow("Codex has no sign-in for the cloud.");
    await expect(cloud.place({ agent: "opencode" }, project)).rejects.toThrow("Only Claude and Codex run in cloud workspaces so far.");
  });

  it("lets a provider passed in take new conversations, whatever is connected", async () => {
    const cloud = new CloudWorkspaceService(
      db,
      cloudSandboxProviders({ dataDir: directory, env: () => process.env, credentials: async () => ({ token: "t", teamId: "t", projectId: "p" }), override: sandboxes }),
      quiet,
    );
    expect(await cloud.place({ agent: "claude" }, project)).toBe("local");
  });

  it("opens a workspace on the service it was made with", async () => {
    const cloud = new CloudWorkspaceService(db, cloudSandboxProviders({ dataDir: directory, env: () => process.env }), quiet);
    const thread = threads.insert(db, { projectId: project.id, title: "On Vercel", agent: "claude", model: null, mode: "act", permissionMode: "trusted", workspaceMode: "worktree" });
    const record = cloud.admit(thread.id, "vercel");
    await expect(cloud.location(record, path.join(directory, "mirror"))).rejects.toThrow("Connect Vercel in Settings to run in the cloud.");
  });
});

describe("a cloud-only host", () => {
  it("has no sandboxes in folders: without a connection, a new conversation goes to Vercel, which asks for one", async () => {
    const options = cloudSandboxProviders({ dataDir: directory, env: () => process.env, credentials: async () => null, cloudOnly: true });
    expect(options.providers.map((provider) => provider.id)).toEqual(["vercel"]);
    const cloud = new CloudWorkspaceService(db, { ...options, cloudOnly: true }, quiet);
    const thread = threads.insert(db, { projectId: project.id, title: "Cloud only", agent: "claude", model: null, mode: "act", permissionMode: "trusted", workspaceMode: "worktree" });
    const record = cloud.admit(thread.id, await cloud.place({ agent: "claude" }, project));
    expect(record.provider).toBe("vercel");
    await expect(cloud.location(record, path.join(directory, "mirror"))).rejects.toThrow("Connect Vercel in Settings to run in the cloud.");
  });

  it("refuses every launch that would run on this machine, with or without a conversation", async () => {
    const run = { agent: "claude" };
    const local = threads.insert(db, { projectId: project.id, title: "Local", agent: "claude", model: null, mode: "act", permissionMode: "trusted" });
    const only = new CloudWorkspaceService(db, { providers: [sandboxes], cloudOnly: true }, quiet);
    await expect(only.host(null, "http://127.0.0.1:1", run)).rejects.toThrow(LOCAL_LAUNCH_REFUSED);
    await expect(only.host(local, "http://127.0.0.1:1", run)).rejects.toThrow(LOCAL_LAUNCH_REFUSED);
    const mac = new CloudWorkspaceService(db, { providers: [sandboxes] }, quiet);
    expect(await mac.host(null, "http://127.0.0.1:1", run)).toBeNull();
    expect(await mac.host(local, "http://127.0.0.1:1", run)).toBeNull();
  });
});

describe("a cloud workspace's busy signal", () => {
  it("reads busy while a new conversation's sandbox is built and held, and idle once it has stopped", async () => {
    const quick = new LocalSandboxProvider(path.join(directory, "quick"), () => process.env, 400);
    const cloud = new CloudWorkspaceService(db, { providers: [quick] }, quiet);
    const workspaces = new WorkspaceService(db, { dataDir: path.join(directory, "quick-data"), cloud }, quiet, new WorkspaceWriters());
    const thread = db.transaction(() => {
      const row = threads.insert(db, { projectId: project.id, title: "Busy", agent: "claude", model: null, mode: "act", permissionMode: "trusted", workspaceMode: "worktree" });
      workspaces.admitCloud(row.id, "local");
      return row;
    });
    expect(cloud.busy).toBe(false);
    const preparing = workspaces.prepareThread(thread, project, "HEAD");
    await vi.waitFor(() => expect(cloud.busy).toBe(true));
    await preparing;
    await vi.waitFor(() => expect(cloud.busy).toBe(false), { timeout: 5_000 });
    await workspaces.shutdown();
    await cloud.close();
  });
});
