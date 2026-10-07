import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RunHandle, type AgentLaunchEnvironment } from "@openorc/agents";
import { Db, LedgerWriter, projects, runs, threads } from "@openorc/db";
import { git } from "@openorc/git";
import type { Project, RunSpec } from "@openorc/protocol";
import { FrameCoalescer } from "../frames.js";
import { ClaudeAccountService } from "./claude-accounts.js";
import { claudeRunAccount } from "./claude-run-account.js";
import { RunService } from "./runs.js";
import { ShellEnvironment } from "./shell-environment.js";
import { ThreadService } from "./threads.js";
import { WorkspaceService } from "./workspace.js";
import { WorkspaceWriters } from "./workspace-writers.js";

let root: string;
let db: Db;
let ledger: LedgerWriter;
let accounts: ClaudeAccountService;
let service: RunService;
let workspace: WorkspaceService;
let conversations: ThreadService;
let project: Project;
const quiet = { info() {}, warn() {}, error() {} };
const start = vi.fn((_spec: RunSpec, _launch: AgentLaunchEnvironment): RunHandle => {
  throw new Error("Fixture not ready");
});

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "openorc-account-runs-"));
  await git(root, ["init", "-q", "-b", "main"]);
  db = Db.memory();
  ledger = new LedgerWriter(db);
  project = projects.insert(db, { name: "Fixture", rootPath: root, gitRemote: null, defaultBranch: "main", settings: {} });
  const writers = new WorkspaceWriters();
  const environment = new ShellEnvironment({ env: process.env });
  accounts = new ClaudeAccountService(
    db,
    root,
    () => environment.current(),
    () => {},
    (id) => service.hasClaudeSessions(id),
  );
  start.mockReset().mockImplementation((spec) => {
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
    return handle;
  });
  service = new RunService(
    db,
    ledger,
    new FrameCoalescer(() => {}),
    async () => ({ port: 0, urlForRun: () => "http://fixture.invalid", revoke() {}, async close() {} }),
    () => {},
    quiet,
    {
      environment: () => environment.current(),
      claudeEnvironment: (snapshot, id) => accounts.environment(snapshot, id),
      claudeAccountFor: (input) => claudeRunAccount(db, input),
      brief: () => "",
      onRunFinished() {},
      onThreadTurn() {},
      notify() {},
      claudeVersion: async () => null,
    },
    { codex: { start }, claude: { start }, opencode: { start } },
    writers,
  );
  workspace = new WorkspaceService(db, { dataDir: root }, quiet, writers);
  conversations = new ThreadService(
    db,
    service,
    workspace,
    () => {},
    quiet,
    async () => null,
    writers,
  );
});
afterEach(async () => {
  await service.closeAll();
  await accounts.close();
  await workspace.shutdown();
  ledger.close();
  db.close();
  await rm(root, { recursive: true, force: true });
});
const input = {
  agent: "claude" as const,
  model: "fixture",
  effort: undefined,
  mode: "plan" as const,
  permissionMode: "review" as const,
  workspaceMode: "current" as const,
  prompt: "Study this",
  attachments: undefined,
  title: undefined,
};

it("launches three accounts independently and keeps the saved account when resuming", async () => {
  const ids = ["Work", "Personal", "Client"].map((name) => accounts.add(name).id);
  const launched = [];
  for (const id of ids) launched.push(await conversations.start({ ...input, projectId: project.id, claudeAccountId: id }));
  expect(start.mock.calls.map(([, env]) => path.basename(env.env.CLAUDE_CONFIG_DIR!))).toEqual(ids);
  expect(launched.map(({ thread, run }) => [thread.claudeAccountId, run.claudeAccountId])).toEqual(ids.map((id) => [id, id]));
  for (const { run } of launched) await service.closeAndWait(run.id);
  const first = launched[0]!;
  runs.update(db, first.run.id, { externalSessionId: "work-session", state: "success" });
  accounts.update({ id: ids[2]!, makeDefault: true });
  const resumed = await conversations.continueThread(first.thread.id, input);
  expect(resumed.claudeAccountId).toBe(ids[0]);
  expect(start.mock.lastCall?.[0].resumeSessionId).toBe("work-session");
  expect(path.basename(start.mock.lastCall![1].env.CLAUDE_CONFIG_DIR!)).toBe(ids[0]);
  expect(threads.get(db, first.thread.id)?.claudeAccountId).toBe(ids[0]);
  await service.closeAndWait(resumed.id);
  accounts.update({ id: ids[0]!, enabled: false });
  const calls = start.mock.calls.length;
  await expect(conversations.continueThread(first.thread.id, input)).rejects.toThrow(/disabled/);
  expect(start).toHaveBeenCalledTimes(calls);
});

it("captures the default on new threads and records the account even if a launch fails", async () => {
  const account = accounts.add("Work");
  accounts.update({ id: account.id, makeDefault: true });
  start.mockImplementationOnce(() => {
    throw new Error("Fixture launch failed");
  });
  await expect(conversations.start({ ...input, projectId: project.id })).rejects.toThrow(/Fixture launch failed/);
  const thread = threads.list(db, { projectId: project.id })[0]!;
  expect(thread.claudeAccountId).toBe(account.id);
  expect(runs.listForThread(db, thread.id)[0]?.claudeAccountId).toBe(account.id);
});

it("retires idle sessions for sign-in while leaving other accounts running", async () => {
  const work = accounts.add("Work");
  const personal = accounts.add("Personal");
  const first = await conversations.start({ ...input, projectId: project.id, claudeAccountId: work.id });
  const handle = start.mock.results[0]!.value;
  await conversations.start({ ...input, projectId: project.id, claudeAccountId: personal.id });
  handle.emit("event", { type: "turn.completed", runId: first.run.id, ts: Date.now(), turnId: "fixture", status: "success", durationMs: 1 });
  await vi.waitFor(() => expect(service.threadActivity(first.thread.id)).toBe("idle"));
  await service.retireIdleClaudeSessions(work.id);
  expect(service.hasClaudeSessions(work.id)).toBe(false);
  expect(service.hasClaudeSessions(personal.id)).toBe(true);
});
