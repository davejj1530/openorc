import { claudeConfigDir, RunHandle, type AgentLaunchEnvironment } from "@openorc/agents";
import { claudeAccounts, Db, LedgerWriter, projects, runs, tasks, threads } from "@openorc/db";
import { git } from "@openorc/git";
import { DEFAULT_CLAUDE_ACCOUNT, type AllowanceWindow, type Project, type ProviderUsage, type RunSpec } from "@openorc/protocol";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FrameCoalescer } from "../frames.js";
import { ClaudeAccountSwitch } from "./claude-account-switch.js";
import { ClaudeAccountService } from "./claude-accounts.js";
import { claudeRunAccount } from "./claude-run-account.js";
import type { RunHooks } from "./run-types.js";
import { RunService } from "./runs.js";
import { ShellEnvironment } from "./shell-environment.js";
import { ThreadService } from "./threads.js";
import { WorkspaceWriters } from "./workspace-writers.js";
import { WorkspaceService } from "./workspace.js";

let root: string;
let db: Db;
let ledger: LedgerWriter;
let accounts: ClaudeAccountService;
let service: RunService;
let workspace: WorkspaceService;
let conversations: ThreadService;
let project: Project;
let folder: (accountId: string) => string;
let turnSettled: RunHooks["onTurnSettled"];
const quiet = { info() {}, warn() {}, error() {} };
const start = vi.fn((_spec: RunSpec, _launch: AgentLaunchEnvironment): RunHandle => {
  throw new Error("Fixture not ready");
});

