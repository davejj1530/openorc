import { EventEmitter, once } from "node:events";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunHandle } from "@openorc/agents";
import { Db, LedgerWriter, audit, checkpoints, orchestration, plans, projects, runs, snapshots, tasks, teamContextParts, teamContexts, teamRoom, teamRuntime, threads } from "@openorc/db";
import { commitAll, git } from "@openorc/git";
import { MAX_TEAM_CONTEXT_BYTES, type Project, type RunSpec, type Task, type TeamActorRecord, type TeamDispatchInput, type TeamDraft, type TeamExecutionRecord, type Thread } from "@openorc/protocol";
import { FrameCoalescer } from "../frames.js";
import { RunService, type RunAdapterRegistry, type RunHooks } from "./runs.js";
import { ShellEnvironment } from "./shell-environment.js";
import { TeamCoordinator } from "./team-coordinator.js";
import { TeamConversationService } from "./team-conversation.js";
import { AppSettingsService } from "./settings.js";
import { TeamWorkspaceService } from "./team-workspaces.js";
import { WorkspaceWriters } from "./workspace-writers.js";

interface ScriptedTurn {
  spec: RunSpec;
  handle: RunHandle;
  exited: boolean;
  closeBlocked: boolean;
  /** How many turns this one process has served, so a test can tell a warm continuation from a fresh spawn. */
  turns: number;
  exit(): void;
}

function roster(maxConcurrentAgents = 3): TeamDraft {
  return {
    name: "Scripted delivery team",
    members: [
      { key: "coordinator", name: "Lead", responsibility: "Delegate and combine findings", managerKey: null, settings: { agent: "codex", model: "fixture-astra", effort: "high", fastMode: true } },
      { key: "engineer", name: "Engineer", responsibility: "Implement the change", managerKey: "coordinator", settings: { agent: "codex", model: "fixture-sol", effort: "medium", fastMode: false } },
      {
        key: "reviewer",
        name: "Reviewer",
        responsibility: "Independently review the change",
        managerKey: "coordinator",
        settings: { agent: "claude", model: "fixture-fable", effort: "max", fastMode: false },
      },
    ],
    limits: { maxConcurrentAgents, maxAssignments: 12, maxExecutionMinutes: 30, maxAttemptsPerAssignment: 2 },
    // Ambient reads are timed; the tests that exercise them opt in.
    discussion: { ambientRounds: 0, peerFollowUps: 0, mentionOnly: [] },
  };
}

function nestedRoster(maxConcurrentAgents = 1): TeamDraft {
  const draft = roster(maxConcurrentAgents);
  draft.members[1]!.responsibility = "Manage implementation and review";
  draft.members[2]!.managerKey = "engineer";
  draft.members.push({ key: "tester", name: "Tester", responsibility: "Verify the implementation", managerKey: "engineer", settings: { ...draft.members[1]!.settings } });
  return draft;
}

function assignment(memberKey: string, requestKey = memberKey, overrides: Partial<TeamDispatchInput> = {}): TeamDispatchInput {
  return { memberKey, requestKey, title: `${memberKey} assignment`, spec: `Complete ${memberKey}'s assigned work.`, dependencies: [], attachments: [], ...overrides };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

let directory: string;
let root: string;
let db: Db;
let ledger: LedgerWriter;
let project: Project;
let thread: Thread;
let runService: RunService;
let coordinator: TeamCoordinator;
let coordinatorHooks: ConstructorParameters<typeof TeamCoordinator>[2];
let runHooks: RunHooks;
let adapters: RunAdapterRegistry;
let turns: Map<string, ScriptedTurn>;
let settled: Map<string, number>;
let settlementEvents: EventEmitter;
let rejectStart: ((spec: RunSpec) => string | null) | null;
let compacting = false;
let liveSteer: ((text: string, attachments?: string[]) => Promise<"accepted" | "unavailable">) | null;
let preparing: ReturnType<typeof vi.fn<(task: Task, assertActive: () => void) => Promise<Task>>>;
const quiet = { info() {}, warn() {}, error() {} };

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "openorc-team-coordinator-"));
  root = path.join(directory, "repository");
  await mkdir(root);
  await git(root, ["init", "-q", "-b", "main"]);
  await git(root, ["config", "user.email", "fixture@example.com"]);
  await git(root, ["config", "user.name", "Fixture"]);
  await writeFile(path.join(root, "README.md"), "# Team fixture\n");
  await commitAll(root, "Fixture baseline");
  db = Db.open(path.join(directory, "fixture.sqlite"));
  ledger = new LedgerWriter(db);
  project = projects.insert(db, { name: "Fixture", rootPath: root, gitRemote: null, defaultBranch: "main", settings: {} });
  thread = newThread();
  turns = new Map();
  settled = new Map();
  settlementEvents = new EventEmitter();
  rejectStart = null;
  liveSteer = null;
  compacting = false;
  const start = (spec: RunSpec): RunHandle => {
    const failure = rejectStart?.(spec);
    if (failure) throw new Error(failure);
    let resolve!: (code: number) => void;
    const done = new Promise<number>((next) => {
      resolve = next;
    });
    const turn: ScriptedTurn = {
      spec,
      handle: new RunHandle(spec.runId, {
        send: async (text, attachments) => {
          // A conversation member's process answers again. The harness records the new turn's input the way the provider would.
          turn.spec = { ...turn.spec, prompt: text, ...(attachments ? { attachments } : {}) };
          turn.turns += 1;
        },
        compacting: () => compacting,
        canSteer: () => liveSteer !== null && !compacting,
        steer: (text, attachments) => liveSteer?.(text, attachments) ?? Promise.resolve("unavailable"),
        interrupt() {},
        close() {
          if (!turn.closeBlocked) turn.exit();
        },
        done,
      }),
      exited: false,
      closeBlocked: false,
      turns: 1,
      exit() {
        if (turn.exited) return;
        turn.exited = true;
        turn.handle.emit("exit", 0);
        resolve(0);
      },
    };
    turns.set(spec.runId, turn);
    return turn.handle;
  };
  adapters = { codex: { start }, claude: { start }, opencode: { start } };
  const environment = new ShellEnvironment({ env: { ...process.env, OPENORC_CLAUDE_BIN: "/fixture/claude", OPENORC_CODEX_BIN: "/fixture/codex" } });
  runHooks = {
    environment: () => environment.current(),
    brief: () => "",
    onRunFinished() {},
    onThreadTurn() {},
    notify() {},
    claudeVersion: async () => null,
    onTurnSettled: forwardTurn,
    onSteerable: (runId) => coordinator.providerReady(runId),
    assertStart: (input) => coordinator.assertLaunch(input),
  };
  runService = makeRunService();
  preparing = vi.fn(async (task: Task, assertActive: () => void) => {
    assertActive();
    if (task.worktreePath) return task;
    const cwd = path.join(directory, `worktree-${task.id}`);
    const baseSha = (await git(root, ["rev-parse", "HEAD"])).stdout.trim();
    await git(root, ["worktree", "add", "--detach", cwd, baseSha]);
    assertActive();
    return tasks.update(db, task.id, { workspaceMode: "worktree", worktreePath: cwd, baseSha });
  });
  coordinatorHooks = { prepare: preparing, validate: vi.fn(async () => {}), changed: vi.fn(), closeTimeoutMs: 1000 };
  coordinator = new TeamCoordinator(db, runService, coordinatorHooks);
});

afterEach(async () => {
  runHooks.onTurnSettled = undefined;
  for (const turn of turns.values()) turn.exit();
  await runService.closeAll();
  await coordinator.drain();
  ledger.close();
  db.close();
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

function newThread(): Thread {
  return threads.insert(db, {
    projectId: project.id,
    title: "Coordinate a change",
    agent: "codex",
    model: "fixture-astra",
    effort: "high",
    fastMode: true,
    mode: "act",
    permissionMode: "trusted",
    workspaceMode: "current",
  });
}

const forwardTurn: NonNullable<RunHooks["onTurnSettled"]> = (run, scope, currentProject, outcome) => {
  settled.set(run.id, (settled.get(run.id) ?? 0) + 1);
  coordinator.onTurnSettled(run, scope, currentProject, outcome);
  settlementEvents.emit(run.id);
};

function makeRunService(): RunService {
  const service = new RunService(
    db,
    ledger,
    new FrameCoalescer(() => {}),
    async () => ({ port: 0, urlForRun: (id) => `http://fixture.invalid/${id}`, revoke: () => {}, close: async () => {} }),
    () => {},
    quiet,
    runHooks,
    adapters,
  );
  // Catalog discovery is an external provider boundary, separate from execution.
  vi.spyOn(service, "models").mockImplementation(async (agent) =>
    roster()
      .members.filter((member) => member.settings.agent === agent)
      .map((member) => ({
        id: member.settings.model,
        label: member.name,
        agent: member.settings.agent,
        isDefault: member.managerKey === null,
        efforts: ["medium", "high", "max"],
        defaultEffort: "medium",
        fastMode: { supported: true },
      })),
  );
  return service;
}

async function startTeam(draft = roster(), target = thread): Promise<TeamExecutionRecord> {
  const saved = orchestration.save(db, { projectId: target.projectId, expectedRevisionId: null, draft });
  const execution = await coordinator.start({ threadId: target.id, teamRevisionId: saved.revision.id, prompt: "Implement and review the requested change." });
  await coordinator.drain();
  return coordinator.status(execution.id);
}

/** Makes one execution's stored record unreadable, as a damaged database would. */
function corruptJournal(executionId: string): void {
  db.stmt("UPDATE team_actors SET details = '{}' WHERE execution_id = ? AND id = 'lead'").run(executionId);
}

function actor(executionId: string, actorId: string): TeamActorRecord {
  const found = coordinator.status(executionId).actors.find((candidate) => candidate.id === actorId);
  if (!found) throw new Error(`Missing actor ${actorId}`);
  return found;
}

function activeTurn(executionId: string, actorId = "lead"): ScriptedTurn {
  const attempt = coordinator.status(executionId).attempts.findLast((candidate) => candidate.actorId === actorId && candidate.runId !== null);
  const turn = attempt?.runId ? turns.get(attempt.runId) : undefined;
  if (!turn || turn.exited) throw new Error(`No active scripted turn for ${actorId}`);
  return turn;
}

async function finish(turn: ScriptedTurn, text = "Finished this turn."): Promise<void> {
  // Subscribe before emitting completion: capture may finish immediately or wait on Git.
  const captured = once(settlementEvents, turn.spec.runId);
  const { runId, agent, model } = turn.spec;
  turn.handle.emit("event", { type: "session.started", runId, ts: Date.now(), agent, externalSessionId: `session-${runId}`, model: model ?? "fixture" });
  turn.handle.emit("event", { type: "message.completed", runId, ts: Date.now(), messageId: `reply-${runId}`, role: "assistant", text });
  turn.handle.emit("event", { type: "turn.completed", runId, ts: Date.now(), turnId: `turn-${runId}`, status: "success", durationMs: 1 });
  await captured;
  await coordinator.drain();
}

/** Lets a pending room read come due: members woken to read, not to answer, start after a short debounce. */
async function debounce(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 400));
  await coordinator.drain();
}

async function fail(turn: ScriptedTurn, message = "The provider session is no longer available."): Promise<void> {
  turn.handle.emit("event", { type: "error", runId: turn.spec.runId, ts: Date.now(), fatal: true, message });
  await finish(turn, "Public partial result.");
}

async function nestedWorking() {
  const execution = await startTeam(nestedRoster());
  const lead = activeTurn(execution.id);
  const manager = coordinator.dispatch(lead.spec.runId, assignment("engineer"));
  coordinator.wait(lead.spec.runId);
  await finish(lead);
  const managerTurn = activeTurn(execution.id, manager.id);
  const worker = coordinator.dispatch(managerTurn.spec.runId, assignment("reviewer"));
  coordinator.wait(managerTurn.spec.runId);
  await finish(managerTurn);
  return { execution, lead, manager, managerTurn, worker, workerTurn: activeTurn(execution.id, worker.id) };
}

