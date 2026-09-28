import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db, threads, projects, runs } from "@openorc/db";
import { WORKSPACE_ID, type RunSpec } from "@openorc/protocol";
import { CodexAdapter, RunHandle } from "@openorc/agents";
import { OpenOrc } from "../openorc.js";
import { configureWorkspace, directory, ensureWorkspaceHome, workspaceHome } from "./workspace-home.js";
import { folderCatalog } from "./slack/folders.js";
const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function temp() {
  const dir = await mkdtemp(join(tmpdir(), "workspace-home-"));
  dirs.push(dir);
  return await directory(dir);
}
it("persists a distinct home and entrypoint, validates folders and discovers unregistered directories without traversing symlinks", async () => {
  const root = await temp(),
    outside = await temp();
  await mkdir(join(root, "demo-app"));
  await mkdir(join(root, ".private"));
  await mkdir(join(root, "node_modules"));
  await symlink(outside, join(root, "escape"));
  await writeFile(join(root, "file"), "hello");
  const db = Db.open(join(outside, "test.sqlite"));
  await ensureWorkspaceHome(db, outside);
  await configureWorkspace(db, root);
  const home = workspaceHome(db);
  expect(home.id).toBe(WORKSPACE_ID);
  const catalog = await folderCatalog(home, []);
  expect(catalog.map((p) => p.name)).toEqual(["Workspace", "demo-app"]);
  await expect(configureWorkspace(db, "relative/path")).rejects.toThrow("absolute");
  await expect(configureWorkspace(db, join(root, "file"))).rejects.toThrow("folder");
  const row = threads.insert(db, { projectId: WORKSPACE_ID, title: "Workspace chat", agent: "codex", model: null, mode: "act", permissionMode: "review" });
  threads.update(db, row.id, { workingDirectory: join(root, "demo-app") });
  const project = projects.insert(db, { name: "Imported", rootPath: join(root, "demo-app"), gitRemote: null, defaultBranch: null, settings: {} });
  threads.insert(db, { projectId: project.id, title: "Project thread", agent: "codex", model: null, mode: "act", permissionMode: "review" });
  expect(threads.list(db, { projectsOnly: true, limit: 1 }).map((t) => t.title)).toEqual(["Project thread"]);
  db.close();
  const reopened = Db.open(join(outside, "test.sqlite"));
  expect(workspaceHome(reopened).rootPath).toBe(root);
  expect(threads.get(reopened, row.id)?.workingDirectory).toBe(join(root, "demo-app"));
  reopened.close();
});
it("executes non-Git folders, retains one home through folder switches and never reuses a session from another folder", async () => {
  const root = await temp(),
    first = join(root, "one"),
    second = join(root, "two");
  await mkdir(first);
  await mkdir(second);
  const starts: { spec: RunSpec; handle: RunHandle }[] = [];
  vi.spyOn(CodexAdapter.prototype, "start").mockImplementation((spec) => {
    let finish!: (code: number) => void;
    const done = new Promise<number>((r) => {
      finish = r;
    });
    const handle = new RunHandle(spec.runId, {
      send: async () => {},
      interrupt() {},
      close() {
        finish(0);
      },
      done,
    });
    starts.push({ spec, handle });
    setTimeout(() => handle.emit("event", { type: "session.started", runId: spec.runId, ts: Date.now(), agent: "codex", externalSessionId: spec.runId, model: "fixture" }), 0);
    return handle;
  });
  const core = await OpenOrc.create({ dataDir: join(root, "data"), ephemeral: true, transport: { push() {} } });
  vi.spyOn(core.memory, "onRunFinished").mockImplementation(() => {});
  vi.spyOn(core.textGeneration, "title").mockResolvedValue(null);
  try {
    await configureWorkspace(core.db, first);
    const input = { agent: "codex" as const, model: "fixture", effort: undefined, mode: "act" as const, permissionMode: "review" as const, prompt: "Explain this folder", attachments: undefined };
    const { thread, run } = await core.threads.start({ ...input, projectId: WORKSPACE_ID, title: undefined });
    expect(core.projects.list()).toHaveLength(0);
    expect(starts[0]!.spec.cwd).toBe(first);
    expect(thread.workingDirectory).toBe(first);
    await vi.waitFor(() => expect(core.runs.threadSession(thread.id).status).toBe("live"));
    starts[0]!.handle.emit("event", { type: "message.completed", runId: run.id, ts: Date.now(), messageId: "reply", role: "assistant", text: "First folder contains a readme." });
    starts[0]!.handle.emit("event", { type: "turn.completed", runId: run.id, ts: Date.now(), turnId: "turn", status: "success", durationMs: 1 });
    await vi.waitFor(() => expect(core.threads.get(thread.id)?.activity).toBe("idle"));
    await configureWorkspace(core.db, second);
    // Default changes never silently move an existing conversation.
    expect(core.threads.get(thread.id)?.workingDirectory).toBe(first);
    await core.threads.continueThread(thread.id, { ...input, workingDirectory: second });
    expect(starts[1]!.spec.cwd).toBe(second);
    expect(starts[1]!.spec.resumeSessionId).toBeUndefined();
    expect(starts[1]!.spec.systemPromptAppendix).toContain("First folder contains a readme");
    expect(core.threads.list({ projectId: WORKSPACE_ID })).toHaveLength(1);
    expect(core.threads.get(thread.id)?.projectId).toBe(WORKSPACE_ID);
    expect(runs.get(core.db, run.id)?.workingDirectory).toBe(first);
    expect(runs.get(core.db, starts[1]!.spec.runId)?.workingDirectory).toBe(second);
    await expect(core.threads.moveWorkspace(thread.id, "worktree")).rejects.toThrow("Workspace");
  } finally {
    await core.close();
  }
});
