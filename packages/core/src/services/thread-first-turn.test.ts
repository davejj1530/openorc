import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RunHandle } from "@openorc/agents";
import { Db, LedgerWriter, checkpoints, orchestration, projects, threads } from "@openorc/db";
import { commitAll, git, treeHash } from "@openorc/git";
import { DEFAULT_TEAM_LIMITS, type Project, type Run, type RunSpec, type ThreadCheckpoint } from "@openorc/protocol";
import { FrameCoalescer } from "../frames.js";
import { RunService, type StartRunInput } from "./runs.js";
import { ShellEnvironment } from "./shell-environment.js";
import { ThreadService } from "./threads.js";
import { threadTurnChanges } from "./thread-turn-changes.js";
import { WorkspaceService } from "./workspace.js";
import { WorkspaceWriters } from "./workspace-writers.js";

let root: string;
let dataDir: string;
let db: Db;
let ledger: LedgerWriter;
let service: RunService;
let workspace: WorkspaceService;
let threadService: ThreadService;
let project: Project;
let input: StartRunInput;
let seenAtLaunch: ThreadCheckpoint[][];
const handles = new Map<string, RunHandle>();
const quiet = { info() {}, warn() {}, error() {} };
const start = vi.fn((spec: RunSpec) => {
  seenAtLaunch.push(checkpoints.listForThread(db, input.scope.thread!.id));
  let finish!: (code: number) => void;
  const done = new Promise<number>((resolve) => {
    finish = resolve;
  });
  const handle = new RunHandle(spec.runId, {
    send: async () => {},
    interrupt() {},
    close() {
      handle.emit("exit", 0);
      finish(0);
    },
    done,
  });
  handles.set(spec.runId, handle);
  return handle;
});

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "openorc-first-turn-repo-"));
  dataDir = await mkdtemp(path.join(os.tmpdir(), "openorc-first-turn-data-"));
  await git(root, ["init", "-q", "-b", "main"]);
  await git(root, ["config", "user.name", "Fixture"]);
  await git(root, ["config", "user.email", "fixture@example.com"]);
  db = Db.memory();
  ledger = new LedgerWriter(db);
  project = projects.insert(db, { name: "First turn", rootPath: root, gitRemote: null, defaultBranch: "main", settings: {} });
  const thread = threads.insert(db, { projectId: project.id, title: "Edit the site", agent: "codex", model: "fixture", mode: "act", permissionMode: "trusted" });
  input = { scope: { task: null, thread }, project, agent: "codex", model: "fixture", mode: "act", permissionMode: "trusted", prompt: "Edit the site", resume: false };
  const writers = new WorkspaceWriters();
  const environment = new ShellEnvironment({ env: process.env });
  service = new RunService(
    db,
    ledger,
    new FrameCoalescer(() => {}),
    async () => ({ port: 0, urlForRun: () => "http://fixture.invalid", revoke() {}, async close() {} }),
    () => {},
    quiet,
    { environment: () => environment.current(), brief: () => "", onRunFinished() {}, onThreadTurn() {}, notify() {}, claudeVersion: async () => null },
    { codex: { start }, claude: { start }, opencode: { start } },
    writers,
  );
  workspace = new WorkspaceService(db, { dataDir }, quiet, writers);
  threadService = new ThreadService(
    db,
    service,
    workspace,
    () => {},
    quiet,
    async () => null,
    writers,
  );
  seenAtLaunch = [];
  start.mockClear();
});

afterEach(async () => {
  await service.closeAll();
  await workspace.shutdown();
  ledger.close();
  db.close();
  handles.clear();
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
  await rm(dataDir, { recursive: true, force: true });
});

async function complete(run: Run, status: "success" | "cancelled" = "success") {
  handles.get(run.id)!.emit("event", { type: "turn.completed", runId: run.id, ts: Date.now(), turnId: "first", status, durationMs: 1 });
  await vi.waitFor(() => expect(service.threadActivity(input.scope.thread!.id)).toBe("idle"));
  await service.closeAndWait(run.id);
}