describe("durable team coordination with real run capture", () => {
  it("resumes a waiting worker but starts a new actor on the same task with a fresh session", async () => {
    const execution = await startTeam();
    const lead = activeTurn(execution.id);
    const worker = coordinator.dispatch(lead.spec.runId, assignment("engineer"));
    coordinator.wait(lead.spec.runId);
    await finish(lead);
    const first = activeTurn(execution.id, worker.id);
    coordinator.message(first.spec.runId, { recipientId: "lead", text: "Ready for another instruction.", requestKey: "ready" });
    coordinator.wait(first.spec.runId);
    await finish(first);
    const parent = activeTurn(execution.id);
    coordinator.message(parent.spec.runId, { recipientId: worker.id, text: "Finish this assignment.", requestKey: "finish" });
    coordinator.wait(parent.spec.runId);
    await finish(parent);
    const resumed = activeTurn(execution.id, worker.id);
    expect(resumed.spec.resumeSessionId).toBe(`session-${first.spec.runId}`);
    expect(coordinator.status(execution.id).attempts.find((item) => item.runId === resumed.spec.runId)?.resumeSessionId).toBe(`session-${first.spec.runId}`);
    coordinator.complete(resumed.spec.runId, { result: "Completed original task." });
    await finish(resumed);

    const parentAgain = activeTurn(execution.id);
    const document = tasks.get(db, worker.taskId!)!;
    const nextActor = coordinator.reserveTask(parentAgain.spec.runId, {
      taskId: worker.taskId!,
      memberKey: "engineer",
      requestKey: "review-follow-up",
      input: { title: "Accepted review input", spec: "Address newly selected comments.", attachments: [] },
    });
    expect(tasks.get(db, worker.taskId!)).toEqual(document);
    coordinator.wait(parentAgain.spec.runId);
    await finish(parentAgain);
    const followup = activeTurn(execution.id, nextActor.id);
    expect(followup.spec.resumeSessionId).toBeUndefined();
    expect(coordinator.status(execution.id).attempts.find((item) => item.runId === followup.spec.runId)?.resumeSessionId).toBeNull();
    expect(teamRuntime.assignment(db, execution.id, worker.id)?.taskId).toBe(nextActor.taskId);
    expect(() => coordinator.statusForRun(resumed.spec.runId)).toThrow(/authority/);
    coordinator.complete(followup.spec.runId, { result: "Addressed review." });
    await finish(followup);
    const finalLead = activeTurn(execution.id);
    coordinator.complete(finalLead.spec.runId, { result: "Combined both assignments." });
    await finish(finalLead);
  });

  it("rejects broad, forged, forked and stale launch session authority", async () => {
    const execution = await startTeam();
    const first = activeTurn(execution.id);
    await finish(first);
    const gate = deferred();
    coordinatorHooks.validate = vi.fn(async () => {
      await gate.promise;
    });
    const instance = orchestration.getInstance(db, thread.id)!;
    const plan = { revision: orchestration.getRevision(db, instance.teamRevisionId)!, settings: roster().members[0]!.settings, leadOverrides: instance.leadOverrides };
    const next = coordinator.admit({ threadId: thread.id, prompt: "Continue safely.", plan, expectedConfigurationVersion: instance.configurationVersion });
    await vi.waitFor(() => expect(coordinator.status(next.id).attempts).toHaveLength(1));
    const attempt = coordinator.status(next.id).attempts[0]!;
    const input = {
      scope: { task: null, thread: threads.get(db, thread.id)! },
      project,
      ...attempt.settings,
      effort: attempt.settings.effort ?? undefined,
      mode: thread.mode,
      permissionMode: thread.permissionMode,
      prompt: teamRuntime.prompt(db, next.id, attempt.id)!,
      resume: false,
      resumeFrom: { sessionId: attempt.resumeSessionId!, fork: false },
      teamAttemptId: attempt.id,
    };
    expect(() => coordinator.assertLaunch(input)).not.toThrow();
    expect(() => coordinator.assertLaunch({ ...input, resume: true })).toThrow(/reserved/);
    expect(() => coordinator.assertLaunch({ ...input, resumeFrom: { sessionId: "other-owner", fork: false } })).toThrow(/reserved/);
    expect(() => coordinator.assertLaunch({ ...input, resumeFrom: { ...input.resumeFrom, fork: true } })).toThrow(/reserved/);
    const stopped = coordinator.stop(next.id);
    expect(() => coordinator.assertLaunch(input)).toThrow(/coordinator|stopped|replaced/);
    gate.resolve();
    await stopped;
    await coordinator.drain();
  });

  it("delegates to both providers, pins settings, captures isolated outputs and resumes the lead once", async () => {
    const execution = await startTeam();
    const lead = activeTurn(execution.id);
    expect(execution.actors.filter((item) => !item.participant)).toHaveLength(1);
    expect(actor(execution.id, "lead").taskId).toBeNull();
    expect(tasks.list(db)).toEqual([]);
    expect(lead.spec).toMatchObject({ agent: "codex", model: "fixture-astra", effort: "high", fastMode: true });
    const engineer = coordinator.dispatch(lead.spec.runId, assignment("engineer"));
    const reviewer = coordinator.dispatch(lead.spec.runId, assignment("reviewer"));
    expect(coordinator.dispatch(lead.spec.runId, assignment("engineer")).id).toBe(engineer.id);
    expect(() => coordinator.dispatch(lead.spec.runId, assignment("engineer", "engineer", { spec: "Conflicting request" }))).toThrow();
    coordinator.wait(lead.spec.runId, { assignmentIds: [engineer.id, reviewer.id] });
    await finish(lead);
    expect(lead.exited).toBe(true);
    expect(actor(execution.id, "lead").state).toBe("waiting");
    expect(checkpoints.listForThread(db, thread.id)).not.toHaveLength(0);

    const engineeringTurn = activeTurn(execution.id, engineer.id);
    const reviewTurn = activeTurn(execution.id, reviewer.id);
    expect(engineeringTurn.spec).toMatchObject({ agent: "codex", model: "fixture-sol", effort: "medium", fastMode: false });
    expect(reviewTurn.spec).toMatchObject({ agent: "claude", model: "fixture-fable", effort: "max", fastMode: false });
    expect(new Set([root, engineeringTurn.spec.cwd, reviewTurn.spec.cwd]).size).toBe(3);
    await writeFile(path.join(engineeringTurn.spec.cwd, "implementation.txt"), "The engineer's uncommitted output\n");
    await writeFile(path.join(reviewTurn.spec.cwd, "review.txt"), "The reviewer's uncommitted output\n");
    coordinator.complete(engineeringTurn.spec.runId, { result: "Implementation is ready." });
    await finish(engineeringTurn);
    expect(actor(execution.id, "lead").state).toBe("waiting");
    coordinator.complete(reviewTurn.spec.runId, { result: "Review is ready." });
    await finish(reviewTurn);
    const captured = snapshots.get(db, actor(execution.id, engineer.id).snapshotId!);
    expect(captured).toMatchObject({ taskId: engineer.taskId, runId: engineeringTurn.spec.runId });
    expect((await git(root, ["show", `${captured!.treeSha}:implementation.txt`])).stdout).toBe("The engineer's uncommitted output\n");
    const resumedLead = activeTurn(execution.id);
    expect(resumedLead.spec.runId).not.toBe(lead.spec.runId);
    expect(resumedLead.spec.prompt).toContain("Implementation is ready.");
    expect(resumedLead.spec.prompt).toContain("Review is ready.");
    coordinator.complete(resumedLead.spec.runId, { result: "Both assignments are complete." });
    await finish(resumedLead);
    expect(coordinator.status(execution.id).state).toBe("completed");
    expect(tasks.list(db)).toHaveLength(2);
    expect([...turns.values()].every((turn) => turn.exited)).toBe(true);
  });

  it("rejects missing threads before provider or workspace startup", async () => {
    await expect(coordinator.start({ threadId: "missing", prompt: "Work" })).rejects.toThrow();
    await coordinator.drain();
    expect(turns.size).toBe(0);
    expect(preparing).not.toHaveBeenCalled();
    expect(tasks.list(db)).toEqual([]);
  });

  it("completes nested handoffs at capacity one with manager-owned tasks and isolated turn history", async () => {
    const execution = await startTeam(nestedRoster());
    const lead = activeTurn(execution.id);
    expect(lead.spec.systemPromptAppendix).toContain("Direct reports: engineer:");
    expect(lead.spec.systemPromptAppendix).toContain("Further descendants: reviewer:");
    const manager = coordinator.dispatch(lead.spec.runId, assignment("engineer"));
    expect(() => coordinator.complete(lead.spec.runId, { result: "Premature root completion" })).toThrow(/unresolved/);
    coordinator.wait(lead.spec.runId);
    await finish(lead);

    const managerTurn = activeTurn(execution.id, manager.id);
    expect(managerTurn.spec.systemPromptAppendix).toContain("Parent assignment: lead");
    expect(managerTurn.spec.systemPromptAppendix).toContain("Direct reports: reviewer:");
    expect(managerTurn.spec.systemPromptAppendix).toContain("Further descendants: none");
    const reviewer = coordinator.dispatch(managerTurn.spec.runId, assignment("reviewer"));
    const tester = coordinator.dispatch(managerTurn.spec.runId, assignment("tester", "test-after-review", { dependencies: [reviewer.id] }));
    expect(tasks.get(db, manager.taskId!)?.parentTaskId).toBeNull();
    expect(tasks.get(db, reviewer.taskId!)?.parentTaskId).toBe(manager.taskId);
    expect(tasks.get(db, tester.taskId!)?.parentTaskId).toBe(manager.taskId);
    expect(() => coordinator.complete(managerTurn.spec.runId, { result: "Premature manager completion" })).toThrow(/unresolved/);
    coordinator.wait(managerTurn.spec.runId);
    await finish(managerTurn);
    expect(actor(execution.id, manager.id).state).toBe("waiting");
    expect(actor(execution.id, "lead").state).toBe("waiting");
    expect([...turns.values()].filter((turn) => !turn.exited)).toHaveLength(1);

    const reviewing = activeTurn(execution.id, reviewer.id);
    expect(reviewing.spec.systemPromptAppendix).toContain(`Parent assignment: ${manager.id}`);
    expect(reviewing.spec.systemPromptAppendix).toContain("Direct reports: none");
    expect(actor(execution.id, tester.id).state).toBe("queued");
    coordinator.complete(reviewing.spec.runId, { result: "Nested review passed" });
    await finish(reviewing);
    expect(actor(execution.id, manager.id).state).toBe("waiting");
    const testing = activeTurn(execution.id, tester.id);
    expect([...turns.values()].filter((turn) => !turn.exited)).toHaveLength(1);
    coordinator.complete(testing.spec.runId, { result: "Nested verification passed" });
    await finish(testing);

    const resumedManager = activeTurn(execution.id, manager.id);
    expect(resumedManager.spec.prompt).toContain("Nested review passed");
    expect(resumedManager.spec.prompt).toContain("Nested verification passed");
    expect(resumedManager.spec.resumeSessionId).toBe(`session-${managerTurn.spec.runId}`);
    expect(actor(execution.id, "lead").state).toBe("waiting");
    expect(coordinator.status(execution.id).messages.filter((message) => message.recipientId === "lead")).toEqual([]);
    expect(() => coordinator.complete(managerTurn.spec.runId, { result: "Retired manager turn" })).toThrow();
    coordinator.complete(resumedManager.spec.runId, { result: "Manager accepted both nested results" });
    await finish(resumedManager);

    const resumedLead = activeTurn(execution.id);
    expect(resumedLead.spec.prompt).toContain("Manager accepted both nested results");
    expect(resumedLead.spec.prompt).not.toContain("Nested review passed");
    expect(resumedLead.spec.resumeSessionId).toBe(`session-${lead.spec.runId}`);
    coordinator.complete(resumedLead.spec.runId, { result: "Nested delivery complete" });
    await finish(resumedLead);
    const done = coordinator.status(execution.id);
    expect(done.state).toBe("completed");
    expect(done.actors.every((current) => current.state === "completed")).toBe(true);
    expect(done.messages.every((message) => message.state === "delivered")).toBe(true);
    expect(done.messages.filter((message) => message.kind === "result")).toHaveLength(3);
    expect(done.attempts.filter((attempt) => attempt.actorId === manager.id)).toHaveLength(2);
    expect(tasks.list(db)).toHaveLength(3);
    expect([...turns.values()].every((turn) => turn.exited)).toBe(true);
  });

  it("rejects cross-subtree authority and retains member uniqueness and parent-scoped request keys", async () => {
    const draft = roster();
    draft.members.push(
      { key: "engineer-child", name: "Engineer child", responsibility: "Implement the assigned portion", managerKey: "engineer", settings: { ...draft.members[1]!.settings } },
      { key: "reviewer-child", name: "Reviewer child", responsibility: "Review the assigned portion", managerKey: "reviewer", settings: { ...draft.members[1]!.settings } },
    );
    const execution = await startTeam(draft);
    const lead = activeTurn(execution.id);
    const first = coordinator.dispatch(lead.spec.runId, assignment("engineer"));
    const second = coordinator.dispatch(lead.spec.runId, assignment("reviewer"));
    await coordinator.drain();
    const firstTurn = activeTurn(execution.id, first.id);
    const secondTurn = activeTurn(execution.id, second.id);
    const secondChild = coordinator.dispatch(secondTurn.spec.runId, assignment("reviewer-child", "same-parent-local-key"));
    expect(() => coordinator.dispatch(firstTurn.spec.runId, assignment("engineer-child", "foreign-dependency", { dependencies: [secondChild.id] }))).toThrow(/same requesting manager/);
    const firstChild = coordinator.dispatch(firstTurn.spec.runId, assignment("engineer-child", "same-parent-local-key"));
    expect(firstChild.id).not.toBe(secondChild.id);
    expect(coordinator.dispatch(firstTurn.spec.runId, assignment("engineer-child", "same-parent-local-key")).id).toBe(firstChild.id);
    expect(() => coordinator.dispatch(firstTurn.spec.runId, assignment("engineer-child", "another-assignment"))).toThrow(/active assignment/);
    expect(() => coordinator.dispatch(lead.spec.runId, assignment("engineer-child"))).toThrow(/direct reports/);
    expect(() => coordinator.dispatch(firstTurn.spec.runId, assignment("reviewer-child"))).toThrow(/direct reports/);
    expect(() => coordinator.message(firstTurn.spec.runId, { recipientId: secondChild.id, text: "Cross-subtree direction", requestKey: "foreign" })).toThrow();
    expect(() => coordinator.message(lead.spec.runId, { recipientId: firstChild.id, text: "Skip the manager", requestKey: "skip" })).toThrow();
    expect(() => coordinator.wait(firstTurn.spec.runId, { assignmentIds: [secondChild.id] })).toThrow(/subtree/);
    expect(() => coordinator.dispatch(firstTurn.spec.runId, assignment("not-pinned"))).toThrow(/direct reports/);
    expect(() => coordinator.complete(firstTurn.spec.runId, { result: "Unresolved subtree" })).toThrow(/unresolved/);
    expect(() => coordinator.complete(lead.spec.runId, { result: "Unresolved managers" })).toThrow(/unresolved/);
    expect(coordinator.status(execution.id).actors.filter((item) => !item.participant)).toHaveLength(5);
  });

  it("requires every manager to release its writer before preparing descendants", async () => {
    const prepared: string[] = [];
    coordinatorHooks.workspace = {
      beforeStart: async (executionId, actorId, assertActive) => {
        const current = actor(executionId, actorId);
        if (current.parentId) {
          const parentRuns = coordinator.status(executionId).attempts.filter((attempt) => attempt.actorId === current.parentId);
          expect(parentRuns.every((attempt) => !attempt.runId || !runService.isLive(attempt.runId))).toBe(true);
        }
        if (current.taskId) await preparing(tasks.get(db, current.taskId)!, assertActive);
        prepared.push(actorId);
      },
      captureOutput: async () => {},
    };
    const execution = await startTeam(nestedRoster(3));
    const lead = activeTurn(execution.id);
    const manager = coordinator.dispatch(lead.spec.runId, assignment("engineer"));
    await coordinator.drain();
    expect(actor(execution.id, manager.id).state).toBe("queued");
    expect(prepared).toEqual(["lead"]);
    coordinator.wait(lead.spec.runId);
    await finish(lead);
    const managerTurn = activeTurn(execution.id, manager.id);
    const first = coordinator.dispatch(managerTurn.spec.runId, assignment("reviewer"));
    const second = coordinator.dispatch(managerTurn.spec.runId, assignment("tester"));
    await coordinator.drain();
    expect(actor(execution.id, first.id).state).toBe("queued");
    expect(actor(execution.id, second.id).state).toBe("queued");
    expect(prepared).toEqual(["lead", manager.id]);
    coordinator.wait(managerTurn.spec.runId);
    await finish(managerTurn);
    expect(activeTurn(execution.id, first.id).spec.agent).toBe("claude");
    expect(activeTurn(execution.id, second.id).spec.agent).toBe("codex");
    expect(prepared).toEqual(["lead", manager.id, first.id, second.id]);
    expect([...turns.values()].filter((turn) => !turn.exited)).toHaveLength(2);
    await coordinator.stop(execution.id);
  });

  it("lets a manager wait for an explicit child retry without polling or completing its subtree early", async () => {
    const { execution, manager, worker, workerTurn } = await nestedWorking();
    await finish(workerTurn);
    expect(actor(execution.id, worker.id).state).toBe("attention");
    const informedManager = activeTurn(execution.id, manager.id);
    expect(informedManager.spec.prompt).toContain("needs attention");
    expect(() => coordinator.complete(informedManager.spec.runId, { result: "Ignore failed child" })).toThrow(/unresolved/);
    expect(actor(execution.id, "lead").state).toBe("waiting");
    coordinator.wait(informedManager.spec.runId, { assignmentIds: [worker.id] });
    await finish(informedManager);
    const turnsBeforeRetry = turns.size;
    await coordinator.drain();
    expect(turns.size).toBe(turnsBeforeRetry);
    expect(actor(execution.id, manager.id).state).toBe("waiting");
    expect([...turns.values()].filter((turn) => !turn.exited)).toHaveLength(0);

    coordinator.retry(execution.id, worker.id);
    await coordinator.drain();
    const retried = activeTurn(execution.id, worker.id);
    expect(actor(execution.id, worker.id)).toMatchObject({ taskId: worker.taskId, parentId: manager.id, retries: 1 });
    expect(retried.spec.resumeSessionId).toBe(`session-${workerTurn.spec.runId}`);
    coordinator.complete(retried.spec.runId, { result: "Child recovered successfully" });
    await finish(retried);
    const resumedManager = activeTurn(execution.id, manager.id);
    expect(resumedManager.spec.prompt).toContain("Child recovered successfully");
    coordinator.complete(resumedManager.spec.runId, { result: "Recovered subtree accepted" });
    await finish(resumedManager);
    const resumedLead = activeTurn(execution.id);
    expect(resumedLead.spec.prompt).toContain("Recovered subtree accepted");
    coordinator.complete(resumedLead.spec.runId, { result: "Recovered hierarchy complete" });
    await finish(resumedLead);
    expect(coordinator.status(execution.id).state).toBe("completed");
    expect(tasks.list(db)).toHaveLength(2);
    expect(coordinator.status(execution.id).attempts.filter((attempt) => attempt.actorId === manager.id)).toHaveLength(3);
  });

  it("stops the entire hierarchy during a grandchild approval and rejects its late result", async () => {
    const { execution, lead, manager, managerTurn, worker, workerTurn } = await nestedWorking();
    const approval = runService.requestApproval(workerTurn.spec.runId, "grandchild-approval", "Bash", { command: "true" });
    coordinator.complete(workerTurn.spec.runId, { result: "Completion before Stop" });
    await coordinator.stop(execution.id);
    await expect(approval).resolves.toEqual({ decision: "deny" });
    const stopped = coordinator.status(execution.id);
    expect(stopped).toMatchObject({ state: "stopped", generation: execution.generation + 1 });
    expect(stopped.actors.every((current) => current.state === "cancelled")).toBe(true);
    expect([...turns.values()].every((turn) => turn.exited)).toBe(true);
    for (const oldTurn of [lead, managerTurn, workerTurn]) {
      expect(() => coordinator.complete(oldTurn.spec.runId, { result: "Old authority" })).toThrow();
    }
    expect(() => coordinator.retry(execution.id, manager.id)).toThrow();
    workerTurn.handle.emit("event", { type: "turn.completed", runId: workerTurn.spec.runId, ts: Date.now(), turnId: "late-grandchild", status: "success", durationMs: 1 });
    await coordinator.drain();
    expect(coordinator.status(execution.id)).toEqual(stopped);
    expect(stopped.messages.filter((message) => message.senderId === worker.id && message.kind === "result")).toEqual([]);
  });

  it("fences grandchild preparation when Stop begins while its ancestors are waiting", async () => {
    const execution = await startTeam(nestedRoster());
    const lead = activeTurn(execution.id);
    const manager = coordinator.dispatch(lead.spec.runId, assignment("engineer"));
    coordinator.wait(lead.spec.runId);
    await finish(lead);
    const managerTurn = activeTurn(execution.id, manager.id);
    const gate = deferred();
    const entered = deferred();
    const normalPrepare = preparing.getMockImplementation()!;
    preparing.mockImplementationOnce(async (task, assertActive) => {
      entered.resolve();
      await gate.promise;
      assertActive();
      return normalPrepare(task, assertActive);
    });
    const worker = coordinator.dispatch(managerTurn.spec.runId, assignment("reviewer"));
    coordinator.wait(managerTurn.spec.runId);
    const finishing = finish(managerTurn);
    await entered.promise;
    const stopping = coordinator.stop(execution.id);
    gate.resolve();
    await Promise.all([stopping, finishing]);
    await coordinator.drain();
    expect(coordinator.status(execution.id).state).toBe("stopped");
    expect(actor(execution.id, worker.id).state).toBe("cancelled");
    expect(runs.listForTask(db, worker.taskId!)).toEqual([]);
    expect(turns.size).toBe(2);
  });

  it("restores a nested hierarchy after database reopen: only the interrupted turn waits, and its managers resume with its result", async () => {
    const { execution, lead, manager, managerTurn, worker, workerTurn } = await nestedWorking();
    runHooks.onTurnSettled = undefined;
    for (const turn of turns.values()) turn.exit();
    await runService.closeAll();
    ledger.close();
    db.close();
    db = Db.open(path.join(directory, "fixture.sqlite"));
    ledger = new LedgerWriter(db);
    runHooks.onTurnSettled = forwardTurn;
    runService = makeRunService();
    coordinator = new TeamCoordinator(db, runService, coordinatorHooks);
    coordinator.recover();
    await coordinator.drain();
    expect(turns.size).toBe(3);
    // The worker's turn was running when the app closed, so its work waits for inspection. Its managers were only
    // waiting for it and keep waiting; idle chat members are untouched.
    expect(actor(execution.id, worker.id)).toMatchObject({ state: "attention", interrupted: true });
    expect(actor(execution.id, manager.id).state).toBe("waiting");
    expect(actor(execution.id, "lead").state).toBe("waiting");
    expect(
      coordinator
        .status(execution.id)
        .actors.filter((current) => current.participant)
        .every((current) => current.state === "waiting"),
    ).toBe(true);
    for (const oldTurn of [lead, managerTurn, workerTurn]) {
      expect(() => coordinator.statusForRun(oldTurn.spec.runId)).toThrow();
    }
    coordinator.retry(execution.id, worker.id);
    await coordinator.drain();
    const resumedWorker = activeTurn(execution.id, worker.id);
    // A restart is not the agent's failure, so this retry is not counted against the assignment.
    expect(actor(execution.id, worker.id)).toMatchObject({ state: "running", retries: 0 });
    expect(actor(execution.id, worker.id).interrupted).toBeUndefined();
    expect(actor(execution.id, manager.id).state).toBe("waiting");
    coordinator.complete(resumedWorker.spec.runId, { result: "Recovered grandchild result" });
    await finish(resumedWorker);
    const resumedManager = activeTurn(execution.id, manager.id);
    expect(resumedManager.spec.prompt).toContain("Recovered grandchild result");
    coordinator.complete(resumedManager.spec.runId, { result: "Recovered manager result" });
    await finish(resumedManager);
    const resumedLead = activeTurn(execution.id);
    expect(resumedLead.spec.prompt).toContain("Recovered manager result");
    coordinator.complete(resumedLead.spec.runId, { result: "Recovered nested execution" });
    await finish(resumedLead);
    const complete = coordinator.status(execution.id);
    expect(complete.state).toBe("completed");
    expect(complete.attempts.every((attempt) => attempt.endedAt !== null)).toBe(true);
    expect(complete.actors.every((current) => current.state === "completed")).toBe(true);
    expect(tasks.list(db)).toHaveLength(2);
  });

  it("contains a team whose record cannot be read: startup and every other team keep working", async () => {
    const broken = await startTeam();
    const healthy = await startTeam(roster(), newThread());
    corruptJournal(broken.id);
    runHooks.onTurnSettled = undefined;
    for (const turn of turns.values()) turn.exit();
    await runService.closeAll();
    runHooks.onTurnSettled = forwardTurn;
    runService = makeRunService();
    coordinator = new TeamCoordinator(db, runService, coordinatorHooks);
    expect(() => coordinator.recover()).not.toThrow();
    await coordinator.drain();
    expect(coordinator.faultReason(broken.id)).toMatch(/could not continue/);
    expect(coordinator.faultReason(healthy.id)).toBeNull();
    coordinator.retry(healthy.id, "lead");
    await coordinator.drain();
    await finish(activeTurn(healthy.id), "Unaffected.");
    expect(coordinator.status(healthy.id).state).toBe("completed");
  });

  it("queues a turn again after a restart when its provider never started, without asking for inspection", async () => {
    const gate = deferred();
    // Admission checks each of the three members; the turn's own check, the fourth, is held open.
    let checks = 0;
    coordinatorHooks.validate = vi.fn(() => (++checks > 3 ? gate.promise : Promise.resolve()));
    const saved = orchestration.save(db, { projectId: project.id, expectedRevisionId: null, draft: roster() });
    const execution = await coordinator.start({ threadId: thread.id, teamRevisionId: saved.revision.id, prompt: "Implement and review the requested change." });
    await vi.waitFor(() => expect(coordinator.status(execution.id).attempts).toHaveLength(1));
    expect(coordinator.status(execution.id).attempts[0]).toMatchObject({ state: "starting", runId: null });
    // The app closes while the turn is still preparing; the next start finds a turn whose provider never ran.
    coordinatorHooks.validate = vi.fn(async () => {});
    coordinator = new TeamCoordinator(db, runService, coordinatorHooks);
    coordinator.recover();
    await coordinator.drain();
    const recovered = coordinator.status(execution.id);
    expect(recovered.attempts[0]).toMatchObject({ state: "cancelled", error: "OpenOrc restarted before this turn started." });
    expect(recovered.state).toBe("active");
    expect(actor(execution.id, "lead")).toMatchObject({ state: "running", retries: 0 });
    expect(actor(execution.id, "lead").interrupted).toBeUndefined();
    gate.resolve();
  });

  it("asks for Stop again when the app restarted in the middle of stopping", async () => {
    const execution = await startTeam();
    const lead = activeTurn(execution.id);
    runHooks.onTurnSettled = undefined;
    lead.exit();
    await runService.closeAll();
    runHooks.onTurnSettled = forwardTurn;
    // The stop's own last write never happened: the journal still says stopping.
    teamRuntime.update(db, execution.id, (state) => {
      state.generation += 1;
      state.state = "stopping";
      for (const item of state.actors) if (item.state !== "completed" && item.state !== "cancelled") item.state = "cancelled";
    });
    runService = makeRunService();
    coordinator = new TeamCoordinator(db, runService, coordinatorHooks);
    coordinator.recover();
    expect(coordinator.status(execution.id)).toMatchObject({ state: "attention", error: "OpenOrc restarted while this team was stopping. Stop it again to finish." });
    await coordinator.stop(execution.id);
    expect(coordinator.status(execution.id).state).toBe("stopped");
  });

  it("never lets restarts use up an assignment's retries", async () => {
    const execution = await startTeam();
    const first = activeTurn(execution.id);
    // The app closes with the lead's turn running; the next start recovers the journal.
    const restartApp = async () => {
      runHooks.onTurnSettled = undefined;
      for (const turn of turns.values()) turn.exit();
      await runService.closeAll();
      runHooks.onTurnSettled = forwardTurn;
      runService = makeRunService();
      coordinator = new TeamCoordinator(db, runService, coordinatorHooks);
      coordinator.recover();
      await coordinator.drain();
    };
    for (const restart of [1, 2, 3]) {
      await restartApp();
      expect(actor(execution.id, "lead"), `restart ${restart}`).toMatchObject({ state: "attention", interrupted: true, retries: 0 });
      expect(coordinator.retryAvailability(execution.id, "lead")).toEqual({ allowed: true, reason: null });
      coordinator.retry(execution.id, "lead");
      await coordinator.drain();
      expect(activeTurn(execution.id).spec.runId).not.toBe(first.spec.runId);
    }
    await finish(activeTurn(execution.id), "Done after restarts.");
    expect(coordinator.status(execution.id)).toMatchObject({ state: "completed" });
    expect(actor(execution.id, "lead").retries).toBe(0);
  });

  it.each(["codex", "claude"] as const)("delivers durable image direction to %s after an explicit failed-launch retry", async (agent) => {
    const draft = roster();
    if (agent === "claude") draft.members[0]!.settings = { ...draft.members[2]!.settings };
    const saved = orchestration.save(db, { projectId: project.id, expectedRevisionId: null, draft });
    const execution = await coordinator.start({ threadId: thread.id, teamRevisionId: saved.revision.id, prompt: "Inspect the original image", attachments: ["/fixture/original.png"] });
    await coordinator.drain();
    const initial = activeTurn(execution.id);
    const direction = { text: "Compare this new image", requestKey: "image-direction", attachments: ["/fixture/new.png", "/fixture/original.png", "/fixture/new.png"] };
    const message = coordinator.steer(execution.id, direction);
    expect(message.attachments).toEqual(["/fixture/new.png", "/fixture/original.png"]);
    expect(coordinator.steer(execution.id, { ...direction, attachments: message.attachments }).id).toBe(message.id);
    expect(() => coordinator.steer(execution.id, { ...direction, attachments: ["/fixture/different.png"] })).toThrow(/different direction/);
    expect(initial.spec.attachments).toEqual(["/fixture/original.png"]);
    expect(() => coordinator.complete(initial.spec.runId, { result: "Obsolete answer" })).toThrow(/direction/);
    rejectStart = (spec) => (spec.agent === agent ? "Provider temporarily unavailable" : null);
    await finish(initial);
    expect(actor(execution.id, "lead").state).toBe("attention");
    expect(coordinator.status(execution.id).messages[0]).toMatchObject({ id: message.id, state: "claimed", deliveredAt: null, attachments: message.attachments });
    const failed = coordinator.status(execution.id).attempts.at(-1)!;
    expect(failed.attachments).toEqual(["/fixture/original.png", "/fixture/new.png"]);

    rejectStart = null;
    coordinator.retry(execution.id, "lead");
    await coordinator.drain();
    const retry = activeTurn(execution.id);
    expect(retry.spec).toMatchObject({ agent, prompt: expect.stringContaining(direction.text), attachments: ["/fixture/original.png", "/fixture/new.png"] });
    coordinator.complete(retry.spec.runId, { result: "Both images addressed" });
    await finish(retry);
    const done = coordinator.status(execution.id);
    expect(done.state).toBe("completed");
    expect(done.messages).toHaveLength(1);
    expect(done.messages[0]).toMatchObject({ state: "delivered", deliveredAt: expect.any(Number), attachments: message.attachments });
    expect(done.attempts.find((attempt) => attempt.id === failed.id)?.attachments).toEqual(failed.attachments);
  });

  it("snapshots image direction and lead settings before asynchronous startup, retaining later changes for the following turn", async () => {
    const execution = await startTeam();
    const initial = activeTurn(execution.id);
    const first = coordinator.steer(execution.id, { text: "First image", requestKey: "image-one", attachments: ["/fixture/first.png"] });
    const gate = deferred();
    const entered = deferred();
    coordinatorHooks.validate = vi.fn(async () => {
      entered.resolve();
      await gate.promise;
    });
    const finishing = finish(initial);
    await entered.promise;
    const admitted = coordinator.status(execution.id).attempts.at(-1)!;
    expect(admitted).toMatchObject({ state: "starting", messageIds: [first.id], attachments: ["/fixture/first.png"], settings: { effort: "high", fastMode: true }, configurationVersion: 1 });
    const second = coordinator.steer(execution.id, { text: "Second image arrived during startup", requestKey: "image-two", attachments: ["/fixture/second.png"] });
    orchestration.updateLeadOverrides(db, { threadId: thread.id, expectedConfigurationVersion: 1, leadOverrides: { effort: "medium", fastMode: false } });
    gate.resolve();
    await finishing;
    const started = activeTurn(execution.id);
    expect(started.spec).toMatchObject({ attachments: ["/fixture/first.png"], effort: "high", fastMode: true });
    expect(started.spec.prompt).not.toContain(second.body);
    expect(coordinator.status(execution.id).attempts.find((attempt) => attempt.id === admitted.id)).toMatchObject({
      attachments: admitted.attachments,
      settings: admitted.settings,
      configurationVersion: 1,
    });
    await finish(started);
    const next = activeTurn(execution.id);
    expect(next.spec).toMatchObject({ attachments: ["/fixture/second.png"], effort: "medium", fastMode: false });
    expect(next.spec.prompt).toContain(second.body);
    expect(coordinator.status(execution.id).attempts.at(-1)?.configurationVersion).toBe(2);
    coordinator.complete(next.spec.runId, { result: "Both image directions addressed" });
    await finish(next);
    expect(coordinator.status(execution.id).state).toBe("completed");
  });

  it("preserves Astra Max settings for lead and worker turns while retaining the roster", async () => {
    const draft = roster(1);
    for (const member of draft.members.slice(0, 2)) member.settings = { ...member.settings, model: "gpt-6-astra", effort: "max", fastMode: false };
    const execution = await startTeam(draft);
    const lead = activeTurn(execution.id);
    expect(lead.spec.effort).toBe("max");
    await expect(coordinator.validateLeadSettings(thread.id, { effort: "max" })).resolves.toMatchObject({ effort: "max" });
    const instance = orchestration.getInstance(db, thread.id)!;
    expect(orchestration.getRevision(db, instance.teamRevisionId)!.members[0]!.settings.effort).toBe("max");
    const worker = coordinator.dispatch(lead.spec.runId, assignment("engineer"));
    coordinator.wait(lead.spec.runId);
    await finish(lead);
    expect(activeTurn(execution.id, worker.id).spec.effort).toBe("max");
  });

  it.each([4, 5])("uses configured team capacity %i without an implicit provider ceiling across conversations", async (capacity) => {
    const draft = roster(capacity);
    draft.members[2]!.settings = { ...draft.members[1]!.settings };
    for (const key of ["writer", "tester"]) draft.members.push({ ...draft.members[1]!, key, name: key });
    // Configuring one provider must not introduce a default ceiling for another.
    coordinatorHooks.providerLimits = { claude: 0 };
    const execution = await startTeam(draft);
    coordinator.chat(execution.id, { text: "Everyone, reply now", to: draft.members.slice(1).map((member) => member.key), requestKey: "parallel-replies" });
    await coordinator.drain();
    expect(coordinator.status(execution.id).actors.filter((actor) => actor.state === "running")).toHaveLength(capacity);
    expect(coordinator.status(execution.id).actors.filter((actor) => actor.state === "queued")).toHaveLength(5 - capacity);

    const other = await startTeam(roster(), newThread());
    expect(actor(other.id, "lead").state).toBe("running");
    expect([...turns.values()].filter((turn) => !turn.exited && turn.spec.agent === "codex")).toHaveLength(capacity + 1);

    if (capacity === 4) {
      await finish(activeTurn(execution.id, "member:engineer"));
      expect(actor(execution.id, "member:tester").state).toBe("running");
      expect(coordinator.status(execution.id).actors.filter((actor) => actor.state === "running")).toHaveLength(capacity);
    }
  });

  it("denies unknown, cross-instance and retired run authority without changing another execution", async () => {
    const first = await startTeam();
    const secondThread = newThread();
    const secondPath = path.join(directory, "second-thread");
    const baseSha = (await git(root, ["rev-parse", "HEAD"])).stdout.trim();
    await git(root, ["worktree", "add", "--detach", secondPath, baseSha]);
    const isolatedThread = threads.update(db, secondThread.id, { workspaceMode: "worktree", worktreePath: secondPath, branch: null, baseSha });
    const second = await startTeam(roster(), isolatedThread);
    const lead = activeTurn(first.id);
    const foreignLead = activeTurn(second.id);
    const worker = coordinator.dispatch(lead.spec.runId, assignment("engineer"));
    const foreignWorker = coordinator.dispatch(foreignLead.spec.runId, assignment("engineer"));
    await coordinator.drain();
    const before = coordinator.status(second.id);
    expect(() => coordinator.dispatch("unknown-run", assignment("reviewer"))).toThrow();
    expect(() => coordinator.message(lead.spec.runId, { recipientId: foreignWorker.id, text: "Wrong team", requestKey: "cross" })).toThrow();
    expect(() => coordinator.wait(lead.spec.runId, { assignmentIds: [foreignWorker.id] })).toThrow();
    expect(() => coordinator.dispatch(activeTurn(first.id, worker.id).spec.runId, assignment("reviewer"))).toThrow();
    expect(coordinator.status(second.id)).toEqual(before);
    coordinator.wait(lead.spec.runId, { assignmentIds: [worker.id] });
    await finish(lead);
    expect(() => coordinator.dispatch(lead.spec.runId, assignment("reviewer"))).toThrow();
    expect(() => coordinator.complete(lead.spec.runId, { result: "Late completion" })).toThrow();
  });

  it("requires explicit worker completion and retries the same assignment only on user request", async () => {
    const execution = await startTeam();
    const lead = activeTurn(execution.id);
    const worker = coordinator.dispatch(lead.spec.runId, assignment("engineer"));
    coordinator.wait(lead.spec.runId, { assignmentIds: [worker.id] });
    await finish(lead);
    const first = activeTurn(execution.id, worker.id);
    await finish(first, "I probably finished.");
    expect(actor(execution.id, worker.id)).toMatchObject({ state: "attention", result: null });
    expect(coordinator.status(execution.id).messages.filter((message) => message.kind === "result")).toEqual([expect.objectContaining({ body: expect.stringContaining("needs attention") })]);
    const count = turns.size;
    await coordinator.drain();
    expect(turns.size).toBe(count);
    coordinator.retry(execution.id, worker.id);
    await coordinator.drain();
    const second = activeTurn(execution.id, worker.id);
    expect(second.spec.runId).not.toBe(first.spec.runId);
    expect(second.spec.cwd).toBe(first.spec.cwd);
    expect(second.spec.model).toBe(first.spec.model);
    expect(tasks.list(db)).toHaveLength(1);
    expect(() => coordinator.complete(first.spec.runId, { result: "Old process" })).toThrow();
    await finish(second, "Again missing the completion tool.");
    expect(() => coordinator.retry(execution.id, worker.id)).toThrow();
    expect(actor(execution.id, worker.id).state).toBe("attention");
  });

  it("delivers directions in order and fences a completion made before newer direction was delivered", async () => {
    const execution = await startTeam();
    const lead = activeTurn(execution.id);
    const worker = coordinator.dispatch(lead.spec.runId, assignment("engineer"));
    await coordinator.drain();
    const initial = activeTurn(execution.id, worker.id);
    coordinator.complete(initial.spec.runId, { result: "Superseded result" });
    const first = coordinator.message(lead.spec.runId, { recipientId: worker.id, text: "First: include the edge case.", requestKey: "first" });
    const second = coordinator.message(lead.spec.runId, { recipientId: worker.id, text: "Second: verify the regression.", requestKey: "second" });
    expect(() => coordinator.complete(initial.spec.runId, { result: "Cannot acknowledge unseen direction" })).toThrow(/direction/i);
    expect(coordinator.message(lead.spec.runId, { recipientId: worker.id, text: "First: include the edge case.", requestKey: "first" }).id).toBe(first.id);
    expect(() => coordinator.message(lead.spec.runId, { recipientId: worker.id, text: "Different contents", requestKey: "first" })).toThrow();
    coordinator.wait(lead.spec.runId, { assignmentIds: [worker.id] });
    await finish(lead);
    await finish(initial);
    expect(actor(execution.id, worker.id).state).not.toBe("completed");
    const updated = activeTurn(execution.id, worker.id);
    expect(updated.spec.prompt.indexOf(first.body)).toBeGreaterThanOrEqual(0);
    expect(updated.spec.prompt.indexOf(second.body)).toBeGreaterThan(updated.spec.prompt.indexOf(first.body));
    const current = actor(execution.id, worker.id);
    expect(current.deliveredVersion).toBe(current.directionVersion);
    expect(current.directionVersion).toBeGreaterThan(0);
    coordinator.complete(updated.spec.runId, { result: "Updated result" });
    await finish(updated);
    const state = coordinator.status(execution.id);
    expect(state.messages.filter((message) => [first.id, second.id].includes(message.id))).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: first.id, state: "delivered" }), expect.objectContaining({ id: second.id, state: "delivered" })]),
    );
    expect(state.messages.filter((message) => message.kind === "result" && message.senderId === worker.id)).toHaveLength(1);
    expect(activeTurn(execution.id).spec.prompt).toContain("Updated result");
    expect(activeTurn(execution.id).spec.prompt).not.toContain("Superseded result");
  });

  it("retains a writer's slot after a close timeout and prevents retry until the process exits", async () => {
    coordinatorHooks.closeTimeoutMs = 10;
    const execution = await startTeam(roster(1));
    const lead = activeTurn(execution.id);
    const first = coordinator.dispatch(lead.spec.runId, assignment("engineer"));
    const second = coordinator.dispatch(lead.spec.runId, assignment("reviewer"));
    coordinator.wait(lead.spec.runId, { assignmentIds: [first.id, second.id] });
    await finish(lead);
    const writer = activeTurn(execution.id, first.id);
    writer.closeBlocked = true;
    coordinator.complete(writer.spec.runId, { result: "Process has not exited yet" });
    await finish(writer);
    expect(actor(execution.id, first.id).state).toBe("attention");
    expect(actor(execution.id, second.id).state).toBe("queued");
    expect(runService.isLive(writer.spec.runId)).toBe(true);
    expect(() => coordinator.retry(execution.id, first.id)).toThrow(/clos|writer/i);
    expect(turns.size).toBe(2);
    writer.exit();
    await runService.closeAndWait(writer.spec.runId);
    await coordinator.stop(execution.id);
    expect(coordinator.status(execution.id).state).toBe("stopped");
  });

  it("stops active and queued actors, denies pending approval and ignores late provider completion", async () => {
    const execution = await startTeam();
    const lead = activeTurn(execution.id);
    const worker = coordinator.dispatch(lead.spec.runId, assignment("reviewer"));
    await coordinator.drain();
    const workerTurn = activeTurn(execution.id, worker.id);
    const approval = runService.requestApproval(workerTurn.spec.runId, "pending", "Bash", { command: "true" });
    coordinator.complete(workerTurn.spec.runId, { result: "Result racing with stop" });
    await coordinator.stop(execution.id);
    await expect(approval).resolves.toEqual({ decision: "deny" });
    const stopped = coordinator.status(execution.id);
    expect(stopped.state).toBe("stopped");
    expect([...turns.values()].every((turn) => turn.exited)).toBe(true);
    workerTurn.handle.emit("event", { type: "turn.completed", runId: workerTurn.spec.runId, ts: Date.now(), turnId: "late", status: "success", durationMs: 1 });
    await coordinator.drain();
    expect(coordinator.status(execution.id)).toEqual(stopped);
    expect(() => coordinator.complete(workerTurn.spec.runId, { result: "Late tool" })).toThrow();
    expect(stopped.messages.filter((message) => message.kind === "result")).toEqual([]);
  });

  it("retains attention after stopping a partial publication until an explicit retry recovers it", async () => {
    const execution = await startTeam();
    const lead = activeTurn(execution.id);
    let needsRecovery = true;
    const beforeStart = vi.fn(async () => {
      needsRecovery = false;
    });
    const assertStopped = vi.fn(() => {
      expect(runService.isLive(lead.spec.runId)).toBe(false);
      if (needsRecovery) throw new Error("Partial publication needs explicit recovery");
    });
    coordinatorHooks.workspace = { beforeStart, captureOutput: async () => {}, assertStopped };

    await expect(coordinator.stop(execution.id)).rejects.toThrow("Partial publication needs explicit recovery");
    await coordinator.drain();
    expect(coordinator.status(execution.id)).toMatchObject({ state: "attention", error: "Partial publication needs explicit recovery" });
    expect(actor(execution.id, "lead")).toMatchObject({ state: "attention", error: "Partial publication needs explicit recovery" });
    expect(assertStopped).toHaveBeenCalledWith(execution.id);
    expect(beforeStart).not.toHaveBeenCalled();
    expect(turns.size).toBe(1);
    expect(() => coordinator.complete(lead.spec.runId, { result: "Stale writer result" })).toThrow();

    coordinator.retry(execution.id, "lead");
    await coordinator.drain();
    expect(beforeStart).toHaveBeenCalledWith(execution.id, "lead", expect.any(Function));
    expect(activeTurn(execution.id).spec.runId).not.toBe(lead.spec.runId);
    await coordinator.stop(execution.id);
    expect(coordinator.status(execution.id)).toMatchObject({ state: "stopped", error: null });
  });

  it("coalesces concurrent stop requests behind the same preparation barrier and generation fence", async () => {
    const execution = await startTeam();
    const lead = activeTurn(execution.id);
    const gate = deferred();
    const entered = deferred();
    const normalPrepare = preparing.getMockImplementation()!;
    preparing.mockImplementationOnce(async (task, assertActive) => {
      entered.resolve();
      await gate.promise;
      assertActive();
      return normalPrepare(task, assertActive);
    });
    const worker = coordinator.dispatch(lead.spec.runId, assignment("engineer"));
    await entered.promise;
    const first = coordinator.stop(execution.id);
    const second = coordinator.stop(execution.id);
    const fenced = coordinator.status(execution.id);
    expect(fenced.state).toBe("stopping");
    expect(fenced.generation).toBe(execution.generation + 1);
    gate.resolve();
    await Promise.all([first, second]);
    await coordinator.drain();
    expect(coordinator.status(execution.id)).toMatchObject({ state: "stopped", generation: fenced.generation });
    expect(actor(execution.id, worker.id).state).toBe("cancelled");
    expect(turns.size).toBe(1);
    expect(runs.listForTask(db, worker.taskId!)).toEqual([]);
    await coordinator.stop(execution.id);
    expect(coordinator.status(execution.id).generation).toBe(fenced.generation);
  });

  it("keeps a timed-out preparation's provider reservation until preparation actually settles", async () => {
    coordinatorHooks.closeTimeoutMs = 20;
    coordinatorHooks.providerLimits = { codex: 1 };
    const execution = await startTeam(roster(1));
    const lead = activeTurn(execution.id);
    const gate = deferred();
    const entered = deferred();
    const normalPrepare = preparing.getMockImplementation()!;
    preparing.mockImplementationOnce(async (task, assertActive) => {
      entered.resolve();
      await gate.promise;
      assertActive();
      return normalPrepare(task, assertActive);
    });
    const worker = coordinator.dispatch(lead.spec.runId, assignment("engineer"));
    coordinator.wait(lead.spec.runId, { assignmentIds: [worker.id] });
    const finishing = finish(lead);
    await entered.promise;
    try {
      const secondThread = newThread();
      const saved = orchestration.save(db, { projectId: project.id, expectedRevisionId: null, draft: roster() });
      const second = await coordinator.start({ threadId: secondThread.id, teamRevisionId: saved.revision.id, prompt: "Wait for provider capacity" });
      await expect(coordinator.stop(execution.id)).rejects.toThrow(/preparation|closing|writer/i);
      expect(coordinator.status(execution.id).state).toBe("attention");
      coordinator.steer(second.id, { text: "Recheck admission while the other preparation is still pending", requestKey: "recheck" });
      // Let the admission microtask run without awaiting the intentionally blocked preparation.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(actor(second.id, "lead").state).toBe("queued");
      expect(turns.size).toBe(1);
      gate.resolve();
      await finishing;
      await coordinator.drain();
      expect(activeTurn(second.id).spec.agent).toBe("codex");
      expect(runs.listForTask(db, worker.taskId!)).toEqual([]);
    } finally {
      gate.resolve();
      await finishing;
    }
  });

  it("fences all writers on shutdown and leaves interrupted work requiring explicit recovery", async () => {
    const execution = await startTeam();
    const lead = activeTurn(execution.id);
    const worker = coordinator.dispatch(lead.spec.runId, assignment("engineer"));
    await coordinator.drain();
    const workerTurn = activeTurn(execution.id, worker.id);
    const before = coordinator.status(execution.id);
    await coordinator.shutdown();
    const interrupted = coordinator.status(execution.id);
    expect(interrupted.state).toBe("attention");
    expect(interrupted.generation).toBeGreaterThan(before.generation);
    expect(interrupted.actors.filter((current) => !current.participant).every((current) => current.state === "attention")).toBe(true);
    expect(interrupted.actors.filter((current) => current.participant).every((current) => current.state === "waiting")).toBe(true);
    expect([...turns.values()].every((turn) => turn.exited)).toBe(true);
    expect(() => coordinator.complete(workerTurn.spec.runId, { result: "Late shutdown result" })).toThrow();
    expect(() => coordinator.dispatch(lead.spec.runId, assignment("reviewer"))).toThrow();
    await coordinator.drain();
    expect(turns.size).toBe(2);
    expect(coordinator.status(execution.id).messages.filter((message) => message.kind === "result")).toEqual([]);
  });

  it("rejects admission that was still validating when shutdown began", async () => {
    const gate = deferred();
    const entered = deferred();
    coordinatorHooks.validate = async () => {
      entered.resolve();
      await gate.promise;
    };
    const saved = orchestration.save(db, { projectId: project.id, expectedRevisionId: null, draft: roster() });
    const input = { threadId: thread.id, teamRevisionId: saved.revision.id, prompt: "Admission racing with shutdown" };
    const starting = coordinator.start(input);
    await entered.promise;
    const closed = coordinator.shutdown();
    gate.resolve();
    await expect(starting).rejects.toThrow(/clos|shut/i);
    await closed;
    await coordinator.drain();
    expect(orchestration.getInstance(db, thread.id)).toBeNull();
    expect(turns.size).toBe(0);
    await expect(coordinator.start(input)).rejects.toThrow(/clos|shut/i);
  });

  it("recovers interrupted execution as attention with revoked run authority and no automatic replay", async () => {
    const execution = await startTeam();
    const lead = activeTurn(execution.id);
    const worker = coordinator.dispatch(lead.spec.runId, assignment("engineer"));
    await coordinator.drain();
    const originalRun = activeTurn(execution.id, worker.id).spec.runId;
    const pending = coordinator.message(lead.spec.runId, { recipientId: worker.id, text: "Keep this instruction after restart", requestKey: "persistent" });
    const before = coordinator.status(execution.id);
    coordinator = new TeamCoordinator(db, runService, coordinatorHooks);
    coordinator.recover();
    await coordinator.drain();
    const recovered = coordinator.status(execution.id);
    expect(recovered.state).toBe("attention");
    expect(recovered.generation).toBeGreaterThan(before.generation);
    expect(recovered.messages.find((message) => message.id === pending.id)?.body).toBe(pending.body);
    expect(turns.size).toBe(2);
    expect(coordinator.binding(originalRun)?.generation).toBeLessThan(recovered.generation);
    expect(() => coordinator.complete(originalRun, { result: "Old process still answering" })).toThrow();
    for (const turn of turns.values()) turn.exit();
    await runService.closeAll();
    await coordinator.drain();
    expect(coordinator.status(execution.id).state).toBe("attention");
    expect(coordinator.status(execution.id).messages.filter((message) => message.kind === "result")).toEqual([]);
  });
});