beforeEach(async () => {
  turnSettled = undefined;
  root = await mkdtemp(path.join(os.tmpdir(), "openorc-account-runs-"));
  await git(root, ["init", "-q", "-b", "main"]);
  db = Db.memory();
  ledger = new LedgerWriter(db);
  project = projects.insert(db, { name: "Fixture", rootPath: root, gitRemote: null, defaultBranch: "main", settings: {} });
  const writers = new WorkspaceWriters();
  const environment = new ShellEnvironment({ env: process.env });
  folder = (id) => claudeConfigDir(undefined, accounts.environment(environment.current(), id).env);
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
      onTurnSettled: (...args) => turnSettled?.(...args),
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
    undefined,
    folder,
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
  expect(launched.map(({ thread, run }) => [thread.claudeAccountId, run!.claudeAccountId])).toEqual(ids.map((id) => [id, id]));
  for (const { run } of launched) await service.closeAndWait(run!.id);
  const first = launched[0]!;
  runs.update(db, first.run!.id, { externalSessionId: "work-session", state: "success" });
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

it("goes on with another account by carrying the conversation's session there, or hands off without it", async () => {
  const [work, personal] = ["Work", "Personal"].map((name) => accounts.add(name).id) as [string, string];
  const { thread, run } = await conversations.start({ ...input, projectId: project.id, claudeAccountId: work });
  await service.closeAndWait(run!.id);
  runs.update(db, run!.id, { externalSessionId: "work-session", state: "error", error: "You've hit your 5-hour limit" });
  const sessions = path.join(folder(work), "projects", "-fixture");
  await mkdir(sessions, { recursive: true });
  await writeFile(path.join(sessions, "work-session.jsonl"), '{"type":"user"}\n');

  const moved = await conversations.continueThread(thread.id, { ...input, prompt: "Continue where you left off.", claudeAccountId: personal });
  const [spec, launch] = start.mock.lastCall!;
  expect([spec.resumeSessionId, spec.forkSession, path.basename(launch.env.CLAUDE_CONFIG_DIR!)]).toEqual(["work-session", true, personal]);
  expect(spec.systemPromptAppendix ?? "").not.toContain("Handoff:");
  expect(await readFile(path.join(folder(personal), "projects", "-fixture", "work-session.jsonl"), "utf8")).toBe('{"type":"user"}\n');
  expect([moved.claudeAccountId, threads.get(db, thread.id)?.claudeAccountId]).toEqual([personal, personal]);

  await service.closeAndWait(moved.id);
  runs.update(db, moved.id, { externalSessionId: "personal-session", state: "success" });
  const back = await conversations.continueThread(thread.id, { ...input, claudeAccountId: work });
  const [fresh] = start.mock.lastCall!;
  expect([back.claudeAccountId, fresh.resumeSessionId]).toEqual([work, undefined]);
  expect(fresh.systemPromptAppendix).toContain("Handoff:");
});

it("switches a conversation's account between turns, and its next message resumes the newest session wherever it ran", async () => {
  const [work, personal] = ["Work", "Personal"].map((name) => accounts.add(name).id) as [string, string];
  const { thread, run } = await conversations.start({ ...input, projectId: project.id, claudeAccountId: work });
  runs.update(db, run!.id, { externalSessionId: "work-session" });
  await expect(conversations.switchClaudeAccount(thread.id, personal)).rejects.toThrow(/Wait for the current turn/);
  start.mock.results[0]!.value.emit("event", { type: "turn.completed", runId: run!.id, ts: Date.now(), turnId: "fixture", status: "success", durationMs: 1 });
  await vi.waitFor(() => expect(service.threadActivity(thread.id)).toBe("idle"));
  const sessionFile = async (account: string, id: string) => {
    const sessions = path.join(folder(account), "projects", "-fixture");
    await mkdir(sessions, { recursive: true });
    await writeFile(path.join(sessions, `${id}.jsonl`), `{"session":"${id}"}\n`);
  };
  await sessionFile(work, "work-session");

  const switched = await conversations.switchClaudeAccount(thread.id, personal);
  expect([switched.claudeAccountId, service.liveRunForThread(thread.id)]).toEqual([personal, null]);
  const moved = await conversations.continueThread(thread.id, input);
  const [spec, launch] = start.mock.lastCall!;
  expect([moved.claudeAccountId, spec.resumeSessionId, spec.forkSession, path.basename(launch.env.CLAUDE_CONFIG_DIR!)]).toEqual([personal, "work-session", true, personal]);
  expect(await readFile(path.join(folder(personal), "projects", "-fixture", "work-session.jsonl"), "utf8")).toBe('{"session":"work-session"}\n');

  // Back on the first account, the conversation goes on from what it said on the second, not the older session there.
  await service.closeAndWait(moved.id);
  runs.update(db, moved.id, { externalSessionId: "personal-session", state: "success" });
  await sessionFile(personal, "personal-session");
  await conversations.switchClaudeAccount(thread.id, work);
  await conversations.continueThread(thread.id, input);
  const [back, backLaunch] = start.mock.lastCall!;
  expect([back.resumeSessionId, back.forkSession, path.basename(backLaunch.env.CLAUDE_CONFIG_DIR!)]).toEqual(["personal-session", true, work]);
  expect(back.systemPromptAppendix ?? "").not.toContain("Handoff:");
});

it("shows a turn stopped by the usage limit as failed while its process is still open, until the conversation leaves that account", async () => {
  const [work, personal] = ["Work", "Personal"].map((name) => accounts.add(name).id) as [string, string];
  const { thread, run } = await conversations.start({ ...input, projectId: project.id, claudeAccountId: work });
  const handle = start.mock.results[0]!.value;
  const ts = Date.now();
  handle.emit("event", { type: "activity.updated", runId: run!.id, ts, activityId: "rate-limit", label: "Rate limit reached", status: "error", recovery: { kind: "usage", provider: "claude" } });
  handle.emit("event", { type: "turn.completed", runId: run!.id, ts, turnId: "fixture", status: "error", resultText: "You've hit your 5-hour limit", durationMs: 1 });
  await vi.waitFor(() => expect(service.threadActivity(thread.id)).toBe("idle"));
  ledger.flush();
  expect(service.liveRunForThread(thread.id)?.id).toBe(run!.id);
  expect(service.threadSession(thread.id)).toEqual({ status: "error", message: "You've hit your 5-hour limit", recovery: { kind: "usage", provider: "claude" } });
  await conversations.switchClaudeAccount(thread.id, personal);
  expect([runs.get(db, run!.id)?.state, service.threadSession(thread.id).status]).toEqual(["error", "idle"]);
});

/** The Claude Code login every Mac starts with, signed out in these fixtures. */
const signedOut = (): ProviderUsage => ({ ...fiveHourReport(0), status: "disconnected", windows: [] });

function fiveHourReport(fiveHourUsed: number, weekUsed = 10, observedAt = Date.now()): ProviderUsage {
  const window = (id: string, label: string, usedPercent: number): AllowanceWindow => ({
    id,
    label,
    usedPercent,
    remainingPercent: 100 - usedPercent,
    resetsAt: null,
    observedAt,
    exhausted: usedPercent >= 100,
  });
  return {
    provider: "claude",
    status: "available",
    source: "fixture",
    context: "fixture",
    plan: "Max",
    checkedAt: observedAt,
    refreshedAt: observedAt,
    message: null,
    windows: [window("five_hour", "5-hour window", fiveHourUsed), window("seven_day", "7-day window", weekUsed)],
    credits: [],
    accountUrl: "",
    localRuns: null,
  };
}

it("moves a conversation stopped at its usage limit to the enabled account with the most 5-hour usage left, carrying its session", async () => {
  const [work, personal, client, spare, off] = ["Work", "Personal", "Client", "Spare", "Off"].map((name) => accounts.add(name).id) as [string, string, string, string, string];
  accounts.update({ id: off, enabled: false });
  // Spare has the most 5-hour usage left but none of its week; Off has more still, but it is disabled.
  const reports: Record<string, ProviderUsage> = { [personal]: fiveHourReport(70), [client]: fiveHourReport(40), [spare]: fiveHourReport(0, 100), [off]: fiveHourReport(0) };
  const recent = vi.fn(async (_provider: string, id: string | undefined) => reports[id!] ?? signedOut());
  let enabled = true;
  const switcher = new ClaudeAccountSwitch({ db, settings: { get: () => ({ claudeAccountAutoSwitch: enabled }) }, usage: { recent }, runs: service, threads: conversations, log: quiet });
  turnSettled = (run, scope, _project, outcome) => switcher.settled(run, scope, outcome);

  const { thread, run } = await conversations.start({ ...input, projectId: project.id, claudeAccountId: work });
  runs.update(db, run!.id, { externalSessionId: "work-session" });
  const sessions = path.join(folder(work), "projects", "-fixture");
  await mkdir(sessions, { recursive: true });
  await writeFile(path.join(sessions, "work-session.jsonl"), '{"type":"user"}\n');
  const limit = (handle: RunHandle, runId: string) => {
    const ts = Date.now();
    handle.emit("event", { type: "activity.updated", runId, ts, activityId: "rate-limit", label: "Rate limit reached", status: "error", recovery: { kind: "usage", provider: "claude" } });
    handle.emit("event", { type: "turn.completed", runId, ts, turnId: "fixture", status: "error", resultText: "You've hit your 5-hour limit", durationMs: 1 });
  };
  limit(start.mock.results[0]!.value, run!.id);

  await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(2));
  const [spec, launch] = start.mock.lastCall!;
  expect([spec.resumeSessionId, spec.forkSession, path.basename(launch.env.CLAUDE_CONFIG_DIR!)]).toEqual(["work-session", true, client]);
  expect(spec.prompt.split("\n")[0]).toBe("Moved to the Claude account Client after Work reached its usage limit. Continue where you left off.");
  expect(threads.get(db, thread.id)?.claudeAccountId).toBe(client);
  expect(recent.mock.calls.map(([, id]) => id).sort()).toEqual([DEFAULT_CLAUDE_ACCOUNT, client, personal, spare].sort());

  // With the setting off, the next limit leaves the conversation where it stopped.
  enabled = false;
  const moved = service.liveRunForThread(thread.id)!;
  limit(start.mock.results[1]!.value, moved.id);
  await vi.waitFor(() => expect(service.threadSession(thread.id).recovery?.kind).toBe("usage"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect([start.mock.calls.length, threads.get(db, thread.id)?.claudeAccountId]).toEqual([2, client]);
});

it("leaves a stopped conversation alone when no account has 5-hour usage left, or the person moved it while usage was read", async () => {
  const [work, personal, client] = ["Work", "Personal", "Client"].map((name) => accounts.add(name).id) as [string, string, string];
  const reports: Record<string, ProviderUsage> = { [personal]: fiveHourReport(100), [client]: fiveHourReport(30, 10, Date.now() - 10 * 60_000) };
  let read!: () => void;
  const answered = new Promise<void>((resolve) => {
    read = resolve;
  });
  const recent = vi.fn(async (_provider: string, id: string | undefined) => {
    await answered;
    return reports[id!] ?? signedOut();
  });
  const switcher = new ClaudeAccountSwitch({ db, settings: { get: () => ({ claudeAccountAutoSwitch: true }) }, usage: { recent }, runs: service, threads: conversations, log: quiet });
  turnSettled = (run, scope, _project, outcome) => switcher.settled(run, scope, outcome);
  const { thread, run } = await conversations.start({ ...input, projectId: project.id, claudeAccountId: work });
  const ts = Date.now();
  const handle = start.mock.results[0]!.value;
  handle.emit("event", { type: "activity.updated", runId: run!.id, ts, activityId: "rate-limit", label: "Rate limit reached", status: "error", recovery: { kind: "usage", provider: "claude" } });
  handle.emit("event", { type: "turn.completed", runId: run!.id, ts, turnId: "fixture", status: "error", resultText: "You've hit your 5-hour limit", durationMs: 1 });
  await vi.waitFor(() => expect(recent).toHaveBeenCalledTimes(3));

  // Personal's 5-hour window is used up and Client's report is ten minutes old, so neither is a place to go.
  read();
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect([start.mock.calls.length, threads.get(db, thread.id)?.claudeAccountId]).toEqual([1, work]);

  // A fresh report would choose Client, but the person moved the conversation to Personal first.
  reports[client] = fiveHourReport(30);
  const again = new ClaudeAccountSwitch({
    db,
    settings: { get: () => ({ claudeAccountAutoSwitch: true }) },
    usage: { recent: async (_provider, id) => (await conversations.switchClaudeAccount(thread.id, personal), reports[id!] ?? signedOut()) },
    runs: service,
    threads: conversations,
    log: quiet,
  });
  again.settled(runs.get(db, run!.id)!, { task: null, thread: threads.get(db, thread.id)! }, { status: "error", snapshotId: null, error: "You've hit your 5-hour limit" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect([start.mock.calls.length, threads.get(db, thread.id)?.claudeAccountId]).toEqual([1, personal]);
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
  handle.emit("event", { type: "turn.completed", runId: first.run!.id, ts: Date.now(), turnId: "fixture", status: "success", durationMs: 1 });
  await vi.waitFor(() => expect(service.threadActivity(first.thread.id)).toBe("idle"));
  await service.retireIdleClaudeSessions(work.id);
  expect(service.hasClaudeSessions(work.id)).toBe(false);
  expect(service.hasClaudeSessions(personal.id)).toBe(true);
});

/** The project uses only these accounts from now on, with this default. */
const onlyUse = (accountIds: string[], defaultId: string, autoSwitch = false) => projects.updateSettings(db, project.id, { claudeAccounts: { only: true, accountIds, defaultId, autoSwitch } });

it("starts a project's threads on its default account, refuses one it does not use, and leaves other projects alone", async () => {
  const [work, personal, client] = ["Work", "Personal", "Client"].map((name) => accounts.add(name).id) as [string, string, string];
  accounts.update({ id: client, makeDefault: true });
  onlyUse([work, personal], personal);
  const started = await conversations.start({ ...input, projectId: project.id });
  expect([started.thread.claudeAccountId, started.run!.claudeAccountId]).toEqual([personal, personal]);
  expect(path.basename(start.mock.lastCall![1].env.CLAUDE_CONFIG_DIR!)).toBe(personal);
  expect((await conversations.start({ ...input, projectId: project.id, claudeAccountId: work })).thread.claudeAccountId).toBe(work);
  const launches = start.mock.calls.length;
  await expect(conversations.start({ ...input, projectId: project.id, claudeAccountId: client })).rejects.toThrow(/This project only uses these Claude accounts: .*(Work|Personal).*\./);
  expect(start).toHaveBeenCalledTimes(launches);
  const otherRoot = path.join(root, "other");
  await mkdir(otherRoot);
  await git(otherRoot, ["init", "-q", "-b", "main"]);
  const other = projects.insert(db, { name: "Other", rootPath: otherRoot, gitRemote: null, defaultBranch: "main", settings: {} });
  expect((await conversations.start({ ...input, projectId: other.id })).thread.claudeAccountId).toBe(client);
  // With none of its accounts enabled, the project starts nothing.
  onlyUse([work], work);
  // Straight to the record: the service waits for the account's open sessions first.
  claudeAccounts.update(db, { id: work, enabled: false });
  await expect(conversations.start({ ...input, projectId: project.id })).rejects.toThrow("None of this project's Claude accounts are enabled. Choose one in the project's settings.");
});

it("keeps an existing thread on an account its project stopped using, while its sub threads, forks and task threads take the project's default", async () => {
  const [work, personal, client] = ["Work", "Personal", "Client"].map((name) => accounts.add(name).id) as [string, string, string];
  const { thread, run } = await conversations.start({ ...input, mode: "act", projectId: project.id, claudeAccountId: client });
  onlyUse([work, personal], personal);
  const child = await conversations.startUnder(thread.id, { ...input, claudeAccountId: client });
  expect(child.thread.claudeAccountId).toBe(personal);
  const started = await conversations.toolThreadStart(run!.id, { prompt: "Check the tests" });
  expect(threads.get(db, started.thread.id)?.claudeAccountId).toBe(personal);
  expect(conversations.fork(thread.id).claudeAccountId).toBe(personal);
  const task = tasks.insert(db, { projectId: project.id, title: "Ship it", spec: null, priority: "none", labels: [], workspaceMode: "current", baseRef: null, parentTaskId: null });
  runs.insert(db, { id: "task-run", taskId: task.id, threadId: null, agent: "claude", model: "fixture", mode: "act", permissionMode: "review", claudeAccountId: client });
  expect(conversations.taskThreadForStart(task.id, { agent: "claude", model: "fixture", effort: null }).claudeAccountId).toBe(personal);

  await service.closeAndWait(run!.id);
  const resumed = await conversations.continueThread(thread.id, input);
  expect([resumed.claudeAccountId, threads.get(db, thread.id)?.claudeAccountId]).toEqual([client, client]);
  await service.closeAndWait(resumed.id);
  await expect(conversations.continueThread(thread.id, { ...input, claudeAccountId: personal })).resolves.toMatchObject({ claudeAccountId: personal });
});

it("forks a thread onto its project's default account carrying the parent's session there, once the project stopped using the parent's", async () => {
  const [personal, client] = ["Personal", "Client"].map((name) => accounts.add(name).id) as [string, string];
  const { thread, run } = await conversations.start({ ...input, projectId: project.id, claudeAccountId: client });
  await service.closeAndWait(run!.id);
  runs.update(db, run!.id, { externalSessionId: "client-session", state: "success" });
  const sessions = path.join(folder(client), "projects", "-fixture");
  await mkdir(sessions, { recursive: true });
  await writeFile(path.join(sessions, "client-session.jsonl"), '{"type":"user"}\n');
  onlyUse([personal], personal);

  const fork = conversations.fork(thread.id);
  expect(fork.claudeAccountId).toBe(personal);
  await conversations.continueThread(fork.id, { ...input, prompt: "Go on from here" });
  const [spec, launch] = start.mock.lastCall!;
  expect([spec.resumeSessionId, spec.forkSession, path.basename(launch.env.CLAUDE_CONFIG_DIR!)]).toEqual(["client-session", true, personal]);
  expect(await readFile(path.join(folder(personal), "projects", "-fixture", "client-session.jsonl"), "utf8")).toBe('{"type":"user"}\n');
  expect(threads.get(db, thread.id)?.claudeAccountId).toBe(client);
});

it("starts a task's thread on its starter's own account, as an Orcling's, even when none of the project's accounts is enabled", async () => {
  const [work, orcling] = ["Work", "Orcling"].map((name) => accounts.add(name).id) as [string, string];
  onlyUse([work], work);
  claudeAccounts.update(db, { id: work, enabled: false });
  const task = () => tasks.insert(db, { projectId: project.id, title: "Ship it", spec: null, priority: "none", labels: [], workspaceMode: "current", baseRef: null, parentTaskId: null });
  const target = { agent: "claude" as const, model: "fixture", effort: null };
  expect(() => conversations.taskThreadForStart(task().id, target)).toThrow("None of this project's Claude accounts are enabled. Choose one in the project's settings.");
  expect(conversations.taskThreadForStart(task().id, target, orcling).claudeAccountId).toBe(orcling);
});

it("moves a thread only to accounts its project uses, by hand or with its next message", async () => {
  const [work, personal, client] = ["Work", "Personal", "Client"].map((name) => accounts.add(name).id) as [string, string, string];
  const { thread, run } = await conversations.start({ ...input, projectId: project.id, claudeAccountId: work });
  await service.closeAndWait(run!.id);
  onlyUse([work, personal], work);
  await expect(conversations.switchClaudeAccount(thread.id, client)).rejects.toThrow("This project doesn't use that Claude account.");
  await expect(conversations.continueThread(thread.id, { ...input, claudeAccountId: client })).rejects.toThrow("This project doesn't use that Claude account.");
  expect(threads.get(db, thread.id)?.claudeAccountId).toBe(work);
  expect((await conversations.switchClaudeAccount(thread.id, personal)).claudeAccountId).toBe(personal);
});