it("saves the dirty starting files before launch and restores them after a cancelled first turn", async () => {
  await writeFile(path.join(root, "README.md"), "committed\n");
  await writeFile(path.join(root, "deleted.txt"), "already deleted before launch\n");
  await commitAll(root, "Initial");
  const head = (await git(root, ["rev-parse", "HEAD"])).stdout.trim();
  await writeFile(path.join(root, "README.md"), "staged\n");
  await git(root, ["add", "README.md"]);
  await writeFile(path.join(root, "README.md"), "staged\nmy unstaged edit\n");
  await rm(path.join(root, "deleted.txt"));
  const binary = Buffer.from([0, 1, 255, 42]);
  await writeFile(path.join(root, "notes.bin"), binary);
  await writeFile(path.join(root, "untouched.txt"), "my notes\n");
  const originalTree = await treeHash(root);
  const staged = (await git(root, ["diff", "--cached", "--binary"])).stdout;
  const run = await service.start(input);
  expect(seenAtLaunch[0]).toHaveLength(1);
  const baseline = seenAtLaunch[0]![0]!;
  expect(baseline).toMatchObject({ turn: 0, runId: null, treeSha: originalTree, root: await realpath(root) });
  expect((await git(root, ["rev-parse", "HEAD"])).stdout.trim()).toBe(head);

  await writeFile(path.join(root, "README.md"), "agent changes\n");
  await rm(path.join(root, "notes.bin"));
  await writeFile(path.join(root, "new.txt"), "agent addition\n");
  await complete(run, "cancelled");
  const saved = checkpoints.listForThread(db, input.scope.thread!.id);
  expect(saved).toHaveLength(2);
  expect(saved[1]).toMatchObject({ turn: 1, runId: run.id });
  const diff = await threadTurnChanges(db, { threadId: input.scope.thread!.id, checkpointId: saved[1]!.id, includePatch: true });
  expect(diff.files.map((file) => file.path).sort()).toEqual(["README.md", "new.txt", "notes.bin"]);
  expect(diff.patch).toContain("-my unstaged edit");

  await git(root, ["gc", "--prune=now"]);
  await threadService.restore(input.scope.thread!.id, baseline.id);
  expect(await treeHash(root)).toBe(originalTree);
  expect(await readFile(path.join(root, "notes.bin"))).toEqual(binary);
  expect((await git(root, ["diff", "--cached", "--binary"])).stdout).toBe(staged);
  // Restoring itself retains the agent's version, so the user's undo is reversible.
  expect(checkpoints.listForThread(db, input.scope.thread!.id).at(-2)?.treeSha).toBe(saved[1]!.treeSha);
});

it("supports the first turn in a repository without a commit", async () => {
  await writeFile(path.join(root, "notes.txt"), "already here\n");
  const originalTree = await treeHash(root);
  const run = await service.start(input);
  const baseline = checkpoints.listForThread(db, input.scope.thread!.id)[0];
  expect(baseline?.treeSha).toBe(originalTree);
  await writeFile(path.join(root, "created.txt"), "new\n");
  await complete(run);
  const saved = checkpoints.listForThread(db, input.scope.thread!.id).at(-1)!;
  expect((await threadTurnChanges(db, { threadId: input.scope.thread!.id, checkpointId: saved.id })).files).toEqual([{ path: "created.txt", added: 1, removed: 0 }]);
  await threadService.restore(input.scope.thread!.id, baseline!.id);
  expect(await treeHash(root)).toBe(originalTree);
});