describe("saved task coordination", () => {
  const reserveInput = (taskId: string, requestKey = "saved-once") => ({
    taskId,
    memberKey: "engineer",
    requestKey,
    input: { title: "Accepted title", spec: "Accepted immutable instructions", attachments: ["/fixture/accepted.png"] },
  });

  it("reserves saved input exactly once without replacing the task document and rejects foreign ownership", async () => {
    const execution = await startTeam();
    const lead = activeTurn(execution.id);
    const saved = tasks.insert(db, {
      projectId: project.id,
      threadId: thread.id,
      title: "Editable task title",
      spec: "Editable task body",
      status: "backlog",
      priority: "high",
      labels: ["preserve"],
      workspaceMode: "worktree",
      baseRef: "main",
      parentTaskId: null,
      origin: "user",
    });
    const foreign = tasks.insert(db, {
      projectId: project.id,
      threadId: newThread().id,
      title: "Foreign",
      spec: "Foreign",
      priority: "none",
      labels: [],
      workspaceMode: "worktree",
      baseRef: null,
      parentTaskId: null,
    });
    expect(() => coordinator.reserveTask(lead.spec.runId, reserveInput(foreign.id, "foreign"))).toThrow(/thread/);
    expect(() => coordinator.reserveTask(lead.spec.runId, { ...reserveInput(saved.id), memberKey: "missing" })).toThrow(/direct reports/);
    const input = reserveInput(saved.id);
    const worker = coordinator.reserveTask(lead.spec.runId, input);
    expect(coordinator.reserveTask(lead.spec.runId, input)).toEqual(worker);
    expect(() => coordinator.reserveTask(lead.spec.runId, { ...input, input: { ...input.input, spec: "Changed accepted input" } })).toThrow(/different work/);
    expect(tasks.get(db, saved.id)).toEqual(saved);
    expect(coordinator.status(execution.id).actors.filter((item) => !item.participant)).toHaveLength(2);
    expect(worker.input).toMatchObject(input.input);
    coordinator.wait(lead.spec.runId);
    await finish(lead);
    const turn = activeTurn(execution.id, worker.id);
    expect(turn.spec.prompt).toBe(input.input.spec);
    expect(turn.spec.attachments).toEqual(input.input.attachments);
    expect(turn.spec.resumeSessionId).toBeUndefined();
  });

  it("does not reuse a terminal task before its settlement and physical writer barriers clear", async () => {
    const execution = await startTeam();
    const lead = activeTurn(execution.id);
    const worker = coordinator.dispatch(lead.spec.runId, assignment("engineer"));
    await coordinator.drain();
    const turn = activeTurn(execution.id, worker.id);
    let blocked = "";
    coordinatorHooks.tasks = {
      instructions: () => "",
      completionReason: () => null,
      settled(record, owner) {
        if (owner.id !== worker.id) return;
        expect(teamRuntime.get(db, record.id)?.actors.find((item) => item.id === owner.id)?.state).toBe("completed");
        try {
          coordinator.reserveTask(lead.spec.runId, reserveInput(worker.taskId!));
        } catch (error) {
          blocked = String(error);
        }
      },
    };
    coordinator.complete(turn.spec.runId, { result: "Original assignment complete" });
    await finish(turn);
    expect(blocked).toMatch(/preparation and writers/);
    expect(coordinator.status(execution.id).actors.filter((item) => !item.participant)).toHaveLength(2);
    const isLive = runService.isLive.bind(runService);
    const live = vi.spyOn(runService, "isLive").mockImplementation((id) => id === turn.spec.runId || isLive(id));
    expect(() => coordinator.reserveTask(lead.spec.runId, reserveInput(worker.taskId!))).toThrow(/writers/);
    live.mockRestore();
    const next = coordinator.reserveTask(lead.spec.runId, reserveInput(worker.taskId!));
    expect(next.id).not.toBe(worker.id);
    expect(next.taskId).toBe(worker.taskId);
    expect(teamRuntime.assignmentsForTask(db, worker.taskId!)).toHaveLength(2);
  });

  it("steers only the exact active actor and retains immutable image direction", async () => {
    const execution = await startTeam();
    const lead = activeTurn(execution.id);
    const worker = coordinator.dispatch(lead.spec.runId, assignment("engineer"));
    coordinator.wait(lead.spec.runId);
    await finish(lead);
    const turn = activeTurn(execution.id, worker.id);
    const input = { text: "Address this selected feedback", requestKey: "selected-feedback", attachments: ["/fixture/comment.png"] };
    const message = coordinator.steerActor(execution.id, worker.id, input);
    expect(coordinator.steerActor(execution.id, worker.id, input)).toEqual(message);
    expect(() => coordinator.steerActor(execution.id, "lead", input)).toThrow(/different direction/);
    expect(() => coordinator.steerActor(execution.id, "other-actor", { ...input, requestKey: "foreign" })).toThrow(/recipient/);
    expect(() => coordinator.complete(turn.spec.runId, { result: "Too early" })).toThrow(/New direction/);
    await finish(turn);
    const resumed = activeTurn(execution.id, worker.id);
    expect(resumed.spec.prompt).toContain(input.text);
    expect(resumed.spec.attachments).toEqual(input.attachments);
    coordinator.complete(resumed.spec.runId, { result: "Feedback addressed" });
    await finish(resumed);
    expect(() => coordinator.steerActor(execution.id, worker.id, { text: "Later work", requestKey: "later" })).toThrow(/no longer accepts/);
  });

  it("required task admissions gate explicit and implicit lead completion", async () => {
    let required = true;
    const settled = vi.fn();
    const captureOutput = vi.fn(async () => {});
    coordinatorHooks.workspace = { beforeStart: async () => {}, captureOutput };
    coordinatorHooks.tasks = { instructions: () => "PENDING_TASK_INSTRUCTIONS", completionReason: () => (required ? "Required saved tasks are unresolved." : null), settled };
    const execution = await startTeam();
    const lead = activeTurn(execution.id);
    expect(lead.spec.systemPromptAppendix).toContain("PENDING_TASK_INSTRUCTIONS");
    expect(() => coordinator.complete(lead.spec.runId, { result: "Premature" })).toThrow(/Required saved tasks/);
    await finish(lead);
    expect(actor(execution.id, "lead")).toMatchObject({ state: "attention", error: "Required saved tasks are unresolved." });
    expect(coordinator.status(execution.id).attempts[0]).toMatchObject({ state: "closed", endedAt: expect.any(Number), snapshotId: expect.any(String) });
    expect(captureOutput).not.toHaveBeenCalled();
    required = false;
    coordinator.retry(execution.id, "lead");
    await coordinator.drain();
    const retried = activeTurn(execution.id);
    coordinator.complete(retried.spec.runId, { result: "Accepted tasks complete" });
    await finish(retried);
    expect(coordinator.status(execution.id).state).toBe("completed");
    expect(settled).toHaveBeenCalledTimes(2);
    expect(captureOutput).toHaveBeenCalledTimes(1);
  });

  it("rechecks required admissions after asynchronous output capture", async () => {
    const gate = deferred();
    const entered = deferred();
    let required = false;
    coordinatorHooks.workspace = {
      beforeStart: async () => {},
      captureOutput: async () => {
        entered.resolve();
        await gate.promise;
      },
    };
    coordinatorHooks.tasks = { instructions: () => "", completionReason: () => (required ? "New required task arrived." : null), settled: vi.fn() };
    const execution = await startTeam();
    const lead = activeTurn(execution.id);
    coordinator.complete(lead.spec.runId, { result: "Initially complete" });
    const finishing = finish(lead);
    await entered.promise;
    required = true;
    gate.resolve();
    await finishing;
    expect(coordinator.status(execution.id).state).toBe("attention");
    expect(actor(execution.id, "lead").error).toBe("New required task arrived.");
  });

  it("rolls back a failed task receipt hook while retaining closed turn evidence for explicit retry", async () => {
    const execution = await startTeam();
    const lead = activeTurn(execution.id);
    const worker = coordinator.dispatch(lead.spec.runId, assignment("engineer"));
    coordinator.wait(lead.spec.runId);
    await finish(lead);
    let reject = true;
    coordinatorHooks.tasks = {
      instructions: () => "",
      completionReason: () => null,
      settled(record, owner, attempt) {
        if (owner.id !== worker.id) return;
        expect(teamRuntime.get(db, record.id)?.attempts.find((item) => item.id === attempt.id)?.state).toBe("closed");
        expect(owner.state).toBe("completed");
        audit.record(db, { actor: "user", action: "fixture.task.receipt", resourceType: "task", resourceId: owner.taskId!, metadata: { attemptId: attempt.id } });
        if (reject) throw new Error("Receipt persistence failed");
      },
    };
    const turn = activeTurn(execution.id, worker.id);
    coordinator.complete(turn.spec.runId, { result: "Worker output complete" });
    await finish(turn);
    const failed = coordinator.status(execution.id);
    expect(failed.actors.find((item) => item.id === worker.id)).toMatchObject({ state: "attention", error: expect.stringContaining("Receipt persistence failed") });
    expect(failed.attempts.find((item) => item.runId === turn.spec.runId)).toMatchObject({ state: "closed", snapshotId: expect.any(String), endedAt: expect.any(Number) });
    expect(failed.messages.filter((message) => message.dedupeKey.startsWith(`result:${worker.id}:`))).toEqual([]);
    expect(db.stmt("SELECT 1 FROM audit_events WHERE action = 'fixture.task.receipt'").all()).toEqual([]);
    reject = false;
    coordinator.retry(execution.id, worker.id);
    await coordinator.drain();
    const retry = activeTurn(execution.id, worker.id);
    coordinator.complete(retry.spec.runId, { result: "Receipt and output complete" });
    await finish(retry);
    expect(actor(execution.id, worker.id).state).toBe("completed");
    expect(db.stmt("SELECT 1 FROM audit_events WHERE action = 'fixture.task.receipt'").all()).toHaveLength(1);
    expect(coordinator.status(execution.id).messages.filter((message) => message.dedupeKey.startsWith(`result:${worker.id}:`))).toHaveLength(1);
  });

  it("does not apply task settlement side effects from a revoked Stop callback", async () => {
    const settled = vi.fn();
    coordinatorHooks.tasks = { instructions: () => "", completionReason: () => null, settled };
    const execution = await startTeam();
    const turn = activeTurn(execution.id);
    await coordinator.stop(execution.id);
    await coordinator.drain();
    const run = runs.get(db, turn.spec.runId)!;
    coordinator.onTurnSettled(run, { task: null, thread: threads.get(db, thread.id)! }, project, { status: "cancelled", snapshotId: null, error: null });
    await coordinator.drain();
    expect(settled).not.toHaveBeenCalled();
    expect(coordinator.status(execution.id).state).toBe("stopped");
  });
});

describe("durable team context boundaries", () => {
  it.each(["codex", "claude"] as const)("starts %s fresh after compaction, then resumes only the new epoch across executions", async (agent) => {
    const draft = roster();
    draft.members[0]!.settings = { ...draft.members.find((member) => member.settings.agent === agent)!.settings };
    const first = await startTeam(draft);
    const old = activeTurn(first.id);
    old.handle.emit("event", { type: "thinking.completed", runId: old.spec.runId, ts: Date.now(), messageId: "private", text: "HIDDEN_REASONING_SENTINEL" });
    ledger.push({ type: "message.completed", runId: old.spec.runId, ts: Date.now(), messageId: "internal", role: "system", text: "INTERNAL_PROMPT_SENTINEL" });
    await finish(old, "Public first result.");
    ledger.flush();
    const count = turns.size;
    const checkpoint = coordinator.compact(thread.id, "compact-one");
    expect(turns.size).toBe(count);
    expect(checkpoint.seed).toContain("Implement and review the requested change.");
    expect(checkpoint.seed).toContain("Public first result.");
    expect(checkpoint.seed).not.toContain("HIDDEN_REASONING_SENTINEL");
    expect(checkpoint.seed).not.toContain("INTERNAL_PROMPT_SENTINEL");
    const next = await coordinator.start({ threadId: thread.id, prompt: "Second original instruction." });
    await coordinator.drain();
    const fresh = activeTurn(next.id);
    expect(fresh.spec.resumeSessionId).toBeUndefined();
    expect(fresh.spec.systemPromptAppendix).toContain(checkpoint.id);
    expect(fresh.spec.systemPromptAppendix).toContain("Implement and review the requested change.");
    expect(coordinator.compact(thread.id, "compact-one")).toEqual(checkpoint);
    coordinator.wait(fresh.spec.runId);
    await finish(fresh);
    coordinator.steer(next.id, { text: "A later direction.", requestKey: "later" });
    await coordinator.drain();
    const resumed = activeTurn(next.id);
    expect(resumed.spec.resumeSessionId).toBe(`session-${fresh.spec.runId}`);
    const reserved = coordinator.status(next.id).attempts.at(-1)!;
    expect(reserved).toMatchObject({ contextCheckpointId: checkpoint.id, contextSessionId: `session-${fresh.spec.runId}` });
    expect(reserved.contextSeed).toBeUndefined();
    await finish(resumed);
    const third = await coordinator.start({ threadId: thread.id, prompt: "Third original instruction." });
    await coordinator.drain();
    const continued = activeTurn(third.id);
    expect(continued.spec.resumeSessionId).toBe(`session-${resumed.spec.runId}`);
    await finish(continued);
    const secondCheckpoint = coordinator.compact(thread.id, "compact-two");
    expect(secondCheckpoint.epoch).toBe(2);
    expect(secondCheckpoint.seed).toContain("Implement and review the requested change.");
    expect(secondCheckpoint.seed).toContain("Second original instruction.");
    expect(secondCheckpoint.seed).toContain("Third original instruction.");
    expect(secondCheckpoint.seed).toContain("A later direction.");
    const audits = db.stmt("SELECT metadata FROM audit_events WHERE action = 'team.context.compact'").all() as { metadata: string }[];
    expect(audits).toHaveLength(2);
    expect(audits.every((row) => !row.metadata.includes("seed") && !row.metadata.includes("original instruction"))).toBe(true);
  });

  it("never falls back to a lost session after fresh startup fails and the database reopens", async () => {
    const draft = roster();
    draft.limits.maxAttemptsPerAssignment = 5;
    const execution = await startTeam(draft);
    const old = activeTurn(execution.id);
    await fail(old);
    rejectStart = () => "Fresh process could not start.";
    coordinator.retry(execution.id, "lead", { fresh: true, requestKey: "fresh-once" });
    await coordinator.drain();
    expect(actor(execution.id, "lead").state).toBe("attention");
    const checkpoint = teamContexts.listForInstance(db, execution.instanceId)[0]!;
    expect(coordinator.status(execution.id).attempts.at(-1)).toMatchObject({ contextCheckpointId: checkpoint.id, contextSeed: expect.stringContaining(execution.actors[0]!.input.spec) });
    const attempts = coordinator.status(execution.id).attempts.length;
    coordinator.retry(execution.id, "lead", { fresh: true, requestKey: "fresh-once" });
    expect(coordinator.status(execution.id).attempts).toHaveLength(attempts);
    ledger.close();
    db.close();
    db = Db.open(path.join(directory, "fixture.sqlite"));
    ledger = new LedgerWriter(db);
    runService = makeRunService();
    coordinator = new TeamCoordinator(db, runService, coordinatorHooks);
    coordinator.recover();
    rejectStart = null;
    coordinator.retry(execution.id, "lead");
    await coordinator.drain();
    const recovered = activeTurn(execution.id);
    expect(recovered.spec.resumeSessionId).toBeUndefined();
    expect(recovered.spec.systemPromptAppendix).toContain(checkpoint.id);
    await finish(recovered);
    coordinator.retry(execution.id, "lead", { fresh: true, requestKey: "fresh-once" });
    expect(coordinator.status(execution.id).state).toBe("completed");
    expect(db.stmt("SELECT 1 FROM audit_events WHERE action = 'team.context.fresh_retry'").all()).toHaveLength(1);
    const next = await coordinator.start({ threadId: thread.id, prompt: "Next execution" });
    await coordinator.drain();
    expect(() => coordinator.retry(next.id, "lead", { fresh: true, requestKey: "fresh-once" })).toThrow(/different operation/);
    expect(() => coordinator.compact(thread.id, "fresh-once")).toThrow(/different operation/);
  });

  it("rebuilds an unused checkpoint with pending direction after Stop and fixes the seed before asynchronous preparation", async () => {
    const execution = await startTeam();
    await fail(activeTurn(execution.id));
    rejectStart = () => "No provider process yet";
    coordinator.retry(execution.id, "lead", { fresh: true, requestKey: "unused" });
    await coordinator.drain();
    coordinator.steer(execution.id, { text: "Keep this accepted but undelivered requirement.", requestKey: "pending" });
    await coordinator.stop(execution.id);
    await coordinator.drain();
    rejectStart = null;
    const gate = deferred();
    coordinatorHooks.workspace = { beforeStart: async () => gate.promise, captureOutput: async () => {} };
    const next = await coordinator.start({ threadId: thread.id, prompt: "New execution original instruction." });
    await vi.waitFor(() => expect(coordinator.status(next.id).attempts).toHaveLength(1));
    const reserved = coordinator.status(next.id).attempts[0]!;
    expect(reserved.contextSeed).toContain("Implement and review the requested change.");
    expect(reserved.contextSeed).toContain("Keep this accepted but undelivered requirement.");
    expect(reserved.contextSeed).toContain("New execution original instruction.");
    const message = coordinator.steer(next.id, { text: "Arrived after reservation.", requestKey: "during-prep" });
    gate.resolve();
    await coordinator.drain();
    const fresh = activeTurn(next.id);
    expect(fresh.spec.resumeSessionId).toBeUndefined();
    expect(fresh.spec.systemPromptAppendix).toContain("Keep this accepted but undelivered requirement.");
    expect(fresh.spec.systemPromptAppendix).not.toContain("Arrived after reservation.");
    expect(coordinator.status(next.id).attempts[0]!.contextSeed).toBe(reserved.contextSeed);
    expect(coordinator.status(next.id).messages.find((item) => item.id === message.id)?.state).toBe("pending");
    await finish(fresh);
    const following = activeTurn(next.id);
    expect(following.spec.resumeSessionId).toBe(`session-${fresh.spec.runId}`);
    expect(following.spec.prompt).toContain("Arrived after reservation.");
    await finish(following);
  });

  it("freshly recovers a manager without creating children again or acknowledging a result twice", async () => {
    const { execution, manager, worker, workerTurn } = await nestedWorking();
    coordinator.complete(workerTurn.spec.runId, { result: "Child verified the implementation." });
    await finish(workerTurn);
    const failedManager = activeTurn(execution.id, manager.id);
    expect(failedManager.spec.prompt).toContain("Child verified the implementation.");
    await fail(failedManager);
    const messages = coordinator.status(execution.id).messages.filter((message) => message.recipientId === manager.id && message.kind === "result");
    expect(messages).toHaveLength(1);
    expect(messages[0]!.state).toBe("claimed");
    const informedLead = activeTurn(execution.id);
    coordinator.wait(informedLead.spec.runId, { assignmentIds: [manager.id] });
    await finish(informedLead);
    coordinator.retry(execution.id, manager.id, { fresh: true, requestKey: "manager-fresh" });
    await coordinator.drain();
    const fresh = activeTurn(execution.id, manager.id);
    expect(fresh.spec.resumeSessionId).toBeUndefined();
    expect(fresh.spec.prompt).toContain(manager.input.spec);
    expect(fresh.spec.prompt).toContain("Child verified the implementation.");
    expect(fresh.spec.systemPromptAppendix).toContain(`"id":"${worker.id}"`);
    expect(fresh.spec.systemPromptAppendix).toContain('"state":"completed"');
    expect(coordinator.dispatch(fresh.spec.runId, assignment("reviewer")).id).toBe(worker.id);
    expect(tasks.list(db)).toHaveLength(2);
    coordinator.complete(fresh.spec.runId, { result: "Manager reconciled the existing child." });
    await finish(fresh);
    expect(coordinator.status(execution.id).messages.filter((message) => message.recipientId === manager.id && message.kind === "result")).toEqual([
      expect.objectContaining({ id: messages[0]!.id, state: "delivered" }),
    ]);
    const lead = activeTurn(execution.id);
    coordinator.complete(lead.spec.runId, { result: "Complete." });
    await finish(lead);
    expect(coordinator.status(execution.id).state).toBe("completed");
  });

  it("stores oversized canonical history outside the seed verbatim and keeps it readable during a turn", async () => {
    const execution = await startTeam();
    const direction = "漢".repeat(24_000);
    coordinator.steer(execution.id, { text: direction, requestKey: "large-required-direction" });
    await fail(activeTurn(execution.id));
    coordinator.retry(execution.id, "lead", { fresh: true, requestKey: "large-fresh" });
    await coordinator.drain();
    const [checkpoint] = teamContexts.listForInstance(db, execution.instanceId);
    expect(Buffer.byteLength(checkpoint!.seed)).toBeLessThanOrEqual(MAX_TEAM_CONTEXT_BYTES);
    const seed = JSON.parse(checkpoint!.seed) as { storedText: string; canonical: { originalInstruction: string; directions: { count: number; stored: string; bytes: number; preview: string } }[] };
    expect(seed.storedText).toMatch(/team_context/);
    expect(seed.canonical[0]!.originalInstruction).toBe("Implement and review the requested change.");
    const stored = seed.canonical[0]!.directions;
    expect(stored).toMatchObject({ count: 1, stored: expect.stringMatching(/^[0-9a-f]{64}$/), preview: expect.stringContaining("漢") });
    const fresh = activeTurn(execution.id);
    expect(fresh.spec.systemPromptAppendix).toMatch(/read them with team_context/);
    expect(fresh.spec.systemPromptAppendix).toContain(stored.stored);
    const part = coordinator.contextPart(fresh.spec.runId, stored.stored);
    expect(part.bytes).toBe(stored.bytes);
    expect(JSON.parse(part.text)).toEqual([expect.objectContaining({ senderId: "user", text: direction })]);
    expect(() => coordinator.contextPart(fresh.spec.runId, "0".repeat(64))).toThrow(/belongs to your team/);
    // Later rebuilds store the direction again only because its delivery state changed; the text itself is unchanged.
    await coordinator.stop(execution.id);
    const compacted = coordinator.compact(thread.id, "large-compact");
    const again = (JSON.parse(compacted.seed) as typeof seed).canonical[0]!.directions;
    expect(again.stored).not.toBe(stored.stored);
    expect(JSON.parse(teamContextParts.get(db, execution.instanceId, again.stored)!.content)).toEqual([expect.objectContaining({ text: direction })]);
    expect(db.stmt("SELECT COUNT(*) AS n FROM team_context_parts WHERE instance_id = ?").get(execution.instanceId)).toEqual({ n: 2 });
    expect(teamContexts.listForInstance(db, execution.instanceId)).toHaveLength(2);
    expect(() => coordinator.contextPart(fresh.spec.runId, stored.stored)).toThrow(/authority/);
  });

  it("notifies availability after closing barriers and refuses context changes while preparation is pending", async () => {
    const execution = await startTeam();
    const availability: boolean[] = [];
    coordinatorHooks.changed = () => availability.push(coordinator.retryAvailability(execution.id, "lead").allowed);
    await fail(activeTurn(execution.id));
    expect(availability).toContain(false);
    expect(availability.at(-1)).toBe(true);
    const gate = deferred();
    coordinatorHooks.workspace = { beforeStart: async () => gate.promise, captureOutput: async () => {} };
    coordinator.retry(execution.id, "lead", { fresh: true, requestKey: "barrier-fresh" });
    await vi.waitFor(() => expect(actor(execution.id, "lead").state).toBe("starting"));
    expect(() => coordinator.compact(thread.id, "during-prep")).toThrow(/Finish or stop/);
    const stopping = coordinator.stop(execution.id);
    expect(() => coordinator.retry(execution.id, "lead", { fresh: true, requestKey: "during-stop" })).toThrow(/stop operation/);
    expect(teamContexts.listForInstance(db, execution.instanceId)).toHaveLength(1);
    gate.resolve();
    await stopping;
    await coordinator.drain();
    expect(coordinator.compactAvailability(thread.id)).toEqual({ allowed: true, reason: null });
  });
});