it("retains one starting checkpoint across a failed launch, retries, and later sessions", async () => {
  await writeFile(path.join(root, "notes.txt"), "starting files\n");
  start.mockImplementationOnce(() => {
    throw new Error("Provider unavailable");
  });
  await expect(service.start(input)).rejects.toThrow("Provider unavailable");
  const baseline = checkpoints.listForThread(db, input.scope.thread!.id)[0]!;
  expect(baseline).toMatchObject({ turn: 0, runId: null });
  const retry = await service.start(input);
  expect(checkpoints.listForThread(db, input.scope.thread!.id)).toEqual([baseline]);
  await writeFile(path.join(root, "notes.txt"), "first turn\n");
  await complete(retry);
  const saved = checkpoints.listForThread(db, input.scope.thread!.id);
  await service.start(input);
  expect(checkpoints.listForThread(db, input.scope.thread!.id)).toEqual(saved);
});

it("does not add a starting checkpoint to an existing legacy history", async () => {
  await writeFile(path.join(root, "notes.txt"), "old first turn\n");
  const legacy = checkpoints.insert(db, { threadId: input.scope.thread!.id, runId: null, turn: 1, treeSha: await treeHash(root), diffStat: { files: 1, insertions: 0, deletions: 0, untracked: 1 } });
  await service.start(input);
  expect(seenAtLaunch[0]).toEqual([legacy]);
  expect(checkpoints.listForThread(db, input.scope.thread!.id)).toEqual([legacy]);
});

it("leaves a first turn with no edits without a change card checkpoint", async () => {
  const run = await service.start(input);
  await complete(run);
  expect(checkpoints.listForThread(db, input.scope.thread!.id)).toEqual([expect.objectContaining({ turn: 0, runId: null })]);
});

it("keeps non-Git conversations usable without creating checkpoints", async () => {
  await rm(path.join(root, ".git"), { recursive: true });
  const run = await service.start(input);
  await complete(run);
  expect(start).toHaveBeenCalledOnce();
  expect(checkpoints.listForThread(db, input.scope.thread!.id)).toEqual([]);
});

it("leaves team starting trees to the team lifecycle", async () => {
  const team = orchestration.save(db, {
    projectId: project.id,
    expectedRevisionId: null,
    draft: {
      name: "Team",
      limits: DEFAULT_TEAM_LIMITS,
      discussion: { ambientRounds: 0, peerFollowUps: 0, mentionOnly: [] },
      members: [{ key: "lead", name: "Lead", managerKey: null, responsibility: "Coordinate", settings: { agent: "codex", model: "fixture", effort: null, fastMode: false } }],
    },
  });
  orchestration.createInstance(db, { threadId: input.scope.thread!.id, teamRevisionId: team.revision.id });
  await service.start(input);
  expect(seenAtLaunch[0]).toEqual([]);
});

it("captures the conversation's worktree instead of the project checkout", async () => {
  await writeFile(path.join(root, "notes.txt"), "committed\n");
  await commitAll(root, "Initial");
  const worktree = path.join(dataDir, "worktree");
  await git(root, ["worktree", "add", "-b", "conversation", worktree]);
  await writeFile(path.join(worktree, "notes.txt"), "worktree edits\n");
  await writeFile(path.join(root, "notes.txt"), "checkout edits\n");
  const thread = threads.update(db, input.scope.thread!.id, { workspaceMode: "worktree", worktreePath: worktree })!;
  input = { ...input, scope: { task: null, thread } };
  await service.start(input);
  expect(seenAtLaunch[0]![0]).toMatchObject({ root: await realpath(worktree), treeSha: await treeHash(worktree) });
  expect(await readFile(path.join(root, "notes.txt"), "utf8")).toBe("checkout edits\n");
});

it("does not launch the provider when the starting checkpoint cannot be saved", async () => {
  const insert = vi.spyOn(checkpoints, "insert").mockImplementationOnce(() => {
    throw new Error("Disk full");
  });
  await expect(service.start(input)).rejects.toThrow("Could not save the starting files for Undo: Disk full");
  expect(start).not.toHaveBeenCalled();
  expect(checkpoints.listForThread(db, input.scope.thread!.id)).toEqual([]);
  insert.mockRestore();
  // Startup failure released its workspace lease and can be retried normally.
  await service.start(input);
  expect(start).toHaveBeenCalledOnce();
});