describe("cancelling unreserved team direction", () => {
  it.each(["claude"] as const)("preserves %s completion intent after late direction is cancelled without another turn", async (agent) => {
    const draft = roster();
    draft.members[0]!.settings = { ...draft.members.find((member) => member.settings.agent === agent)!.settings };
    const execution = await startTeam(draft);
    const lead = activeTurn(execution.id);
    const captureOutput = vi.fn(async () => {});
    coordinatorHooks.workspace = { beforeStart: async () => {}, captureOutput };
    coordinator.complete(lead.spec.runId, { result: "Original work complete." });
    const direction = coordinator.steer(execution.id, { text: "Withdraw this late instruction.", attachments: ["/cancelled.png"], requestKey: "late" });
    expect(() => coordinator.complete(lead.spec.runId, { result: "Premature completion" })).toThrow(/New direction/);
    const version = actor(execution.id, "lead").directionVersion;
    const cancelled = coordinator.cancelDirection(execution.id, direction.id);
    expect(cancelled).toMatchObject({ state: "cancelled", body: direction.body, attachments: direction.attachments, cancelledAt: expect.any(Number) });
    expect(coordinator.cancelDirection(execution.id, direction.id)).toEqual(cancelled);
    expect(coordinator.steer(execution.id, { text: direction.body, attachments: direction.attachments, requestKey: "late" })).toEqual(cancelled);
    expect(actor(execution.id, "lead").directionVersion).toBe(version);
    await finish(lead);
    expect(coordinator.status(execution.id).state).toBe("completed");
    expect(actor(execution.id, "lead").result).toBe("Original work complete.");
    expect(turns.size).toBe(1);
    expect(captureOutput).toHaveBeenCalledTimes(1);
    expect(db.stmt("SELECT metadata FROM audit_events WHERE action = 'team.direction.cancel'").all()).toEqual([{ metadata: JSON.stringify({ executionId: execution.id, messageId: direction.id }) }]);
  });

  it("keeps surviving direction authoritative and never sends cancelled text or images", async () => {
    const execution = await startTeam();
    const lead = activeTurn(execution.id);
    coordinator.complete(lead.spec.runId, { result: "Before revisions" });
    const cancelled = coordinator.steer(execution.id, { text: "CANCELLED_ONLY_SENTINEL", attachments: ["/cancelled-only.png"], requestKey: "cancel" });
    const retained = coordinator.steer(execution.id, { text: "Keep this accepted direction.", attachments: ["/retained.png"], requestKey: "keep" });
    coordinator.cancelDirection(execution.id, cancelled.id);
    expect(() => coordinator.complete(lead.spec.runId, { result: "Still premature" })).toThrow(/New direction/);
    await finish(lead);
    const next = activeTurn(execution.id);
    expect(next.spec.prompt).toContain(retained.body);
    expect(next.spec.prompt).not.toContain(cancelled.body);
    expect(next.spec.attachments).toEqual(["/retained.png"]);
    expect(() => coordinator.cancelDirection(execution.id, retained.id)).toThrow(/already reserved/);
    await finish(next);
    expect(coordinator.status(execution.id).state).toBe("completed");
    expect(() => coordinator.cancelDirection(execution.id, retained.id)).toThrow(/complete|reserved/);
    expect(coordinator.compact(thread.id, "after-cancel").seed).not.toContain("CANCELLED_ONLY_SENTINEL");
  });

  it("retains a wait intent when all late pending direction is withdrawn", async () => {
    const execution = await startTeam();
    const lead = activeTurn(execution.id);
    coordinator.wait(lead.spec.runId);
    const direction = coordinator.steer(execution.id, { text: "Withdrawn interruption", requestKey: "wait-cancel" });
    coordinator.cancelDirection(execution.id, direction.id);
    await finish(lead);
    expect(actor(execution.id, "lead").state).toBe("waiting");
    expect(turns.size).toBe(1);
    coordinator.steer(execution.id, { text: "Now continue", requestKey: "wake" });
    await coordinator.drain();
    await finish(activeTurn(execution.id));
    expect(coordinator.status(execution.id).state).toBe("completed");
  });

  it("cancels stopped pending direction durably before the next compacted execution", async () => {
    const execution = await startTeam();
    const direction = coordinator.steer(execution.id, { text: "CANCELLED_RESTART_SENTINEL", attachments: ["/never-deliver.png"], requestKey: "stop-cancel" });
    const stopping = coordinator.stop(execution.id);
    expect(() => coordinator.cancelDirection(execution.id, direction.id)).toThrow(/stop operation/);
    await stopping;
    await coordinator.drain();
    const cancelled = coordinator.cancelDirection(execution.id, direction.id);
    expect(coordinator.status(execution.id).state).toBe("stopped");
    expect(turns.size).toBe(1);
    ledger.close();
    db.close();
    db = Db.open(path.join(directory, "fixture.sqlite"));
    ledger = new LedgerWriter(db);
    runService = makeRunService();
    coordinator = new TeamCoordinator(db, runService, coordinatorHooks);
    coordinator.recover();
    expect(coordinator.cancelDirection(execution.id, direction.id)).toEqual(cancelled);
    const checkpoint = coordinator.compact(thread.id, "cancelled-history");
    expect(checkpoint.seed).not.toContain(direction.body);
    expect(checkpoint.seed).not.toContain("/never-deliver.png");
    const next = await coordinator.start({ threadId: thread.id, prompt: "Continue the original work." });
    await coordinator.drain();
    expect(activeTurn(next.id).spec.systemPromptAppendix).not.toContain(direction.body);
    expect(activeTurn(next.id).spec.attachments ?? []).toEqual([]);
    expect(coordinator.status(execution.id).messages[0]).toEqual(cancelled);
    expect(db.stmt("SELECT 1 FROM audit_events WHERE action = 'team.direction.cancel'").all()).toHaveLength(1);
  });

  it("does not withdraw stopped history already included in a later lead's context reservation", async () => {
    const execution = await startTeam();
    const direction = coordinator.steer(execution.id, { text: "Preserved original direction", requestKey: "historical" });
    await coordinator.stop(execution.id);
    await coordinator.drain();
    coordinator.compact(thread.id, "carry-forward");
    const next = await coordinator.start({ threadId: thread.id, prompt: "Continue from retained context." });
    await coordinator.drain();
    expect(activeTurn(next.id).spec.systemPromptAppendix).toContain(direction.body);
    expect(() => coordinator.cancelDirection(execution.id, direction.id)).toThrow(/Later work/);
    expect(coordinator.status(execution.id).messages[0]!.state).toBe("pending");
  });
});

describe("immediate team lead direction", () => {
  it.each([0, 1100])("delivers direction arriving during startup once the reserved run is ready (capture delay: %i ms)", async (captureDelay) => {
    const receive = vi.fn(async (_text: string, _attachments?: string[]) => "accepted" as const);
    liveSteer = receive;
    const execution = await startTeam();
    const initial = activeTurn(execution.id);
    // Real Git capture can outlast a one-second polling deadline on a busy host.
    // Delay only this turn's capture; keep the actual snapshot and delivery paths.
    runHooks.captureTeamTree = async () => {
      runHooks.captureTeamTree = undefined;
      if (captureDelay) await new Promise((resolve) => setTimeout(resolve, captureDelay));
      return null;
    };
    coordinator.steer(execution.id, { text: "Start another turn", requestKey: "next" });
    const gate = deferred();
    const entered = deferred();
    coordinatorHooks.validate = vi.fn(async () => {
      entered.resolve();
      await gate.promise;
    });
    const finishing = finish(initial);
    await entered.promise;
    coordinator.steer(execution.id, { text: "Arrived during startup", attachments: ["/startup.png"], requestKey: "startup", now: true });
    expect(coordinator.steerAvailability(execution.id).reason).toContain("starting");
    gate.resolve();
    await finishing;
    expect(receive).toHaveBeenCalledExactlyOnceWith("Arrived during startup", ["/startup.png"]);
    expect(coordinator.status(execution.id).attempts).toHaveLength(2);
    expect(activeTurn(execution.id).spec.prompt).not.toContain("Arrived during startup");
  });

  it("promotes member chat in order without duplicating room input or sending later queued text", async () => {
    const ack = deferred();
    const receive = vi.fn(async (_text: string, _attachments?: string[]) => {
      await ack.promise;
      return "accepted" as const;
    });
    liveSteer = receive;
    const execution = await startTeam();
    coordinator.chat(execution.id, { text: "Start worker", to: ["engineer"], requestKey: "start" });
    await coordinator.drain();
    const worker = activeTurn(execution.id, "member:engineer");
    coordinator.chat(execution.id, { text: "OLDER_SENTINEL", attachments: ["/older.png"], to: ["engineer"], requestKey: "older-chat", now: false });
    await coordinator.drain();
    expect(receive).not.toHaveBeenCalled();
    const correction = { text: "LATEST_SENTINEL", attachments: ["/latest.png"], to: ["engineer"], requestKey: "latest-chat", now: true };
    coordinator.chat(execution.id, correction);
    coordinator.chat(execution.id, correction); // response replay cannot reserve or write twice
    coordinator.chat(execution.id, { text: "LATER_QUEUED_SENTINEL", to: ["engineer"], requestKey: "later-chat", now: false });
    await Promise.resolve();
    expect(receive).toHaveBeenCalledTimes(1);
    expect(receive.mock.calls[0]).toEqual([expect.stringContaining("OLDER_SENTINEL"), ["/older.png"]]);
    expect(receive.mock.calls[0]?.[0]).not.toContain("LATEST_SENTINEL");
    ack.resolve();
    await coordinator.drain();
    expect(receive).toHaveBeenCalledTimes(2);
    expect(receive.mock.calls[1]).toEqual([expect.stringContaining("LATEST_SENTINEL"), ["/latest.png"]]);
    expect(receive.mock.calls[1]?.[0]).not.toContain("OLDER_SENTINEL");
    expect(receive.mock.calls[1]?.[0]).not.toContain("LATER_QUEUED_SENTINEL");
    expect(coordinator.status(execution.id).messages.at(-1)?.state).toBe("pending");
    expect(activeTurn(execution.id, "member:engineer").spec.runId).toBe(worker.spec.runId);
  });

  it("never truncates an addressed live correction to the room catch-up budget", async () => {
    const receive = vi.fn(async (_text: string, _attachments?: string[]) => "accepted" as const);
    liveSteer = receive;
    const execution = await startTeam();
    coordinator.chat(execution.id, { text: "Start worker", to: ["engineer"], requestKey: "start" });
    await coordinator.drain();
    const correction = "REQUIRED_START " + "x".repeat(60_000) + " REQUIRED_END";
    coordinator.chat(execution.id, { text: correction, to: ["engineer"], requestKey: "long", now: true });
    await coordinator.drain();
    expect(receive).toHaveBeenCalledTimes(1);
    expect(receive.mock.calls[0]?.[0]).toContain(correction);
  });

  it("resumes live input after compaction readiness without waking another turn", async () => {
    const receive = vi.fn(async (_text: string, _attachments?: string[]) => "accepted" as const);
    liveSteer = receive;
    const execution = await startTeam();
    const lead = activeTurn(execution.id);
    compacting = true;
    coordinator.steer(execution.id, { text: "Retain this through compaction", requestKey: "compacting", now: true });
    await coordinator.drain();
    expect(receive).not.toHaveBeenCalled();
    expect(coordinator.steerAvailability(execution.id).reason).toContain("compacting");
    compacting = false;
    lead.handle.emit("event", { type: "message.completed", role: "assistant", messageId: "ready", runId: lead.spec.runId, text: "Ready", ts: Date.now() });
    await coordinator.drain();
    expect(receive).toHaveBeenCalledExactlyOnceWith("Retain this through compaction", []);
    expect(coordinator.status(execution.id).attempts).toHaveLength(1);
  });

  it("sends a queued direction now on request and refuses one already claimed", async () => {
    const receive = vi.fn(async (_text: string, _attachments?: string[]) => "accepted" as const);
    liveSteer = receive;
    const execution = await startTeam(roster());
    const queued = coordinator.steer(execution.id, { text: "Queued at first", requestKey: "queued" });
    await coordinator.drain();
    expect(receive).not.toHaveBeenCalled();
    expect(coordinator.sendNowAvailability(execution.id, queued.id).allowed).toBe(true);
    coordinator.sendNow(execution.id, queued.id);
    await coordinator.drain();
    expect(receive).toHaveBeenCalledExactlyOnceWith("Queued at first", []);
    const pushed = coordinator.status(execution.id).messages.find((message) => message.id === queued.id)!;
    expect(pushed).toMatchObject({ state: "claimed", sendNowAt: expect.any(Number) });
    expect(pushed.delivery).toBeUndefined();
    expect(coordinator.sendNowAvailability(execution.id, queued.id)).toMatchObject({ allowed: false, reason: "This message is no longer waiting." });
    expect(coordinator.status(execution.id).attempts).toHaveLength(1);
  });

  it("stays readable and recoverable after a crash while a member that took live chat keeps its process open", async () => {
    liveSteer = vi.fn(async () => "accepted" as const);
    const execution = await startTeam();
    coordinator.chat(execution.id, { text: "Start worker", to: ["engineer"], requestKey: "start" });
    await coordinator.drain();
    const worker = activeTurn(execution.id, "member:engineer");
    coordinator.chat(execution.id, { text: "Live correction", to: ["engineer"], requestKey: "live", now: true });
    await coordinator.drain();
    await finish(worker, "Done");
    const live = coordinator.status(execution.id).messages.find((item) => item.body === "Live correction")!;
    expect(live.state).toBe("delivered");
    expect(runs.get(db, worker.spec.runId)!.state).toBe("running");
    // The app crashes with the member's process open; the next start marks that run as ended by an error.
    runs.update(db, worker.spec.runId, { state: "error", endedAt: Date.now(), error: "OpenOrc closed while this session was open." });
    expect(() => teamRuntime.get(db, execution.id)).not.toThrow();
    coordinator = new TeamCoordinator(db, runService, coordinatorHooks);
    expect(() => coordinator.recover()).not.toThrow();
    expect(coordinator.status(execution.id).messages.find((item) => item.id === live.id)!.state).toBe("delivered");
    expect(actor(execution.id, "member:engineer").state).toBe("waiting");
  });

  it("counts a warm member's current turn once when admitting another worker", async () => {
    const draft = roster(3);
    draft.members[2]!.settings = { ...draft.members[1]!.settings };
    const execution = await startTeam(draft);
    coordinator.chat(execution.id, { text: "First turn", to: ["engineer"], requestKey: "warm-first" });
    await coordinator.drain();
    const worker = activeTurn(execution.id, "member:engineer");
    await finish(worker, "First answer");
    coordinator.chat(execution.id, { text: "Second turn", to: ["engineer"], requestKey: "warm-second" });
    await coordinator.drain();
    expect(activeTurn(execution.id, "member:engineer").spec.runId).toBe(worker.spec.runId);
    coordinator.chat(execution.id, { text: "Use the third slot", to: ["reviewer"], requestKey: "third-slot" });
    await coordinator.drain();
    expect(actor(execution.id, "member:reviewer").state).toBe("running");
  });

  it("relays direction live to an isolated active worker at team capacity one", async () => {
    const receive = vi.fn(async (_text: string, _attachments?: string[]) => "accepted" as const);
    liveSteer = receive;
    const execution = await startTeam(roster(1));
    const initial = activeTurn(execution.id);
    const worker = coordinator.dispatch(initial.spec.runId, assignment("engineer"));
    coordinator.wait(initial.spec.runId);
    await finish(initial);
    const working = activeTurn(execution.id, worker.id);
    coordinator.steer(execution.id, { text: "Change the worker's direction", requestKey: "wake", now: true });
    await coordinator.drain();
    const lead = activeTurn(execution.id);
    coordinator.message(lead.spec.runId, { recipientId: worker.id, text: "Use the revised scope", requestKey: "relay" });
    await coordinator.drain();
    expect(receive).toHaveBeenCalledExactlyOnceWith("Use the revised scope", []);
    expect(activeTurn(execution.id, worker.id).spec.runId).toBe(working.spec.runId);
    expect(coordinator.status(execution.id).messages.at(-1)?.state).toBe("claimed");
  });

  it("holds the rest of a promoted queue behind an uncertain acknowledgment for explicit recovery", async () => {
    const receive = vi.fn(async () => {
      throw new Error("Lost acknowledgment");
    });
    liveSteer = receive;
    const execution = await startTeam();
    coordinator.steer(execution.id, { text: "First pending instruction", requestKey: "older" });
    const correction = { text: "Latest correction", requestKey: "latest", now: true };
    coordinator.steer(execution.id, correction);
    await coordinator.drain();
    expect(receive).toHaveBeenCalledTimes(1);
    expect(coordinator.status(execution.id).messages.map((item) => item.state)).toEqual(["claimed", "pending"]);
    expect(coordinator.status(execution.id).state).toBe("attention");
    coordinator.steer(execution.id, correction);
    await coordinator.drain();
    expect(receive).toHaveBeenCalledTimes(1);
    coordinator.retry(execution.id, "lead");
    await coordinator.drain();
    const recovery = activeTurn(execution.id);
    expect(recovery.spec.prompt.indexOf("First pending instruction")).toBeLessThan(recovery.spec.prompt.indexOf("Latest correction"));
    expect(coordinator.status(execution.id).attempts).toHaveLength(2);
  });

  it("keeps ordinary messages queued and delivers explicit live text/images once within the original turn", async () => {
    const receive = vi.fn(async (_text: string, _attachments?: string[]) => "accepted" as const);
    liveSteer = receive;
    const execution = await startTeam();
    const lead = activeTurn(execution.id);
    const original = coordinator.status(execution.id).attempts[0]!;
    const originalPrompt = teamRuntime.prompt(db, execution.id, original.id);
    const queued = coordinator.steer(execution.id, { text: "Queue by default", requestKey: "queued-default" });
    await coordinator.drain();
    expect(receive).not.toHaveBeenCalled();
    coordinator.cancelDirection(execution.id, queued.id);
    const message = coordinator.steer(execution.id, { text: "Use the attached revision now", attachments: ["/revision.png"], requestKey: "live-once", now: true });
    expect(message.state).toBe("claimed");
    expect(() => coordinator.complete(lead.spec.runId, { result: "Premature" })).toThrow(/direction/);
    expect(() => coordinator.wait(lead.spec.runId)).toThrow(/confirmed/);
    expect(() => coordinator.assertCurrentDirection(lead.spec.runId)).toThrow(/confirmed/);
    await coordinator.drain();
    const reserved = coordinator.status(execution.id).attempts[0]!;
    expect(receive).toHaveBeenCalledExactlyOnceWith(message.body, ["/revision.png"]);
    expect(reserved.messageIds).toEqual(original.messageIds);
    // Live direction never rewrites the turn's initial input.
    expect(teamRuntime.prompt(db, execution.id, reserved.id)).toBe(originalPrompt);
    expect(reserved.directionVersion).toBe(original.directionVersion);
    expect(reserved.liveDirections?.[0]?.state).toBe("accepted");
    expect(coordinator.status(execution.id).messages.at(-1)?.state).toBe("claimed");
    expect(coordinator.steer(execution.id, { text: message.body, attachments: ["/revision.png"], requestKey: "live-once", now: true }).id).toBe(message.id);
    expect(() => coordinator.steer(execution.id, { text: message.body, attachments: ["/revision.png"], requestKey: "live-once" })).toThrow(/different direction/);
    expect(() => coordinator.cancelDirection(execution.id, message.id)).toThrow(/already reserved/);
    coordinator.assertCurrentDirection(lead.spec.runId);
    coordinator.complete(lead.spec.runId, { result: "Handled the live revision" });
    await finish(lead);
    const complete = coordinator.status(execution.id);
    expect(complete.state).toBe("completed");
    expect(complete.attempts).toHaveLength(1);
    expect(complete.messages.at(-1)?.state).toBe("delivered");
    expect(receive).toHaveBeenCalledTimes(1);
    expect(
      db.stmt("SELECT 1 FROM events WHERE run_id = ? AND kind = 'message.completed' AND json_extract(payload, '$.messageId') = ?").all(lead.spec.runId, `team-direction:${message.id}`),
    ).toHaveLength(1);
  });

  it("waits for the live acknowledgment before closing a completed provider turn", async () => {
    const ack = deferred();
    liveSteer = async () => {
      await ack.promise;
      return "accepted";
    };
    const execution = await startTeam();
    const lead = activeTurn(execution.id);
    const direction = coordinator.steer(execution.id, { text: "Include this final constraint", requestKey: "race", now: true });
    const finishing = finish(lead);
    await vi.waitFor(() => expect(settled.has(lead.spec.runId)).toBe(true));
    expect(lead.exited).toBe(false);
    expect(coordinator.status(execution.id).messages[0]?.state).toBe("claimed");
    ack.resolve();
    await finishing;
    expect(coordinator.status(execution.id).state).toBe("completed");
    expect(coordinator.status(execution.id).messages.find((item) => item.id === direction.id)?.state).toBe("delivered");
    expect(coordinator.status(execution.id).attempts).toHaveLength(1);
  });

  it("queues a definite no-send race without reusing the old turn or losing the instruction", async () => {
    liveSteer = async () => "accepted";
    const execution = await startTeam();
    const lead = activeTurn(execution.id);
    const message = coordinator.steer(execution.id, { text: "Send after the provider becomes available", requestKey: "race-unavailable", now: true });
    liveSteer = null;
    await coordinator.drain();
    expect(coordinator.status(execution.id).attempts[0]?.liveDirections?.[0]?.state).toBe("unavailable");
    expect(coordinator.status(execution.id).messages[0]).toMatchObject({ id: message.id, state: "pending", attemptId: null });
    expect(() => coordinator.cancelDirection(execution.id, message.id)).toThrow(/already reserved/);
    await finish(lead);
    const next = activeTurn(execution.id);
    expect(next.spec.runId).not.toBe(lead.spec.runId);
    expect(next.spec.prompt).toContain(message.body);
    await finish(next);
    expect(coordinator.status(execution.id).state).toBe("completed");
  });

  it("retains direction when a fatal provider event follows capture but precedes the live acknowledgment", async () => {
    const ack = deferred();
    liveSteer = async () => {
      await ack.promise;
      return "accepted";
    };
    const captureOutput = vi.fn(async () => {});
    coordinatorHooks.workspace = { beforeStart: async () => {}, captureOutput };
    const execution = await startTeam();
    const lead = activeTurn(execution.id);
    coordinator.steer(execution.id, { text: "Retain despite late failure", requestKey: "late-fatal", now: true });
    const finishing = finish(lead);
    await vi.waitFor(() => expect(settled.has(lead.spec.runId)).toBe(true));
    lead.handle.emit("event", { type: "error", runId: lead.spec.runId, ts: Date.now(), fatal: true, message: "Late provider failure" });
    await vi.waitFor(() => expect(runs.get(db, lead.spec.runId)?.error).toBe("Late provider failure"));
    ack.resolve();
    await finishing;
    const failed = coordinator.status(execution.id);
    expect(failed.state).toBe("attention");
    expect(failed.attempts[0]).toMatchObject({ state: "closed", error: "Late provider failure" });
    expect(failed.messages[0]?.state).toBe("claimed");
    expect(failed.actors[0]?.error).toBe("Late provider failure");
    expect(captureOutput).not.toHaveBeenCalled();
    expect(coordinator.retryAvailability(execution.id, "lead").allowed).toBe(true);
  });

  it("fences unconfirmed delivery on restart and requires explicit recovery without repeating the live request", async () => {
    const ack = deferred();
    const receive = vi.fn(async (_text: string, _attachments?: string[]) => {
      await ack.promise;
      return "accepted" as const;
    });
    liveSteer = receive;
    const execution = await startTeam();
    coordinator.steer(execution.id, { text: "Retained across restart", requestKey: "restart-live", now: true });
    await Promise.resolve();
    coordinator.recover();
    expect(coordinator.status(execution.id).attempts[0]?.liveDirections?.[0]?.state).toBe("uncertain");
    ack.resolve();
    await coordinator.drain();
    expect(coordinator.status(execution.id).state).toBe("attention");
    expect(coordinator.status(execution.id).messages[0]?.state).toBe("claimed");
    expect(receive).toHaveBeenCalledTimes(1);
    coordinator.retry(execution.id, "lead");
    await coordinator.drain();
    const recovery = activeTurn(execution.id);
    expect(recovery.spec.prompt).toContain("Retained across restart");
    await finish(recovery);
    expect(coordinator.status(execution.id).state).toBe("completed");
    expect(receive).toHaveBeenCalledTimes(1);
  });

  it("retains uncertain input for explicit recovery and never lets a successful exit acknowledge it", async () => {
    const receive = vi.fn(async () => {
      throw new Error("transport response lost");
    });
    liveSteer = receive;
    const execution = await startTeam();
    const lead = activeTurn(execution.id);
    const direction = coordinator.steer(execution.id, { text: "Uncertain but retained", attachments: ["/retained.png"], requestKey: "unknown", now: true });
    await coordinator.drain();
    expect(lead.exited).toBe(true);
    expect(coordinator.status(execution.id).state).toBe("attention");
    expect(coordinator.status(execution.id).messages[0]).toMatchObject({ state: "claimed", deliveredAt: null });
    expect(coordinator.status(execution.id).attempts[0]?.liveDirections?.[0]).toMatchObject({ state: "uncertain", error: expect.stringContaining("transport response lost") });
    coordinator.steer(execution.id, { text: direction.body, attachments: ["/retained.png"], requestKey: "unknown", now: true });
    expect(receive).toHaveBeenCalledTimes(1);
    coordinator.retry(execution.id, "lead");
    await coordinator.drain();
    const recovery = activeTurn(execution.id);
    expect(recovery.spec.prompt).toContain(direction.body);
    expect(recovery.spec.attachments).toContain("/retained.png");
    coordinator.complete(recovery.spec.runId, { result: "Recovered after inspecting prior work" });
    await finish(recovery);
    expect(coordinator.status(execution.id).state).toBe("completed");
    expect(coordinator.status(execution.id).messages[0]?.state).toBe("delivered");
    expect(receive).toHaveBeenCalledTimes(1);
  });

  it("closes immediately on Stop and fences an acknowledgment arriving during closure", async () => {
    let accept!: (value: "accepted") => void;
    const received = new Promise<"accepted">((resolve) => {
      accept = resolve;
    });
    liveSteer = async () => received;
    const execution = await startTeam();
    const lead = activeTurn(execution.id);
    coordinator.steer(execution.id, { text: "May already be in flight", requestKey: "stop-race", now: true });
    await Promise.resolve();
    const close = lead.handle.close.bind(lead.handle);
    vi.spyOn(lead.handle, "close").mockImplementation(() => {
      accept("accepted");
      close();
    });
    await coordinator.stop(execution.id);
    await coordinator.drain();
    const stopped = coordinator.status(execution.id);
    expect(stopped.state).toBe("stopped");
    expect(stopped.attempts[0]?.liveDirections?.[0]?.state).toBe("uncertain");
    expect(stopped.messages[0]?.state).toBe("claimed");
    expect(lead.exited).toBe(true);
    expect(() => coordinator.complete(lead.spec.runId, { result: "Late completion" })).toThrow(/stopped|replaced/);
  });

  it("continues ordered live delivery after an unresolved acknowledgment", async () => {
    const ack = deferred();
    const receive = vi.fn(async (_text: string, _attachments?: string[]) => {
      await ack.promise;
      return "accepted" as const;
    });
    liveSteer = receive;
    const execution = await startTeam();
    const lead = activeTurn(execution.id);
    coordinator.steer(execution.id, { text: "First live", requestKey: "first-live", now: true });
    const second = coordinator.steer(execution.id, { text: "Second remains ordered", requestKey: "second-live", now: true });
    expect(second.state).toBe("pending");
    await Promise.resolve();
    expect(receive).toHaveBeenCalledTimes(1);
    ack.resolve();
    await coordinator.drain();
    expect(receive).toHaveBeenCalledTimes(2);
    coordinator.complete(lead.spec.runId, { result: "Both handled" });
    await finish(lead);
    expect(coordinator.status(execution.id).state).toBe("completed");
    expect(coordinator.status(execution.id).attempts).toHaveLength(1);
  });
});

describe("requested team Plan and Act boundaries", () => {
  function mode(value: "plan" | "act") {
    threads.update(db, thread.id, { mode: value });
    coordinator.modeChanged(thread.id);
  }

  it("retains queued assignments and directions while the lead plans, then resumes the same work in Act", async () => {
    liveSteer = async () => "accepted";
    const execution = await startTeam(roster(1));
    const lead = activeTurn(execution.id);
    const worker = coordinator.dispatch(lead.spec.runId, assignment("engineer"));
    const originalTask = tasks.get(db, worker.taskId!)!;
    coordinator.steerActor(execution.id, worker.id, { text: "Retain this worker constraint", attachments: ["/worker-input.png"], requestKey: "worker-direction" });
    mode("plan");
    expect(runs.get(db, lead.spec.runId)?.mode).toBe("act");
    expect(coordinator.dispatchReplay(lead.spec.runId, assignment("engineer"))?.id).toBe(worker.id);
    expect(() => coordinator.dispatchReplay(lead.spec.runId, assignment("engineer", "engineer", { spec: "Changed request" }))).toThrow(/different work/);
    expect(coordinator.dispatchReplay(lead.spec.runId, assignment("reviewer"))).toBeNull();
    expect(coordinator.status(execution.id).generation).toBe(execution.generation);
    expect(coordinator.steerAvailability(execution.id)).toMatchObject({ allowed: false, reason: expect.stringContaining("next turn") });
    expect(() => coordinator.dispatch(lead.spec.runId, assignment("reviewer"))).toThrow(/Act mode/);
    coordinator.wait(lead.spec.runId);
    await finish(lead);
    expect(actor(execution.id, worker.id).state).toBe("queued");
    expect(coordinator.status(execution.id).attempts.filter((item) => item.actorId === worker.id)).toEqual([]);
    coordinator.steer(execution.id, { text: "Explain the retained implementation plan", requestKey: "plan-question" });
    await coordinator.drain();
    const planner = activeTurn(execution.id);
    expect(runs.get(db, planner.spec.runId)?.mode).toBe("plan");
    expect(planner.spec.permissionMode).toBe("review");
    expect(() => coordinator.complete(planner.spec.runId, { result: "A plan is not implementation" })).toThrow(/Plan mode preserves/);
    await finish(planner, "Here is the implementation plan.");
    expect(actor(execution.id, "lead")).toMatchObject({ state: "waiting", modeHold: "plan", retries: 0 });
    expect(tasks.get(db, worker.taskId!)).toEqual(originalTask);
    mode("act");
    await coordinator.drain();
    const resumedLead = activeTurn(execution.id);
    expect(runs.get(db, resumedLead.spec.runId)?.mode).toBe("act");
    coordinator.wait(resumedLead.spec.runId);
    await finish(resumedLead);
    const work = activeTurn(execution.id, worker.id);
    expect(work.spec.prompt).toContain("Retain this worker constraint");
    expect(work.spec.attachments).toContain("/worker-input.png");
    expect(actor(execution.id, worker.id).taskId).toBe(originalTask.id);
    expect(runs.get(db, work.spec.runId)?.mode).toBe("act");
    coordinator.complete(work.spec.runId, { result: "Implemented" });
    await finish(work);
    const finalLead = activeTurn(execution.id);
    coordinator.complete(finalLead.spec.runId, { result: "Combined completed work" });
    await finish(finalLead);
    expect(coordinator.status(execution.id).state).toBe("completed");
    expect(coordinator.status(execution.id).actors.filter((item) => !item.participant)).toHaveLength(2);
  });

  it("finishes safe preparation before deferring an unlaunched worker without charging a retry", async () => {
    const gate = deferred();
    const originalPrepare = preparing.getMockImplementation()!;
    preparing.mockImplementation(async (task, assertActive) => {
      await gate.promise;
      return originalPrepare(task, assertActive);
    });
    const execution = await startTeam(roster(1));
    const lead = activeTurn(execution.id);
    const worker = coordinator.dispatch(lead.spec.runId, assignment("engineer"));
    coordinator.steerActor(execution.id, worker.id, { text: "Preserve through preparation", requestKey: "prep-direction" });
    coordinator.wait(lead.spec.runId);
    const finishing = finish(lead);
    await vi.waitFor(() => expect(preparing).toHaveBeenCalledTimes(1));
    mode("plan");
    gate.resolve();
    await finishing;
    const held = coordinator.status(execution.id);
    expect(held.attempts.at(-1)).toMatchObject({ actorId: worker.id, mode: "act", state: "cancelled", runId: null, endedAt: expect.any(Number) });
    expect(actor(execution.id, worker.id)).toMatchObject({ state: "queued", retries: 0 });
    expect(held.messages.find((item) => item.recipientId === worker.id)).toMatchObject({ state: "pending", attemptId: null });
    expect(tasks.get(db, worker.taskId!)?.worktreePath).toBeTruthy();
    expect(turns.size).toBe(1);
    mode("act");
    await coordinator.drain();
    const work = activeTurn(execution.id, worker.id);
    expect(work.spec.prompt).toContain("Preserve through preparation");
    expect(work.spec.cwd).toBe(await realpath(tasks.get(db, worker.taskId!)!.worktreePath!));
    expect(actor(execution.id, worker.id).retries).toBe(0);
  });

  it("lets an existing Act worker finish and the Plan lead review its result without restarting implementation", async () => {
    const execution = await startTeam(roster(1));
    const lead = activeTurn(execution.id);
    const worker = coordinator.dispatch(lead.spec.runId, assignment("engineer"));
    coordinator.wait(lead.spec.runId);
    await finish(lead);
    const work = activeTurn(execution.id, worker.id);
    mode("plan");
    coordinator.complete(work.spec.runId, { result: "Existing Act work completed" });
    await finish(work);
    const planner = activeTurn(execution.id);
    expect(runs.get(db, work.spec.runId)?.mode).toBe("act");
    expect(runs.get(db, planner.spec.runId)?.mode).toBe("plan");
    await finish(planner, "Reviewed the work that completed before Plan took effect.");
    expect(coordinator.status(execution.id).state).toBe("completed");
    expect(coordinator.status(execution.id).attempts.filter((item) => item.actorId === worker.id)).toHaveLength(1);
  });

  it("defers after provisional run creation without a stale failure callback stranding the assignment", async () => {
    const execution = await startTeam(roster(1));
    const lead = activeTurn(execution.id);
    const worker = coordinator.dispatch(lead.spec.runId, assignment("engineer"));
    let switched = false;
    runHooks.assertStart = (input) => {
      const attempt = coordinator.status(execution.id).attempts.find((item) => item.id === input.teamAttemptId);
      if (!switched && input.scope.task?.id === worker.taskId && attempt?.runId) {
        switched = true;
        mode("plan");
      }
      coordinator.assertLaunch(input);
    };
    coordinator.wait(lead.spec.runId);
    await finish(lead);
    const held = coordinator.status(execution.id);
    expect(switched).toBe(true);
    expect(held.attempts.at(-1)).toMatchObject({ actorId: worker.id, mode: "act", state: "cancelled", runId: expect.any(String) });
    expect(actor(execution.id, worker.id)).toMatchObject({ state: "queued", retries: 0 });
    expect(turns.size).toBe(1);
    mode("act");
    await coordinator.drain();
    expect(activeTurn(execution.id, worker.id)).toBeTruthy();
    expect(actor(execution.id, worker.id).retries).toBe(0);
  });

  it("keeps real preparation failure in attention even when Plan is selected during the await", async () => {
    const gate = deferred();
    preparing.mockImplementation(async () => {
      await gate.promise;
      throw new Error("Setup needs repair");
    });
    const execution = await startTeam(roster(1));
    const lead = activeTurn(execution.id);
    const worker = coordinator.dispatch(lead.spec.runId, assignment("engineer"));
    coordinator.wait(lead.spec.runId);
    const finishing = finish(lead);
    await vi.waitFor(() => expect(preparing).toHaveBeenCalledTimes(1));
    mode("plan");
    gate.resolve();
    await finishing;
    expect(actor(execution.id, worker.id)).toMatchObject({ state: "attention", error: "Setup needs repair" });
    mode("act");
    await coordinator.drain();
    expect(actor(execution.id, worker.id).state).toBe("attention");
    expect(coordinator.status(execution.id).attempts.filter((item) => item.actorId === worker.id)).toHaveLength(1);
  });

  it("resumes held work when Act is requested before the planning turn has settled", async () => {
    let required = true;
    coordinatorHooks.tasks = { instructions: () => "Retained accepted work", completionReason: () => (required ? "Task pending" : null), hasPendingWork: () => required, settled() {} };
    mode("plan");
    const execution = await startTeam(roster(1));
    const planner = activeTurn(execution.id);
    mode("act");
    expect(() => coordinator.dispatch(planner.spec.runId, assignment("engineer"))).toThrow(/Act mode/);
    await finish(planner);
    const executing = activeTurn(execution.id);
    expect(executing.spec.runId).not.toBe(planner.spec.runId);
    expect(runs.get(db, executing.spec.runId)?.mode).toBe("act");
    required = false;
    await finish(executing);
    expect(coordinator.status(execution.id).state).toBe("completed");
  });

  it("does not revive attention, stopped, or completed work when changing back to Act", async () => {
    coordinatorHooks.tasks = { instructions: () => "Work remains", completionReason: () => "Pending", hasPendingWork: () => true, settled() {} };
    mode("plan");
    const execution = await startTeam();
    await finish(activeTurn(execution.id));
    expect(actor(execution.id, "lead")).toMatchObject({ state: "waiting", modeHold: "plan" });
    // A failure leaves the held lead needing attention.
    teamRuntime.update(db, execution.id, (state) => {
      Object.assign(
        state.actors.find((item) => item.id === "lead")!,
        { state: "attention", error: "Inspect the plan before continuing." },
      );
      state.state = "attention";
    });
    mode("act");
    await coordinator.drain();
    expect(actor(execution.id, "lead").state).toBe("attention");
    expect(turns.size).toBe(1);
    await coordinator.stop(execution.id);
    mode("plan");
    mode("act");
    await coordinator.drain();
    expect(coordinator.status(execution.id).state).toBe("stopped");
    expect(turns.size).toBe(1);
    coordinatorHooks.tasks = undefined;
    const next = await coordinator.start({ threadId: thread.id, prompt: "A new explicit request" });
    await coordinator.drain();
    await finish(activeTurn(next.id));
    mode("plan");
    mode("act");
    await coordinator.drain();
    expect(coordinator.status(next.id).state).toBe("completed");
    expect(turns.size).toBe(2);
  });
});

describe("team chat participants", () => {
  const participant = (executionId: string, key: string) => actor(executionId, `member:${key}`);

  it("lets the lead relay a user broadcast without a second reply: the members read it after their own answer", async () => {
    const execution = await startTeam();
    const lead = activeTurn(execution.id);
    expect(lead.spec.systemPromptAppendix).toContain("answer for yourself, never relay or repeat it");
    coordinator.chat(execution.id, { text: "Hello everyone, say hi", to: ["all"], requestKey: "hello-all" });
    await coordinator.drain();
    const engineer = activeTurn(execution.id, "member:engineer");
    const reviewer = activeTurn(execution.id, "member:reviewer");
    // Both members hold the user's request, so the lead's relay is theirs to read: no mailbox message, no reply turn.
    const relayed = coordinator.say(lead.spec.runId, { text: "Alex asked everyone to say hi. Drop a quick hello.", to: ["engineer", "reviewer"], requestKey: "relay-hello" });
    expect(relayed.delivered).toEqual([
      { member: "engineer", delivery: "read" },
      { member: "reviewer", delivery: "read" },
    ]);
    expect(coordinator.status(execution.id).messages.filter((message) => message.senderId === "lead")).toHaveLength(0);
    await finish(engineer, "Hi everyone, Engineer here.");
    await finish(reviewer, "Hi, Reviewer here.");
    // The relay reaches them once their own turn is over, as a read: their private notes never reach the room.
    await debounce();
    const engineerRead = activeTurn(execution.id, "member:engineer");
    expect(engineerRead.spec.prompt).toContain("Lead (lead) to Engineer, Reviewer (to you): Alex asked everyone to say hi. Drop a quick hello.");
    expect(engineerRead.spec.prompt).toContain("AMBIENT TURN");
    await finish(engineerRead, "Already said hi.");
    await finish(activeTurn(execution.id, "member:reviewer"), "Already said hi.");
    const { teamRoom: room } = await import("@openorc/db");
    expect(room.list(db, execution.instanceId).map((event) => [event.source, event.authorId])).toEqual([
      ["prompt", "user"],
      ["chat", "user"],
      ["say", "lead"],
      ["reply", "member:engineer"],
      ["reply", "member:reviewer"],
    ]);
    for (const id of ["member:engineer", "member:reviewer"])
      expect(
        coordinator
          .status(execution.id)
          .attempts.filter((attempt) => attempt.actorId === id)
          .map((attempt) => [attempt.reason, attempt.outcome]),
      ).toEqual([
        ["addressed", "public"],
        ["ambient", "silent"],
      ]);
    await finish(lead, "Hi all.");
    await finish(activeTurn(execution.id), "Everyone has said hi.");
    expect(coordinator.status(execution.id).state).toBe("completed");
  });

  it("caps peer reply turns per request: past the follow-up allowance a colleague's message is read, not answered", async () => {
    const execution = await startTeam();
    const lead = activeTurn(execution.id);
    coordinator.chat(execution.id, { text: "Engineer, settle the file split with the reviewer", to: ["engineer"], requestKey: "split" });
    await coordinator.drain();
    const engineer = activeTurn(execution.id, "member:engineer");
    // The reviewer holds no user request, so a peer's first message is a reply turn; with no follow-ups allowed, the next one is read.
    expect(coordinator.say(engineer.spec.runId, { text: "I take src/app.ts", to: ["reviewer"], requestKey: "ping-1" }).delivered).toEqual([{ member: "reviewer", delivery: "queued" }]);
    expect(coordinator.say(engineer.spec.runId, { text: "And src/router.ts is yours.", to: ["reviewer"], requestKey: "ping-2" }).delivered).toEqual([{ member: "reviewer", delivery: "read" }]);
    await finish(engineer, "Proposed the split.");
    await coordinator.drain();
    const reviewer = activeTurn(execution.id, "member:reviewer");
    expect(reviewer.spec.prompt).toContain("chat from member:engineer]\nI take src/app.ts");
    expect(reviewer.spec.prompt).toContain("Engineer to Reviewer (to you): And src/router.ts is yours.");
    expect(reviewer.spec.prompt).not.toContain("AMBIENT TURN");
    // The engineer holds the user's request, so the reviewer's answer is the engineer's to read.
    expect(coordinator.say(reviewer.spec.runId, { text: "Fine by me.", to: ["engineer"], requestKey: "pong-1" }).delivered).toEqual([{ member: "engineer", delivery: "read" }]);
    await finish(reviewer, "Agreed the split.");
    await debounce();
    const engineerRead = activeTurn(execution.id, "member:engineer");
    expect(engineerRead.spec.prompt).toContain("Reviewer to Engineer (to you): Fine by me.");
    expect(engineerRead.spec.prompt).toContain("AMBIENT TURN");
    await finish(engineerRead, "Nothing more.");
    await finish(lead, "All set.");
    expect(coordinator.status(execution.id).state).toBe("completed");
    expect(
      coordinator
        .status(execution.id)
        .attempts.filter((attempt) => attempt.actorId !== "lead")
        .map((attempt) => [attempt.actorId, attempt.reason]),
    ).toEqual([
      ["member:engineer", "addressed"],
      ["member:reviewer", "addressed"],
      ["member:engineer", "ambient"],
    ]);
  });

  it("lets members speak to each other and to the lead with team_say and mentions, never creating tasks", async () => {
    const execution = await startTeam();
    const lead = activeTurn(execution.id);
    coordinator.chat(execution.id, { text: "Engineer, coordinate with the reviewer", to: ["engineer"], requestKey: "coordinate" });
    await coordinator.drain();
    const engineer = activeTurn(execution.id, "member:engineer");
    const said = coordinator.say(engineer.spec.runId, { text: "I am taking src/index.ts", to: ["lead"], requestKey: "claim-1" });
    expect(said).toEqual({ posted: true, delivered: [{ member: "lead", delivery: "queued" }] });
    expect(coordinator.say(engineer.spec.runId, { text: "I am taking src/index.ts", to: ["lead"], requestKey: "claim-1" })).toEqual(said);
    expect(() => coordinator.say(engineer.spec.runId, { text: "Hi", to: ["engineer"] })).toThrow(/yourself/);
    expect(() => coordinator.say(engineer.spec.runId, { text: "Hi", to: ["nobody"] })).toThrow(/No team member/);
    await finish(engineer, "@reviewer please review src/index.ts when I am done.");
    // A mention in a reply is for the reviewer to read, not to answer: it wakes once the room settles, and only team_say from that turn is public.
    await debounce();
    const reviewer = activeTurn(execution.id, "member:reviewer");
    expect(reviewer.spec.prompt).toContain("Engineer to Reviewer (to you): @reviewer please review src/index.ts when I am done.");
    expect(reviewer.spec.prompt).toContain("Engineer to Lead (lead): I am taking src/index.ts");
    expect(reviewer.spec.prompt).toContain("AMBIENT TURN");
    expect(reviewer.spec.prompt).not.toContain("chat from member:engineer]");
    await finish(reviewer, "Will do.");
    expect(coordinator.status(execution.id).attempts.findLast((attempt) => attempt.actorId === "member:reviewer")).toMatchObject({ reason: "ambient", outcome: "silent" });
    // The lead reads the engineer's claim as a chat message on its next turn.
    await finish(lead, "Waiting for the team.");
    await coordinator.drain();
    const leadAgain = activeTurn(execution.id);
    expect(leadAgain.spec.runId).not.toBe(lead.spec.runId);
    expect(leadAgain.spec.prompt).toContain("chat from member:engineer]\nI am taking src/index.ts");
    // An addressed reply reads with its addressees; the reviewer's private note reaches nobody.
    expect(leadAgain.spec.prompt).toContain("Engineer to Reviewer: @reviewer please review");
    expect(leadAgain.spec.prompt).not.toContain("Will do.");
    await finish(leadAgain, "Thanks all.");
    expect(coordinator.status(execution.id).state).toBe("completed");
    expect(tasks.list(db)).toHaveLength(0);
  });

  it("hands a member's unread range back when its turn cannot start, and delivers it again on retry", async () => {
    const execution = await startTeam();
    const lead = activeTurn(execution.id);
    rejectStart = (spec) => (spec.systemPromptAppendix?.includes("You are Engineer") ? "provider offline" : null);
    coordinator.chat(execution.id, { text: "Engineer, are you there?", to: ["engineer"], requestKey: "ping" });
    await coordinator.drain();
    expect(participant(execution.id, "engineer").state).toBe("attention");
    const { teamRoom: room } = await import("@openorc/db");
    const failed = room.deliveries(db, execution.instanceId, { actorId: "member:engineer" });
    expect(failed.map((delivery) => delivery.state)).toEqual(["cancelled"]);
    expect(room.cursor(db, execution.instanceId, "member:engineer").deliveredSeq).toBe(0);
    rejectStart = null;
    coordinator.retry(execution.id, "member:engineer");
    await coordinator.drain();
    const engineer = activeTurn(execution.id, "member:engineer");
    expect(engineer.spec.prompt).toContain("Engineer, are you there?");
    expect(engineer.spec.prompt).toContain("User to Lead (lead): Implement and review the requested change.");
    await finish(engineer, "Here.");
    expect(room.deliveries(db, execution.instanceId, { actorId: "member:engineer" }).map((delivery) => delivery.state)).toEqual(["cancelled", "confirmed"]);
    expect(room.cursor(db, execution.instanceId, "member:engineer").deliveredSeq).toBe(room.latestSeq(db, execution.instanceId) - 1);
    await finish(lead, "Done.");
  });

  it("lets members claim shared-workspace files, refuses a held path, shows claims to colleagues and releases everything when the conversation is idle", async () => {
    const execution = await startTeam();
    const lead = activeTurn(execution.id);
    coordinator.chat(execution.id, { text: "Engineer, start on routing", to: ["engineer"], requestKey: "routing" });
    await coordinator.drain();
    const engineer = activeTurn(execution.id, "member:engineer");
    const claimed = coordinator.claim(engineer.spec.runId, { paths: ["src/app.ts", "./lib/util.ts/"], note: "routing" });
    expect(claimed).toEqual({
      claims: [
        { path: "src/app.ts", note: "routing" },
        { path: "lib/util.ts", note: "routing" },
      ],
      held: [],
    });
    expect(coordinator.claim(engineer.spec.runId, { paths: ["src/app.ts"] })).toEqual(claimed);
    for (const bad of ["../secrets", "/etc/passwd", "C:\\repo\\file"]) expect(() => coordinator.claim(engineer.spec.runId, { paths: [bad] })).toThrow(/relative to the team workspace/);
    coordinator.chat(execution.id, { text: "Reviewer, review routing", to: ["reviewer"], requestKey: "review" });
    await coordinator.drain();
    const reviewer = activeTurn(execution.id, "member:reviewer");
    expect(reviewer.spec.prompt).toContain("Files colleagues currently hold in the shared workspace");
    expect(reviewer.spec.prompt).toContain("Engineer: src/app.ts (routing)");
    expect(() => coordinator.claim(reviewer.spec.runId, { paths: ["src/app.ts", "docs/readme.md"] })).toThrow(/Engineer holds src\/app.ts/);
    expect(
      coordinator
        .statusForRun(reviewer.spec.runId)
        .claims?.filter((claim) => claim.releasedAt === null)
        .map((claim) => claim.path),
    ).toEqual(["src/app.ts", "lib/util.ts"]);
    expect(coordinator.claim(reviewer.spec.runId, { paths: ["docs/readme.md"] })).toEqual({
      claims: [{ path: "docs/readme.md", note: null }],
      held: [
        { member: "engineer", path: "src/app.ts", note: "routing" },
        { member: "engineer", path: "lib/util.ts", note: "routing" },
      ],
    });
    expect(coordinator.claim(engineer.spec.runId, { paths: ["lib/util.ts"], release: true }).claims).toEqual([{ path: "src/app.ts", note: "routing" }]);
    expect(coordinator.claim(reviewer.spec.runId, { paths: ["lib/util.ts"] }).claims.map((claim) => claim.path)).toEqual(["docs/readme.md", "lib/util.ts"]);
    await finish(engineer, "Routing is in.");
    await finish(reviewer, "Looks fine.");
    await finish(lead, "Done.");
    const done = coordinator.status(execution.id);
    expect(done.state).toBe("completed");
    expect(done.claims!.map((claim) => [claim.path, claim.releasedAt !== null])).toEqual([
      ["src/app.ts", true],
      ["lib/util.ts", true],
      ["docs/readme.md", true],
      ["lib/util.ts", true],
    ]);
  });

  it("records the files each turn changed in the shared workspace and warns a member whose concurrent colleague touched the same file", async () => {
    const execution = await startTeam();
    const lead = activeTurn(execution.id);
    coordinator.chat(execution.id, { text: "Engineer and reviewer, both start", to: ["engineer", "reviewer"], requestKey: "both" });
    await coordinator.drain();
    expect(coordinator.status(execution.id).actors.map((item) => [item.id, item.state, item.error])).toEqual([
      ["lead", "running", null],
      ["member:engineer", "running", null],
      ["member:reviewer", "running", null],
    ]);
    const engineer = activeTurn(execution.id, "member:engineer");
    const reviewer = activeTurn(execution.id, "member:reviewer");
    expect(engineer.spec.cwd).toBe(reviewer.spec.cwd);
    await writeFile(path.join(engineer.spec.cwd, "shared.txt"), "engineer version\n");
    await writeFile(path.join(engineer.spec.cwd, "engineer.txt"), "engineer only\n");
    await finish(engineer, "Wrote shared.txt and engineer.txt.");
    await writeFile(path.join(reviewer.spec.cwd, "shared.txt"), "reviewer version\n");
    await writeFile(path.join(reviewer.spec.cwd, "review.txt"), "review notes\n");
    await finish(reviewer, "Reviewed and adjusted shared.txt.");
    const attempts = coordinator.status(execution.id).attempts;
    expect(attempts.find((item) => item.actorId === "member:engineer")?.changedFiles).toEqual(["engineer.txt", "shared.txt"]);
    expect(attempts.find((item) => item.actorId === "member:reviewer")?.changedFiles).toEqual(["review.txt", "shared.txt"]);
    coordinator.chat(execution.id, { text: "Engineer, continue", to: ["engineer"], requestKey: "continue" });
    await coordinator.drain();
    const again = activeTurn(execution.id, "member:engineer");
    expect(again.spec.prompt).toContain("Reviewer changed review.txt, shared.txt");
    expect(again.spec.prompt).toContain("While you worked, Reviewer also changed shared.txt. Check those files before continuing.");
    await finish(again, "Merged the shared change.");
    expect(
      coordinator
        .status(execution.id)
        .attempts.filter((item) => item.actorId === "member:engineer")
        .at(-1)?.changedFiles,
    ).toEqual([]);
    await finish(lead, "Done.");
    expect(coordinator.status(execution.id).state).toBe("completed");
  });
});

describe("warm member processes", () => {
  const bindings = (executionId: string) => (db.stmt("SELECT COUNT(*) AS total FROM team_run_bindings WHERE execution_id=?").get(executionId) as { total: number }).total;

  it("starts a fresh process when the next turn needs something the running one was not started with", async () => {
    const execution = await startTeam();
    const lead = activeTurn(execution.id);
    coordinator.chat(execution.id, { text: "Engineer, first question", to: ["engineer"], requestKey: "q1" });
    await coordinator.drain();
    const engineer = activeTurn(execution.id, "member:engineer");
    await finish(engineer, "First answer.");
    // Permissions are fixed when a process starts, so a turn under a different policy needs its own.
    threads.update(db, thread.id, { permissionMode: "review" });
    coordinator.chat(execution.id, { text: "Engineer, second question", to: ["engineer"], requestKey: "q2" });
    await coordinator.drain();
    const again = activeTurn(execution.id, "member:engineer");
    expect(again.spec.runId).not.toBe(engineer.spec.runId);
    expect(again.spec.permissionMode).toBe("review");
    expect(engineer.exited).toBe(true);
    expect(bindings(execution.id)).toBe(3);
    await finish(again, "Second answer.");
    await finish(lead, "Done.");
  });

  it("refuses a tool call that reaches a member's process between turns", async () => {
    const execution = await startTeam();
    const lead = activeTurn(execution.id);
    coordinator.chat(execution.id, { text: "Engineer, have a look", to: ["engineer"], requestKey: "look" });
    await coordinator.drain();
    const engineer = activeTurn(execution.id, "member:engineer");
    expect(coordinator.say(engineer.spec.runId, { text: "During my turn", to: ["lead"], requestKey: "during" }).posted).toBe(true);
    await finish(engineer, "Looked.");
    // The process is still alive, so the call reaches the app; the turn it belonged to has ended, so it is refused.
    expect(coordinator.status(execution.id).attempts.findLast((item) => item.actorId === "member:engineer")?.state).toBe("closed");
    expect(() => coordinator.say(engineer.spec.runId, { text: "After my turn", to: ["lead"], requestKey: "after" })).toThrow(/no longer has active authority/);
    expect(() => coordinator.wait(engineer.spec.runId)).toThrow(/no longer has active authority/);
    await finish(lead, "Done.");
  });

  it("captures the shared workspace when the room goes quiet, not when the lead finishes", async () => {
    const captureOutput = vi.fn(async (_executionId: string, _actorId: string) => {});
    coordinatorHooks.workspace = { beforeStart: async () => {}, captureOutput };
    const execution = await startTeam();
    const lead = activeTurn(execution.id);
    coordinator.chat(execution.id, { text: "Engineer, take a look", to: ["engineer"], requestKey: "look" });
    await coordinator.drain();
    const engineer = activeTurn(execution.id, "member:engineer");
    coordinator.complete(lead.spec.runId, { result: "Done from the lead" });
    await finish(lead);

    // The lead has finished, but the engineer is still talking, so the directory is untouched and its session kept.
    expect(captureOutput).not.toHaveBeenCalled();
    expect(coordinator.status(execution.id).state).toBe("active");
    expect(engineer.exited).toBe(false);
    // The conversation is not finished, so the operations that rewrite its files are still refused.
    expect(() => coordinator.assertQuiescent(thread.id)).toThrow();
    expect(coordinator.actorIdleReason(execution.id, "lead")).toMatch(/workspace capture/);

    await finish(engineer, "Looked.");
    expect(captureOutput).toHaveBeenCalledTimes(1);
    expect(captureOutput.mock.calls[0]?.[1]).toBe("lead");
    expect(coordinator.status(execution.id).state).toBe("completed");
    expect(engineer.exited).toBe(true);
    expect(() => coordinator.assertQuiescent(thread.id)).not.toThrow();
  });

  it("leaves a conversation open and in attention when its deferred capture fails", async () => {
    coordinatorHooks.workspace = {
      beforeStart: async () => {},
      captureOutput: async () => {
        throw new Error("disk full");
      },
    };
    const execution = await startTeam();
    const lead = activeTurn(execution.id);
    coordinator.complete(lead.spec.runId, { result: "Done from the lead" });
    await finish(lead);
    const after = coordinator.status(execution.id);
    // A terminal execution cannot be reopened, so a capture that failed must never have completed it first.
    expect(after.state).toBe("attention");
    expect(actor(execution.id, "lead").error).toMatch(/Output capture needs attention: disk full/);
    expect(() => coordinator.assertQuiescent(thread.id)).toThrow();
  });

  it("closes the sessions members keep open when the conversation is stopped", async () => {
    const execution = await startTeam();
    const lead = activeTurn(execution.id);
    coordinator.chat(execution.id, { text: "Engineer, have a look", to: ["engineer"], requestKey: "look" });
    await coordinator.drain();
    const engineer = activeTurn(execution.id, "member:engineer");
    await finish(engineer, "Looked.");
    expect(engineer.exited).toBe(false);
    await coordinator.stop(execution.id);
    expect(engineer.exited).toBe(true);
    expect(lead.exited).toBe(true);
    expect(coordinator.status(execution.id).state).toBe("stopped");
  });
});

describe("ambient participation", () => {
  const talkative = (discussion: Partial<NonNullable<TeamDraft["discussion"]>> = {}): TeamDraft => ({
    ...roster(),
    discussion: { ambientRounds: 1, peerFollowUps: 0, mentionOnly: [], ...discussion },
  });
  const participant = (executionId: string, key: string) => actor(executionId, `member:${key}`);

  it.each(["coordinator", "mention"])("delivers a late member message to the finished lead via %s", async (address) => {
    const execution = await startTeam({ ...talkative({ mentionOnly: address === "mention" ? ["engineer"] : [] }), limits: { ...roster().limits, maxConcurrentAgents: 1 } });
    if (address === "mention") coordinator.chat(execution.id, { text: "Engineer, check the plan.", to: ["engineer"], requestKey: "review-plan" });
    await debounce();
    await finish(activeTurn(execution.id), "Here is the initial plan.");
    expect(actor(execution.id, "lead").state).toBe("completed");
    expect(coordinator.status(execution.id).state).toBe("active");
    const engineer = activeTurn(execution.id, "member:engineer");
    const text = "@lead One correction to the plan.";
    if (address !== "mention") {
      const input = { text: "One correction to the plan.", to: [address], requestKey: "late-correction" };
      const receipt = coordinator.say(engineer.spec.runId, input);
      expect(receipt.delivered).toContainEqual({ member: "lead", delivery: "queued" });
      expect(coordinator.say(engineer.spec.runId, input)).toEqual(receipt);
    }
    await finish(engineer, address === "mention" ? text : "Shared my correction.");
    await coordinator.drain();
    const lead = activeTurn(execution.id);
    expect(lead.spec.prompt).toContain("One correction to the plan.");
    expect(coordinator.status(execution.id).messages.filter((message) => message.recipientId === "lead")).toHaveLength(1);
    await finish(lead, "Updated the plan.");
    await finish(activeTurn(execution.id, "member:reviewer"), "Nothing to add.");
    expect(coordinator.status(execution.id).state).toBe("completed");
    expect(() => coordinator.chat(execution.id, { text: "Too late", to: ["lead"], requestKey: "closed" })).toThrow(/stopped|replaced|complete/);
  });

  it("settles a greeting with nested ambient members while another conversation keeps using the checkout", async () => {
    const writers = new WorkspaceWriters();
    const workspaces = new TeamWorkspaceService(db, { dataDir: directory }, writers);
    coordinatorHooks.workspace = {
      beforeStart: async (id, _actorId, assertActive) => {
        await workspaces.prepare(id, "lead", assertActive);
      },
      captureOutput: (id, actorId, assertActive) => workspaces.captureOutput(id, actorId, assertActive),
    };
    const otherConversation = await writers.acquire(root, "Unrelated conversation", undefined, { shared: true });
    writers.onConflict(async () => {
      throw new Error("Unexpected wait for unrelated conversation");
    });
    try {
      const draft = talkative();
      draft.members[2]!.managerKey = "engineer";
      const saved = orchestration.save(db, { projectId: thread.projectId, expectedRevisionId: null, draft });
      const execution = await coordinator.start({ threadId: thread.id, teamRevisionId: saved.revision.id, prompt: "Hi guys" });
      await coordinator.drain();
      await debounce();
      await finish(activeTurn(execution.id, "member:engineer"), "Nothing to add.");
      await finish(activeTurn(execution.id, "member:reviewer"), "Nothing to add.");
      await finish(activeTurn(execution.id), "Hey Alex! What are we working on today?");
      const final = coordinator.status(execution.id);
      expect(final.attempts.every((attempt) => attempt.state === "closed")).toBe(true);
      expect(final.messages).toHaveLength(0);
      expect(final.state).toBe("completed");
      const settings = new AppSettingsService(db);
      const conversation = new TeamConversationService(
        db,
        coordinator,
        runService,
        settings,
        () => {},
        () => null,
      );
      expect(conversation.runtime(thread.id)?.executions.at(-1)?.activity).toBe("idle");
      expect(await writers.reason([root])).toContain("Unrelated conversation");
    } finally {
      otherConversation.release();
      await workspaces.shutdown();
    }
  });

  it("keeps a chat turn's public reply and confirmed input when only the workspace snapshot fails", async () => {
    const execution = await startTeam();
    const lead = activeTurn(execution.id);
    coordinator.chat(execution.id, { text: "Engineer, note something down", to: ["engineer"], requestKey: "note" });
    await coordinator.drain();
    const engineer = activeTurn(execution.id, "member:engineer");
    await writeFile(path.join(engineer.spec.cwd, "note.txt"), "a change the checkpoint would record\n");
    const failing = vi.spyOn(checkpoints, "insert").mockImplementationOnce(() => {
      throw new Error("disk full");
    });
    await finish(engineer, "Noted: the change is in note.txt.");
    failing.mockRestore();
    const { teamRoom: room } = await import("@openorc/db");
    const after = coordinator.status(execution.id);
    const attempt = after.attempts.find((item) => item.actorId === "member:engineer")!;
    // The reply is public and the input confirmed; the capture failure stays on the turn instead of blocking the member.
    expect(attempt.state).toBe("closed");
    expect(attempt.outcome).toBe("public");
    expect(attempt.snapshotId).toBeNull();
    expect(attempt.error).toMatch(/Checkpoint failed: disk full/);
    expect(participant(execution.id, "engineer").state).toBe("waiting");
    expect(after.state).toBe("active");
    expect(room.list(db, execution.instanceId).map((event) => event.body)).toContain("Noted: the change is in note.txt.");
    expect(room.deliveries(db, execution.instanceId, { actorId: "member:engineer" }).map((delivery) => delivery.state)).toEqual(["confirmed"]);
    await finish(lead, "Thanks.");
    expect(coordinator.status(execution.id).state).toBe("completed");
  });

  it("drops pending reads on restart; the next turn's room slice carries what was missed", async () => {
    const execution = await startTeam(talkative());
    expect(execution.actors.filter((item) => item.participant).every((item) => item.ambient)).toBe(true);
    const restarted = new TeamCoordinator(db, runService, coordinatorHooks);
    restarted.recover();
    const recovered = restarted.status(execution.id);
    expect(recovered.state).toBe("attention");
    expect(recovered.actors.every((item) => !item.ambient)).toBe(true);
    expect(recovered.actors.filter((item) => item.participant).map((item) => item.state)).toEqual(["waiting", "waiting"]);
  });

  it("drops pending reads when the execution stops", async () => {
    const execution = await startTeam(talkative());
    expect(execution.actors.filter((item) => item.participant).every((item) => item.ambient)).toBe(true);
    await coordinator.stop(execution.id);
    const stopped = coordinator.status(execution.id);
    expect(stopped.state).toBe("stopped");
    expect(stopped.actors.every((item) => !item.ambient)).toBe(true);
    await debounce();
    expect(coordinator.status(execution.id).attempts).toHaveLength(1);
  });
});

describe("team conversation view", () => {
  const view = (threadId = thread.id) =>
    new TeamConversationService(
      db,
      coordinator,
      runService,
      new AppSettingsService(db),
      () => {},
      () => null,
    ).runtime(threadId)!;

  it("names the chat entry that carries an opening message addressed to members, and places turns by when they finished", async () => {
    const saved = orchestration.save(db, { projectId: project.id, expectedRevisionId: null, draft: roster() });
    const plan = await coordinator.validateStart({ projectId: project.id, teamRevisionId: saved.revision.id });
    const execution = coordinator.admit({ threadId: thread.id, prompt: "Engineer, check the build", plan, addressed: ["member:engineer"], requestKey: "opening" });
    await coordinator.drain();
    const opening = view().executions[0]!;
    expect(opening.initialPrompt.chatId).toBe(opening.chat?.find((entry) => entry.text === "Engineer, check the build")?.id);
    const engineer = () => view().executions[0]!.actors.find((actor) => actor.id === "member:engineer")!;
    expect(engineer().runs[0]).toMatchObject({ endedAt: null });
    await finish(activeTurn(execution.id, "member:engineer"), "The build passes.");
    expect(engineer().runs[0]!.endedAt).toBe(coordinator.status(execution.id).attempts.find((attempt) => attempt.actorId === "member:engineer")!.endedAt);
    const leadOnly = await startTeam(roster(), newThread());
    expect(view(leadOnly.threadId).executions[0]!.initialPrompt.chatId).toBeUndefined();
  });

  it("names the manager turn that delegated each assignment, and infers it for journals from before it was kept", async () => {
    const { execution, lead, manager, managerTurn, worker } = await nestedWorking();
    const leadTurn = coordinator.status(execution.id).attempts.find((attempt) => attempt.runId === lead.spec.runId)!;
    const delegating = coordinator.status(execution.id).attempts.find((attempt) => attempt.runId === managerTurn.spec.runId)!;
    expect(actor(execution.id, manager.id).dispatchedBy).toBe(leadTurn.id);
    expect(actor(execution.id, worker.id).dispatchedBy).toBe(delegating.id);
    const shown = () => view().executions[0]!.actors;
    expect(shown().find((item) => item.id === worker.id)?.dispatchedBy).toBe(delegating.id);
    expect(shown().find((item) => item.id === "member:engineer")?.dispatchedBy).toBeUndefined();
    // An older journal never recorded it: the manager's turn before the worker's first turn is the one.
    db.stmt("UPDATE team_actors SET details = json_remove(details, '$.dispatchedBy') WHERE execution_id = ? AND id = ?").run(execution.id, worker.id);
    expect(actor(execution.id, worker.id).dispatchedBy).toBeUndefined();
    expect(shown().find((item) => item.id === worker.id)?.dispatchedBy).toBe(delegating.id);
  });

  it("keeps every team_say message of an execution after the room grows past 500 messages", async () => {
    const execution = await startTeam();
    teamRoom.append(db, {
      instanceId: execution.instanceId,
      authorKind: "member",
      authorId: "member:engineer",
      body: "An early note",
      addressees: ["member:reviewer"],
      executionId: execution.id,
      source: "say",
      requestKey: "say:early",
    });
    for (let index = 0; index < 510; index++)
      teamRoom.append(db, { instanceId: execution.instanceId, authorKind: "user", authorId: "user", body: `Later message ${index}`, addressees: ["lead"], executionId: null, source: "chat" });
    expect(view().executions[0]!.chat?.map((entry) => entry.text)).toContain("An early note");
  });
});

describe("team plan documents and implementation", () => {
  function service() {
    const settings = new AppSettingsService(db);
    settings.set({ experimentalTeamExecution: true });
    return new TeamConversationService(
      db,
      coordinator,
      runService,
      settings,
      () => {},
      () => null,
      undefined,
      undefined,
      (id) => {
        runService.assertThreadPermissions(id);
        const updated = threads.update(db, id, { mode: "act" });
        runService.applyThreadPermissions(updated);
        coordinator.modeChanged(id);
      },
    );
  }
  function emitPlan(turn: ScriptedTurn, id: string, text = "# Approved team plan\nAsk @Engineer to implement, then review.") {
    turn.handle.emit("event", { type: "plan.updated", runId: turn.spec.runId, ts: Date.now(), documentId: id, text, complete: true });
  }

  it("captures only the lead's native document and resumes the same team once with saved permissions", async () => {
    threads.update(db, thread.id, { mode: "plan", permissionMode: "review" });
    const execution = await startTeam();
    const lead = activeTurn(execution.id);
    coordinator.chat(execution.id, { text: "Review the proposal", to: ["engineer"], requestKey: "consult" });
    await coordinator.drain();
    const member = activeTurn(execution.id, "member:engineer");
    emitPlan(member, "member-proposal", "# A member's proposal");
    expect(plans.list(db, thread.id)).toEqual([]);
    emitPlan(lead, "lead-proposal");
    const plan = plans.list(db, thread.id)[0]!;
    expect(plan).toMatchObject({ runId: lead.spec.runId, source: "native", state: "ready" });
    const control = service();
    await expect(control.implementPlan({ threadId: thread.id, planId: plan.id })).rejects.toThrow("current turns");
    expect(threads.get(db, thread.id)?.mode).toBe("plan");
    coordinator.wait(member.spec.runId);
    await finish(member);
    coordinator.wait(lead.spec.runId);
    await finish(lead);
    const before = coordinator.status(execution.id).attempts.length;
    await Promise.all([control.implementPlan({ threadId: thread.id, planId: plan.id }), control.implementPlan({ threadId: thread.id, planId: plan.id })]);
    await coordinator.drain();
    const implementation = activeTurn(execution.id);
    expect(implementation.spec.mode).toBe("act");
    expect(implementation.spec.permissionMode).toBe("review");
    expect(implementation.spec.prompt).toContain(plan.text);
    expect(threads.get(db, thread.id)).toMatchObject({ mode: "act", permissionMode: "review" });
    expect(coordinator.status(execution.id).attempts).toHaveLength(before + 1);
    expect(teamRuntime.findUserDirection(db, thread.id, `plan.implementation:${plan.id}`)?.message.body).toContain(plan.text);
    expect(teamRuntime.findUserChat(db, thread.id, `plan.implementation:${plan.id}`)).toBeNull();
  });

  it("rejects stale and unfinished revisions and starts a new team execution after completion", async () => {
    threads.update(db, thread.id, { mode: "plan", permissionMode: "trusted" });
    const execution = await startTeam();
    const lead = activeTurn(execution.id);
    emitPlan(lead, "first");
    const old = plans.list(db, thread.id)[0]!;
    lead.handle.emit("event", { type: "plan.updated", runId: lead.spec.runId, ts: Date.now(), documentId: "next", text: "# New plan", delta: true });
    const current = plans.list(db, thread.id)[0]!;
    const control = service();
    await expect(control.implementPlan({ threadId: thread.id, planId: old.id })).rejects.toThrow("latest completed");
    await expect(control.implementPlan({ threadId: thread.id, planId: current.id })).rejects.toThrow("latest completed");
    emitPlan(lead, "next", "# New plan");
    coordinator.complete(lead.spec.runId, { result: "Planning finished" });
    await finish(lead);
    expect(coordinator.status(execution.id).state).toBe("completed");
    const result = await control.implementPlan({ threadId: thread.id, planId: current.id });
    await coordinator.drain();
    const next = result.executions.at(-1)!;
    expect(next.id).not.toBe(execution.id);
    const implementation = activeTurn(next.id);
    expect(implementation.spec).toMatchObject({ mode: "act", permissionMode: "trusted" });
    expect(implementation.spec.prompt).toContain("# New plan");
    await control.implementPlan({ threadId: thread.id, planId: current.id });
    expect(teamRuntime.activeForThread(db, thread.id)?.id).toBe(next.id);
  });
});
