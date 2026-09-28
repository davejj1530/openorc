import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeAdapter, CodexAdapter, RunHandle } from "@openorc/agents";
import { comments, projects, settings, snapshots, taskForwardings, tasks, teamTaskCompletions, teamTasks, teamWorkspaces } from "@openorc/db";
import { commitAll, git } from "@openorc/git";
import {
  DEFAULT_TEAM_LIMITS,
  teamReviewComment,
  type CorePush,
  type Project,
  type RpcMethod,
  type RpcParams,
  type RpcResults,
  type RunSpec,
  type TeamDraft,
  type TeamTaskActionResult,
} from "@openorc/protocol";
import { OpenOrc } from "./openorc.js";
import { TaskForwardingService } from "./services/task-forwarding.js";

interface Turn {
  spec: RunSpec;
  handle: RunHandle;
  exited: boolean;
}
let core: OpenOrc;
let directory: string;
let project: Project;
let pushed: CorePush[];
let turns: Map<string, Turn>;
let rpcId = 0;

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "openorc-task-activation-"));
  const root = path.join(directory, "repository");
  await mkdir(root);
  await git(root, ["init", "-q", "-b", "main"]);
  await git(root, ["config", "user.email", "fixture@example.com"]);
  await git(root, ["config", "user.name", "Fixture"]);
  await writeFile(path.join(root, "README.md"), "# Task activation fixture\n");
  await commitAll(root, "Fixture baseline");
  turns = new Map();
  pushed = [];
  const start = (spec: RunSpec) => {
    let resolve!: (code: number) => void;
    const done = new Promise<number>((next) => {
      resolve = next;
    });
    const turn: Turn = {
      spec,
      exited: false,
      handle: new RunHandle(spec.runId, {
        done,
        send: async () => {
          throw new Error("Use the team mailbox");
        },
        interrupt() {},
        close() {
          if (turn.exited) return;
          turn.exited = true;
          turn.handle.emit("exit", 0);
          resolve(0);
        },
      }),
    };
    turns.set(spec.runId, turn);
    return turn.handle;
  };
  vi.spyOn(CodexAdapter.prototype, "start").mockImplementation(start);
  vi.spyOn(ClaudeAdapter.prototype, "start").mockImplementation(start);
  core = await OpenOrc.create({ dataDir: path.join(directory, "data"), ephemeral: true, transport: { push: (message) => pushed.push(message) } });
  settings.set(core.db, "extraction.provider", "off");
  project = projects.insert(core.db, { name: "Fixture", rootPath: root, gitRemote: null, defaultBranch: "main", settings: {} });
  vi.spyOn(core.orchestration, "preflight").mockResolvedValue({ ready: true, issues: [] });
  vi.spyOn(core.runs, "models").mockImplementation(async (agent) => [
    { id: `fixture-${agent}`, label: "Scripted provider", agent: agent ?? "codex", isDefault: true, efforts: ["medium", "high"], defaultEffort: "high", fastMode: { supported: false } },
  ]);
  await call("app.settings.set", { experimentalTeamExecution: true });
});
afterEach(async () => {
  if (core) await core.close();
  vi.restoreAllMocks();
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function call<M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResults[M]> {
  const id = ++rpcId;
  await core.handle({ type: "rpc", id, method, params });
  const response = pushed.find((message) => (message.type === "rpc.result" || message.type === "rpc.error") && message.id === id);
  if (!response || (response.type !== "rpc.result" && response.type !== "rpc.error")) throw new Error("Missing RPC response");
  if (response.type === "rpc.error") throw new Error(response.message);
  return response.result as RpcResults[M];
}
async function tool(turn: Turn, name: string, args: Record<string, unknown>) {
  const response = await fetch((await core.mcpServer()).urlForRun(turn.spec.runId), {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    signal: AbortSignal.timeout(4000),
  });
  const raw = await response.text();
  const payload = JSON.parse(
    raw.startsWith("{")
      ? raw
      : raw
          .split("\n")
          .find((line) => line.startsWith("data: "))!
          .slice(6),
  );
  if (payload.error) throw new Error(payload.error.message);
  if (payload.result.isError) throw new Error(payload.result.content.map((item: { text?: string }) => item.text ?? "").join("\n"));
  return JSON.parse(payload.result.content[0].text);
}
function active(executionId: string, actorId = "lead"): Turn {
  const runId = core.teams.status(executionId).attempts.findLast((item) => item.actorId === actorId && item.runId)?.runId;
  const turn = runId ? turns.get(runId) : null;
  if (!turn || turn.exited) throw new Error(`No active provider for ${actorId}`);
  return turn;
}
async function finish(turn: Turn, executionId: string) {
  const { runId, agent, model } = turn.spec;
  turn.handle.emit("event", { type: "session.started", runId, agent, model: model ?? "fixture", externalSessionId: `session-${runId}`, ts: Date.now() });
  turn.handle.emit("event", { type: "message.completed", runId, role: "assistant", messageId: `reply-${runId}`, text: "Scripted result", ts: Date.now() });
  turn.handle.emit("event", { type: "turn.completed", runId, turnId: `turn-${runId}`, status: "success", durationMs: 1, ts: Date.now() });
  await vi.waitFor(() => expect(core.teams.status(executionId).attempts.find((item) => item.runId === runId)?.state).toBe("closed"), { timeout: 10000 });
  await core.teams.drain();
}
function executionOf(action: TeamTaskActionResult): string {
  const id = action.task.admissions.find((item) => item.id === action.admissionId)?.executionId;
  if (!id) throw new Error("Admission was not routed");
  return id;
}
async function captured(agent: "codex" | "claude" = "codex", worker = false) {
  const members: TeamDraft["members"] = [
    { key: "lead", name: "Lead", managerKey: null, responsibility: "Coordinate", settings: { agent, model: `fixture-${agent}`, effort: "high", fastMode: false } },
  ];
  if (worker)
    members.push({ key: "worker", name: "Worker", managerKey: "lead", responsibility: "Implement", settings: { agent: "claude", model: "fixture-claude", effort: "medium", fastMode: false } });
  const saved = await call("orchestration.save", {
    projectId: project.id,
    expectedRevisionId: null,
    draft: { name: "Saved task team", members, limits: { ...DEFAULT_TEAM_LIMITS }, discussion: { ambientRounds: 0, peerFollowUps: 0, mentionOnly: [] } },
  });
  const started = await call("threads.start", {
    projectId: project.id,
    executionTarget: { kind: "team", teamRevisionId: saved.revision.id },
    mode: "act",
    permissionMode: "trusted",
    prompt: "Capture work for later",
  });
  const runtime = (await call("orchestration.runtime", { threadId: started.thread.id }))!;
  const executionId = runtime.executions[0]!.id;
  await core.teams.drain();
  const lead = active(executionId);
  const capture: { task: { id: string }; started: boolean } = await tool(lead, "task_create", {
    title: "Saved implementation",
    spec: "Original captured requirement.",
    ...(worker ? { member_key: "worker" } : {}),
    request_key: "capture-once",
  });
  expect(capture.started).toBe(false);
  expect(core.teams.status(executionId).actors.filter((item) => !item.participant)).toHaveLength(1);
  const task = tasks.get(core.db, capture.task.id)!;
  expect(task.worktreePath).toBeNull();
  await finish(lead, executionId);
  expect(core.teams.status(executionId).state).toBe("completed");
  return { task, thread: started.thread };
}
async function completeLead(taskId: string, action: TeamTaskActionResult, output = "initial result\n") {
  const executionId = executionOf(action);
  await core.teams.drain();
  const lead = active(executionId);
  await writeFile(path.join(lead.spec.cwd, "implementation.txt"), output);
  await tool(lead, "task_complete", { id: taskId, admission_id: action.admissionId, result: "Completed the saved task." });
  await tool(lead, "task_complete", { id: taskId, admission_id: action.admissionId, result: "Completed the saved task." });
  expect(teamTaskCompletions.get(core.db, action.admissionId)).toBeNull();
  await finish(lead, executionId);
  expect(core.teams.status(executionId).state).toBe("completed");
  return { lead, executionId };
}

describe("saved team task activation through RPC and real MCP", () => {
  it("waits for live direction before allowing a lead task completion intent", async () => {
    const { task, thread } = await captured();
    const action = await call("orchestration.tasks.start", { taskId: task.id, requestKey: "live-task" });
    const executionId = executionOf(action);
    await core.teams.drain();
    const lead = active(executionId);
    let accept!: (result: "accepted") => void;
    const acknowledgement = new Promise<"accepted">((resolve) => {
      accept = resolve;
    });
    vi.spyOn(lead.handle, "canSteer", "get").mockReturnValue(true);
    const delivery = vi.spyOn(lead.handle, "steer").mockReturnValue(acknowledgement);
    try {
      await call("orchestration.send", { threadId: thread.id, text: "Include this live correction before completing", requestKey: "task-correction", now: true });
      await vi.waitFor(() => expect(delivery).toHaveBeenCalledTimes(1));
      await expect(tool(lead, "task_complete", { id: task.id, admission_id: action.admissionId, result: "Premature task result" })).rejects.toThrow(/direction.*not been confirmed/i);
      expect(teamTaskCompletions.intentsForAttempt(core.db, executionId, core.teams.binding(lead.spec.runId)!.attemptId)).toEqual([]);
    } finally {
      accept("accepted");
    }
    await core.teams.drain();
    await completeLead(task.id, action, "Result includes the live correction\n");
    expect(teamTaskCompletions.get(core.db, action.admissionId)?.runId).toBe(lead.spec.runId);
    expect(core.teams.status(executionId).messages.find((message) => message.body.includes("live correction"))?.state).toBe("delivered");
    expect(delivery).toHaveBeenCalledTimes(1);
  });

  it.each(["claude"] as const)("starts a captured task with %s lead and finalizes its own captured task snapshot", async (agent) => {
    const { task } = await captured(agent);
    await call("tasks.update", { id: task.id, patch: { spec: "Edited saved requirement before activation." } });
    const request = { taskId: task.id, requestKey: "activate-once" };
    const action = await call("orchestration.tasks.start", request);
    expect((await call("orchestration.tasks.start", request)).admissionId).toBe(action.admissionId);
    expect(teamTasks.admission(core.db, action.admissionId)?.input.spec).toBe("Edited saved requirement before activation.");
    // A board move does not stop the execution or fabricate its completion.
    expect((await call("orchestration.taskState", { taskId: task.id }))?.working).toBe(true);
    await call("tasks.update", { id: task.id, patch: { status: "done" } });
    expect((await call("orchestration.taskState", { taskId: task.id }))?.working).toBe(true);
    expect(teamTaskCompletions.get(core.db, action.admissionId)).toBeNull();
    const { lead } = await completeLead(task.id, action);
    const receipt = teamTaskCompletions.get(core.db, action.admissionId)!;
    expect(receipt).toMatchObject({ admissionId: action.admissionId, runId: lead.spec.runId, actorId: "lead" });
    expect(snapshots.get(core.db, receipt.snapshotId)).toMatchObject({ taskId: task.id, runId: lead.spec.runId });
    expect(tasks.get(core.db, task.id)?.status).toBe("done");
    expect(tasks.list(core.db)).toHaveLength(1);
    expect((await call("orchestration.taskState", { taskId: task.id }))?.admissions[0]).toMatchObject({ id: action.admissionId, state: "completed" });
    // A finished task is the user's to close.
    expect((await call("orchestration.taskState", { taskId: task.id }))?.working).toBe(false);
    await call("tasks.update", { id: task.id, patch: { status: "done" } });
    expect(tasks.get(core.db, task.id)?.status).toBe("done");
  });

  it("retains explicit review selection and replay after source comments change or disappear", async () => {
    const { task } = await captured();
    await completeLead(task.id, await call("orchestration.tasks.start", { taskId: task.id, requestKey: "initial" }));
    const first = core.review.addComment({
      taskId: task.id,
      path: "implementation.txt",
      startLine: null,
      startSide: null,
      line: 1,
      side: "new",
      lineText: null,
      body: "First feedback\nKeep precise whitespace.",
    });
    const omitted = core.review.addComment({ taskId: task.id, path: "README.md", startLine: null, startSide: null, line: null, side: null, lineText: null, body: "Leave this unsent." });
    const last = core.review.addComment({ taskId: task.id, path: "implementation.txt", startLine: null, startSide: null, line: 2, side: "old", lineText: null, body: "Second selected feedback." });
    // A retained batch keeps a frozen single-line copy of each comment.
    expect(() => core.review.addComment({ taskId: task.id, path: "implementation.txt", startLine: 1, startSide: "new", line: 2, side: "new", lineText: null, body: "Range feedback." })).toThrow(
      /one line/,
    );
    const request = { taskId: task.id, commentIds: [last.id, first.id], requestKey: "review-once" };
    const action = await call("orchestration.review.send", request);
    const batchId = teamTasks.admission(core.db, action.admissionId)!.reviewBatchId!;
    core.db.stmt("UPDATE review_comments SET body = 'changed later' WHERE id = ?").run(first.id);
    comments.remove(core.db, last.id);
    expect((await call("orchestration.review.send", request)).admissionId).toBe(action.admissionId);
    await expect(call("orchestration.review.send", { ...request, commentIds: [...request.commentIds].reverse() })).rejects.toThrow(/different/);
    expect(teamTasks.batch(core.db, batchId)?.comments).toEqual([last, first].map(teamReviewComment));
    const { lead } = await completeLead(task.id, action, "reviewed result\n");
    expect(lead.spec.prompt).toContain(teamTasks.batch(core.db, batchId)!.prompt);
    expect(comments.listForTask(core.db, task.id).find((item) => item.id === first.id)?.sentInRunId).toBe(lead.spec.runId);
    expect(comments.listForTask(core.db, task.id).find((item) => item.id === omitted.id)?.sentInRunId).toBeNull();
    expect((await call("orchestration.review.send", request)).admissionId).toBe(action.admissionId);
    expect(teamTasks.admissions(core.db, task.id)).toHaveLength(2);
  });

  it("retries a stopped admission with retained input rather than later document edits", async () => {
    const { task, thread } = await captured();
    const original = await call("orchestration.tasks.start", { taskId: task.id, requestKey: "before-stop" });
    await core.teams.drain();
    const oldLead = active(executionOf(original));
    await call("orchestration.stop", { threadId: thread.id, executionId: executionOf(original) });
    await call("tasks.update", { id: task.id, patch: { spec: "Later document edit must not replace retained retry." } });
    const input = { taskId: task.id, admissionId: original.admissionId, requestKey: "retry-once" };
    const retried = await call("orchestration.tasks.retry", input);
    expect(retried.admissionId).not.toBe(original.admissionId);
    expect((await call("orchestration.tasks.retry", input)).admissionId).toBe(retried.admissionId);
    expect(teamTasks.admission(core.db, retried.admissionId)).toMatchObject({ sourceAdmissionId: original.admissionId, input: { spec: "Original captured requirement." } });
    await expect(tool(oldLead, "task_complete", { id: task.id, admission_id: original.admissionId, result: "Late old result" })).rejects.toThrow();
    await completeLead(task.id, retried);
    expect(teamTaskCompletions.get(core.db, original.admissionId)).toBeNull();
    expect(teamTaskCompletions.get(core.db, retried.admissionId)).not.toBeNull();
    const completedState = await call("orchestration.taskState", { taskId: task.id });
    expect(completedState?.admissions.find((item) => item.id === original.admissionId)?.retry.allowed).toBe(false);
    await expect(call("orchestration.tasks.retry", { ...input, requestKey: "duplicate-old-retry" })).rejects.toThrow(/already retried/);
    expect(teamTasks.admissions(core.db, task.id)).toHaveLength(2);
  });

  it("reuses a direct worker task ID for review with a new actor, fresh session and one new output receipt", async () => {
    const { task } = await captured("codex", true);
    async function assign(action: TeamTaskActionResult, filename: string) {
      const executionId = executionOf(action);
      await core.teams.drain();
      const lead = active(executionId);
      const request = { id: task.id, admission_id: action.admissionId, member_key: "worker" };
      await tool(lead, "task_start", request);
      await tool(lead, "task_start", request);
      const worker = core.teams.status(executionId).actors.find((item) => item.taskId === task.id)!;
      expect(core.teams.status(executionId).actors.filter((item) => !item.participant)).toHaveLength(2);
      await tool(lead, "team_wait", { assignment_ids: [worker.id] });
      await finish(lead, executionId);
      const turn = active(executionId, worker.id);
      expect(turn.spec.resumeSessionId).toBeUndefined();
      if (filename === "review.txt") expect(await readFile(path.join(turn.spec.cwd, "original.txt"), "utf8")).toBe("retained worker output\n");
      await writeFile(path.join(turn.spec.cwd, filename), "retained worker output\n");
      await tool(turn, "team_complete", { result: `Finished ${filename}` });
      await finish(turn, executionId);
      const resumed = active(executionId);
      expect(await readFile(path.join(resumed.spec.cwd, filename), "utf8")).toBe("retained worker output\n");
      await tool(resumed, "team_complete", { result: "Integrated worker result." });
      await finish(resumed, executionId);
      expect(teamWorkspaces.publications(core.db, executionId)).toHaveLength(1);
      expect(teamWorkspaces.publications(core.db, executionId)[0]?.state).toBe("applied");
      return worker;
    }
    const first = await assign(await call("orchestration.tasks.start", { taskId: task.id, requestKey: "worker-initial" }), "original.txt");
    const comment = core.review.addComment({
      taskId: task.id,
      path: "original.txt",
      startLine: null,
      startSide: null,
      line: 1,
      side: "new",
      lineText: null,
      body: "Add the review output while preserving this file.",
    });
    const next = await assign(await call("orchestration.review.send", { taskId: task.id, commentIds: [comment.id], requestKey: "worker-review" }), "review.txt");
    expect(next.id).not.toBe(first.id);
    expect(next.taskId).toBe(first.taskId);
    expect(tasks.list(core.db)).toHaveLength(1);
    expect((await call("orchestration.taskState", { taskId: task.id }))?.assignments.map((item) => item.actorId)).toEqual([first.id, next.id]);
  });

  it("delivers active worker review on the next turn and retains claimed comments until a successful captured retry", async () => {
    const { task, thread } = await captured("codex", true);
    const initial = await call("orchestration.tasks.start", { taskId: task.id, requestKey: "active-worker" });
    const executionId = executionOf(initial);
    await core.teams.drain();
    const lead = active(executionId);
    await tool(lead, "task_start", { id: task.id, admission_id: initial.admissionId, member_key: "worker" });
    const worker = core.teams.status(executionId).actors.find((item) => item.taskId === task.id)!;
    await tool(lead, "team_wait", { assignment_ids: [worker.id] });
    await finish(lead, executionId);
    const first = active(executionId, worker.id);
    const selected = core.review.addComment({
      taskId: task.id,
      path: "README.md",
      startLine: null,
      startSide: null,
      line: 1,
      side: "new",
      lineText: null,
      body: "Handle this precise feedback in the next turn.",
    });
    const omitted = core.review.addComment({ taskId: task.id, path: "README.md", startLine: null, startSide: null, line: 2, side: "new", lineText: null, body: "Do not send this unrelated comment." });
    const withdrawn = core.review.addComment({
      taskId: task.id,
      path: "README.md",
      startLine: null,
      startSide: null,
      line: 3,
      side: "new",
      lineText: null,
      body: "Withdraw this feedback before delivery.",
    });
    const action = await call("orchestration.review.send", { taskId: task.id, commentIds: [selected.id], requestKey: "active-review" });
    expect(executionOf(action)).toBe(executionId);
    const cancelled = await call("orchestration.review.send", { taskId: task.id, commentIds: [withdrawn.id], requestKey: "cancelled-review" });
    const cancelledRoute = teamTasks.routes(core.db, cancelled.admissionId).at(-1)!;
    await call("orchestration.cancelDirection", { threadId: thread.id, executionId, messageId: cancelledRoute.messageId! });
    const route = teamTasks.routes(core.db, action.admissionId).at(-1)!;
    expect(route).toMatchObject({ actorId: worker.id, role: "assignee" });
    const message = () => core.teams.status(executionId).messages.find((item) => item.id === route.messageId)!;
    const savedComment = () => comments.listForTask(core.db, task.id).find((item) => item.id === selected.id)!;
    expect(message().state).toBe("pending");
    expect(savedComment().sentInRunId).toBeNull();
    await expect(tool(first, "team_complete", { result: "Premature completion before feedback." })).rejects.toThrow(/New direction arrived/);
    await finish(first, executionId);
    const second = active(executionId, worker.id);
    const batchId = teamTasks.admission(core.db, action.admissionId)!.reviewBatchId!;
    expect(second.spec.prompt).toContain(teamTasks.batch(core.db, batchId)!.prompt);
    expect(second.spec.prompt).not.toContain(omitted.body);
    expect(second.spec.prompt).not.toContain(withdrawn.body);
    expect(second.spec.resumeSessionId).toBe(`session-${first.spec.runId}`);
    expect(message()).toMatchObject({ state: "claimed", attemptId: core.teams.binding(second.spec.runId)!.attemptId });
    await expect(call("review.comments.remove", { taskId: task.id, id: selected.id })).rejects.toThrow(/retained team feedback/i);
    expect(savedComment().sentInRunId).toBeNull();
    await tool(second, "team_complete", { result: "Handled feedback before provider failure." });
    second.handle.emit("event", { type: "error", runId: second.spec.runId, ts: Date.now(), fatal: true, message: "Scripted failure before successful capture." });
    await finish(second, executionId);
    expect(core.teams.status(executionId).actors.find((item) => item.id === worker.id)?.state).toBe("attention");
    expect(savedComment().sentInRunId).toBeNull();
    const waitingLead = active(executionId);
    await tool(waitingLead, "team_wait", { assignment_ids: [worker.id] });
    await finish(waitingLead, executionId);
    await call("orchestration.retry", { threadId: thread.id, executionId, actorId: worker.id });
    await core.teams.drain();
    const recovered = active(executionId, worker.id);
    expect(recovered.spec.prompt).toContain(teamTasks.batch(core.db, batchId)!.prompt);
    expect(savedComment().sentInRunId).toBeNull();
    await writeFile(path.join(recovered.spec.cwd, "review-result.txt"), "Feedback applied successfully\n");
    await tool(recovered, "team_complete", { result: "Captured the reviewed implementation." });
    await finish(recovered, executionId);
    expect(message().state).toBe("delivered");
    expect(savedComment().sentInRunId).toBe(recovered.spec.runId);
    expect(comments.listForTask(core.db, task.id).find((item) => item.id === omitted.id)?.sentInRunId).toBeNull();
    expect(comments.listForTask(core.db, task.id).find((item) => item.id === withdrawn.id)?.sentInRunId).toBeNull();
    expect(snapshots.listForTask(core.db, task.id).some((item) => item.runId === recovered.spec.runId)).toBe(true);
    const resumedLead = active(executionId);
    expect(await readFile(path.join(resumedLead.spec.cwd, "review-result.txt"), "utf8")).toBe("Feedback applied successfully\n");
    await tool(resumedLead, "team_complete", { result: "Accepted the reviewed task." });
    await finish(resumedLead, executionId);
    const taskState = (await call("orchestration.taskState", { taskId: task.id }))!;
    expect(taskState.admissions.find((item) => item.id === action.admissionId)?.state).toBe("completed");
    expect(taskState.admissions.find((item) => item.id === cancelled.admissionId)?.state).toBe("stopped");
  }, 30000);

  it("completes a lead task after a later accepted task direction is cancelled without starting another turn", async () => {
    const { task, thread } = await captured();
    const initial = await call("orchestration.tasks.start", { taskId: task.id, requestKey: "lead-task" });
    const executionId = executionOf(initial);
    await core.teams.drain();
    const lead = active(executionId);
    const later: { task: { id: string } } = await tool(lead, "task_create", { title: "Later captured task", spec: "This later request will be withdrawn.", request_key: "later-capture" });
    await writeFile(path.join(lead.spec.cwd, "completed-task.txt"), "Keep the completed task\n");
    await tool(lead, "task_complete", { id: task.id, admission_id: initial.admissionId, result: "Completed the original task." });
    const late = await call("orchestration.tasks.start", { taskId: later.task.id, requestKey: "late-task" });
    expect(executionOf(late)).toBe(executionId);
    const route = teamTasks.routes(core.db, late.admissionId).at(-1)!;
    expect(route.messageId).not.toBeNull();
    await call("orchestration.cancelDirection", { threadId: thread.id, executionId, messageId: route.messageId! });
    await finish(lead, executionId);
    expect(core.teams.status(executionId)).toMatchObject({ state: "completed", attempts: [expect.objectContaining({ runId: lead.spec.runId, state: "closed" })] });
    expect(core.teams.status(executionId).attempts).toHaveLength(1);
    expect(teamTaskCompletions.get(core.db, initial.admissionId)?.runId).toBe(lead.spec.runId);
    expect(teamTaskCompletions.get(core.db, late.admissionId)).toBeNull();
    expect((await call("orchestration.taskState", { taskId: later.task.id }))?.admissions[0]).toMatchObject({ id: late.admissionId, state: "stopped", retry: { allowed: true } });
    expect(core.teams.status(executionId).messages.find((item) => item.id === route.messageId)).toMatchObject({ state: "cancelled", attemptId: null });
  });

  it("routes completed nested task feedback through the original manager and leaf task IDs with accepted files intact", async () => {
    const members: TeamDraft["members"] = [
      { key: "lead", name: "Lead", managerKey: null, responsibility: "Coordinate", settings: { agent: "codex", model: "fixture-codex", effort: "high", fastMode: false } },
      { key: "manager", name: "Manager", managerKey: "lead", responsibility: "Coordinate implementation", settings: { agent: "claude", model: "fixture-claude", effort: "medium", fastMode: false } },
      { key: "worker", name: "Worker", managerKey: "manager", responsibility: "Implement", settings: { agent: "codex", model: "fixture-codex", effort: "high", fastMode: false } },
    ];
    const saved = await call("orchestration.save", {
      projectId: project.id,
      expectedRevisionId: null,
      draft: { name: "Nested saved tasks", members, limits: { ...DEFAULT_TEAM_LIMITS }, discussion: { ambientRounds: 0, peerFollowUps: 0, mentionOnly: [] } },
    });
    const started = await call("threads.start", {
      projectId: project.id,
      executionTarget: { kind: "team", teamRevisionId: saved.revision.id },
      mode: "act",
      permissionMode: "trusted",
      prompt: "Capture nested work for later",
    });
    const captureExecutionId = (await call("orchestration.runtime", { threadId: started.thread.id }))!.executions[0]!.id;
    await core.teams.drain();
    const initialLead = active(captureExecutionId);
    const managerTask: { task: { id: string } } = await tool(initialLead, "task_create", {
      title: "Manage saved implementation",
      spec: "Capture the implementation and preserve its task ID.",
      execution: "delegate",
      member_key: "manager",
      request_key: "original-manager",
    });
    const originalManager = core.teams.status(captureExecutionId).actors.find((item) => item.taskId === managerTask.task.id)!;
    await tool(initialLead, "team_wait", { assignment_ids: [originalManager.id] });
    await finish(initialLead, captureExecutionId);
    const capturingManager = active(captureExecutionId, originalManager.id);
    const leaf: { task: { id: string }; started: boolean } = await tool(capturingManager, "task_create", {
      title: "Nested implementation",
      spec: "Implement the saved nested requirement.",
      member_key: "worker",
      request_key: "original-leaf",
    });
    expect(leaf.started).toBe(false);
    expect(tasks.get(core.db, leaf.task.id)?.parentTaskId).toBe(managerTask.task.id);
    await writeFile(path.join(capturingManager.spec.cwd, "manager-context.txt"), "Accepted manager context\n");
    await tool(capturingManager, "team_complete", { result: "Captured the implementation for later." });
    await finish(capturingManager, captureExecutionId);
    const initialResumed = active(captureExecutionId);
    await tool(initialResumed, "team_complete", { result: "The nested task is captured." });
    await finish(initialResumed, captureExecutionId);

    async function routeNested(action: TeamTaskActionResult, filename: string) {
      const executionId = executionOf(action);
      await core.teams.drain();
      const lead = active(executionId);
      await expect(tool(lead, "task_start", { id: leaf.task.id, admission_id: action.admissionId, member_key: "worker" })).rejects.toThrow(/manager.*first|hierarchy/i);
      await tool(lead, "task_start", { id: leaf.task.id, admission_id: action.admissionId, member_key: "manager" });
      const manager = core.teams.status(executionId).actors.find((item) => item.memberKey === "manager" && !item.participant)!;
      expect(manager).toMatchObject({ taskId: managerTask.task.id, parentId: "lead" });
      await tool(lead, "team_wait", { assignment_ids: [manager.id] });
      await finish(lead, executionId);
      const managerTurn = active(executionId, manager.id);
      expect(managerTurn.spec.resumeSessionId).toBeUndefined();
      expect(await readFile(path.join(managerTurn.spec.cwd, "manager-context.txt"), "utf8")).toBe("Accepted manager context\n");
      await tool(managerTurn, "task_start", { id: leaf.task.id, admission_id: action.admissionId, member_key: "worker" });
      const worker = core.teams.status(executionId).actors.find((item) => item.memberKey === "worker" && !item.participant)!;
      expect(worker).toMatchObject({ taskId: leaf.task.id, parentId: manager.id });
      expect(tasks.get(core.db, leaf.task.id)?.parentTaskId).toBe(managerTask.task.id);
      await tool(managerTurn, "team_wait", { assignment_ids: [worker.id] });
      await finish(managerTurn, executionId);
      const workerTurn = active(executionId, worker.id);
      expect(workerTurn.spec.resumeSessionId).toBeUndefined();
      if (filename === "nested-review.txt") expect(await readFile(path.join(workerTurn.spec.cwd, "nested-original.txt"), "utf8")).toBe("Accepted nested output\n");
      await writeFile(path.join(workerTurn.spec.cwd, filename), "Accepted nested output\n");
      await tool(workerTurn, "team_complete", { result: `Finished ${filename}` });
      await finish(workerTurn, executionId);
      const resumedManager = active(executionId, manager.id);
      expect(await readFile(path.join(resumedManager.spec.cwd, filename), "utf8")).toBe("Accepted nested output\n");
      await tool(resumedManager, "team_complete", { result: "Verified the nested result." });
      await finish(resumedManager, executionId);
      const resumedLead = active(executionId);
      expect(await readFile(path.join(resumedLead.spec.cwd, filename), "utf8")).toBe("Accepted nested output\n");
      await tool(resumedLead, "team_complete", { result: "Accepted the manager's result." });
      await finish(resumedLead, executionId);
      expect(core.teams.status(executionId).state).toBe("completed");
      const receipts = teamWorkspaces.publications(core.db, executionId);
      expect(receipts).toHaveLength(2);
      expect(receipts.every((item) => item.state === "applied")).toBe(true);
      expect(receipts.find((item) => item.targetActorId === "lead")?.includedActorIds).toEqual(expect.arrayContaining([manager.id, worker.id]));
      expect(teamTasks.routes(core.db, action.admissionId).map((item) => [item.actorId, item.role])).toEqual([
        ["lead", "manager"],
        [manager.id, "manager"],
        [worker.id, "assignee"],
      ]);
      return { manager, worker };
    }
    const first = await routeNested(await call("orchestration.tasks.start", { taskId: leaf.task.id, requestKey: "nested-start" }), "nested-original.txt");
    const feedback = core.review.addComment({
      taskId: leaf.task.id,
      path: "nested-original.txt",
      startLine: null,
      startSide: null,
      line: 1,
      side: "new",
      lineText: null,
      body: "Add reviewed output and preserve this accepted file.",
    });
    const reviewed = await routeNested(await call("orchestration.review.send", { taskId: leaf.task.id, commentIds: [feedback.id], requestKey: "nested-review" }), "nested-review.txt");
    expect(reviewed.manager.id).not.toBe(first.manager.id);
    expect(reviewed.worker.id).not.toBe(first.worker.id);
    expect(reviewed.manager.taskId).toBe(first.manager.taskId);
    expect(reviewed.worker.taskId).toBe(first.worker.taskId);
    expect(tasks.list(core.db)).toHaveLength(2);
    expect((await call("orchestration.taskState", { taskId: leaf.task.id }))?.admissions.map((item) => item.state)).toEqual(["completed", "completed"]);
  }, 30000);
});

describe("saved task preservation through requested mode changes", () => {
  it.each(["claude"] as const)("holds %s lead execution after a planning reply, then completes the original admission in Act", async (agent) => {
    const { task, thread } = await captured(agent);
    const action = await call("orchestration.tasks.start", { taskId: task.id, requestKey: "retained-mode-task" });
    const executionId = executionOf(action);
    await core.teams.drain();
    const executing = active(executionId);
    const accepted = teamTasks.admission(core.db, action.admissionId)!;
    await call("threads.update", { id: thread.id, patch: { mode: "plan" } });
    await call("orchestration.send", { threadId: thread.id, text: "Explain the remaining plan before continuing", requestKey: "plan-retained-task" });
    await finish(executing, executionId);
    const planner = active(executionId);
    expect(planner.spec.permissionMode).toBe("review");
    await expect(tool(planner, "task_complete", { id: task.id, admission_id: action.admissionId, result: "A plan is sufficient" })).rejects.toThrow(/Plan turn cannot complete/);
    await finish(planner, executionId);
    expect(teamTaskCompletions.get(core.db, action.admissionId)).toBeNull();
    expect(teamTasks.admission(core.db, action.admissionId)).toEqual(accepted);
    expect(teamTasks.admissions(core.db, task.id)).toHaveLength(1);
    expect(tasks.get(core.db, task.id)?.title).toBe(task.title);
    const held = (await call("orchestration.runtime", { threadId: thread.id }))!.executions.find((item) => item.id === executionId)!;
    expect(held.state).toBe("active");
    expect(held.actors[0]).toMatchObject({ state: "waiting", modeHold: "plan" });
    expect(held.activity).toBe("waiting");
    await call("threads.update", { id: thread.id, patch: { mode: "act" } });
    await core.teams.drain();
    await completeLead(task.id, action, "Completed the same retained admission after planning\n");
    expect(core.teams.status(executionId).attempts.map((item) => item.mode)).toEqual(["act", "plan", "act"]);
    expect(teamTasks.admissions(core.db, task.id)).toHaveLength(1);
    expect(teamTaskCompletions.get(core.db, action.admissionId)).not.toBeNull();
  });
});

// Real RPC/MCP ownership, Git snapshots and provider startup across the team/individual boundary.
describe("forwarding a team task to an independent agent", () => {
  it("forwards captured work once, preserves edited requirements, and starts the selected provider locally", async () => {
    const { task } = await captured();
    await call("app.settings.set", { defaultWorkspaceMode: "current" });
    await call("tasks.update", { id: task.id, patch: { spec: "The edited requirement", labels: ["handoff"] } });
    expect(await call("tasks.forwarding", { taskId: task.id })).toMatchObject({ allowed: true, workspaceMode: "current" });
    const previousTurns = turns.size;
    const request = { taskId: task.id, workspaceMode: "current" as const };
    const [next, replay] = await Promise.all([call("tasks.forward", request), call("tasks.forward", request)]);
    expect(replay.id).toBe(next.id);
    expect(next).toMatchObject({ threadId: null, parentTaskId: null, spec: "The edited requirement", labels: ["handoff"], workspaceMode: "current", status: "backlog", worktreePath: null });
    expect(turns.size).toBe(previousTurns);
    expect(tasks.get(core.db, task.id)?.status).toBe("archived");
    expect((await call("tasks.forward", request)).id).toBe(next.id);
    expect(tasks.list(core.db)).toHaveLength(2);
    await expect(call("orchestration.tasks.start", { taskId: task.id, requestKey: "after-forward" })).rejects.toThrow(/forwarded/);
    await expect(call("tasks.forward", { ...request, workspaceMode: "worktree" })).rejects.toThrow(/saved handoff/);
    const run = await call("runs.start", { taskId: next.id, agent: "claude", model: "fixture-claude", workspaceMode: "current", mode: "act", permissionMode: "trusted", prompt: "Continue the task" });
    const launched = turns.get(run.id)!;
    expect(launched.spec.agent).toBe("claude");
    expect(launched.spec.cwd).toBe(await realpath(project.rootPath));
    expect(launched.spec.resumeSessionId).toBeUndefined();
    expect(launched.spec.prompt).toContain("The edited requirement");
    expect(launched.spec.prompt).toContain(task.id);
    expect(core.teams.binding(run.id)).toBeNull();
  });

  it("rejects active assignments before creating any handoff", async () => {
    const { task } = await captured();
    await call("orchestration.tasks.start", { taskId: task.id, requestKey: "working" });
    await core.teams.drain();
    expect(await call("tasks.forwarding", { taskId: task.id })).toMatchObject({ allowed: false, reason: expect.stringMatching(/Finish or stop/) });
    await expect(call("tasks.forward", { taskId: task.id, workspaceMode: "current" })).rejects.toThrow(/Finish or stop/);
    expect(tasks.list(core.db)).toHaveLength(1);
    expect(taskForwardings.source(core.db, task.id)).toBeNull();
  });

  it("forwards a stopped worker’s partial files without restarting its team assignment", async () => {
    const { task, thread } = await captured("codex", true);
    const action = await call("orchestration.tasks.start", { taskId: task.id, requestKey: "worker" });
    const executionId = executionOf(action);
    await core.teams.drain();
    const lead = active(executionId);
    await tool(lead, "task_start", { id: task.id, admission_id: action.admissionId, member_key: "worker" });
    const worker = core.teams.status(executionId).actors.find((item) => item.taskId === task.id)!;
    await tool(lead, "team_wait", { assignment_ids: [worker.id] });
    await finish(lead, executionId);
    const turn = active(executionId, worker.id);
    await writeFile(path.join(turn.spec.cwd, "partial.txt"), "Keep unfinished worker output\n");
    await call("orchestration.stop", { threadId: thread.id, executionId });
    await core.teams.drain();
    const next = await call("tasks.forward", { taskId: task.id, workspaceMode: "worktree" });
    expect(await readFile(path.join(next.worktreePath!, "partial.txt"), "utf8")).toBe("Keep unfinished worker output\n");
    expect(core.teams.status(executionId).state).toBe("stopped");
    await expect(call("orchestration.tasks.retry", { taskId: task.id, admissionId: action.admissionId, requestKey: "retry-forwarded" })).rejects.toThrow(/forwarded/);
  });

  it("copies completed files and results into a separate worktree without changing the source", async () => {
    const { task } = await captured();
    const { lead } = await completeLead(task.id, await call("orchestration.tasks.start", { taskId: task.id, requestKey: "complete" }));
    const before = (await git(lead.spec.cwd, ["status", "--porcelain"])).stdout;
    const next = await call("tasks.forward", { taskId: task.id, workspaceMode: "worktree" });
    expect(next.worktreePath).toBeTruthy();
    expect(next.worktreePath).not.toBe(lead.spec.cwd);
    expect(await readFile(path.join(next.worktreePath!, "implementation.txt"), "utf8")).toBe("initial result\n");
    expect((await git(lead.spec.cwd, ["status", "--porcelain"])).stdout).toBe(before);
    expect(taskForwardings.target(core.db, next.id)?.context).toContain("Completed the saved task.");
    const run = await call("runs.start", { taskId: next.id, agent: "claude", model: "fixture-claude", mode: "act", permissionMode: "trusted", prompt: "Continue", workspaceMode: "worktree" });
    expect(turns.get(run.id)?.spec.cwd).toBe(await realpath(next.worktreePath!));
    expect(turns.get(run.id)?.spec.prompt).toContain("Completed the saved task.");
  });

  it("transfers committed and dirty team files locally while preserving unrelated staging and the checkout branch", async () => {
    const { task } = await captured();
    const { lead } = await completeLead(task.id, await call("orchestration.tasks.start", { taskId: task.id, requestKey: "complete" }));
    await commitAll(lead.spec.cwd, "Committed team output");
    await writeFile(path.join(lead.spec.cwd, "dirty.txt"), "dirty team output\n");
    await writeFile(path.join(project.rootPath, "local.txt"), "staged local content\n");
    await git(project.rootPath, ["add", "local.txt"]);
    await writeFile(path.join(project.rootPath, "local.txt"), "unstaged local content\n");
    const index = await readFile(path.join(project.rootPath, ".git/index"));
    const next = await call("tasks.forward", { taskId: task.id, workspaceMode: "current" });
    expect(next).toMatchObject({ workspaceMode: "current", worktreePath: null, status: "backlog" });
    expect(await readFile(path.join(project.rootPath, "implementation.txt"), "utf8")).toBe("initial result\n");
    expect(await readFile(path.join(project.rootPath, "dirty.txt"), "utf8")).toBe("dirty team output\n");
    expect(await readFile(path.join(project.rootPath, "local.txt"), "utf8")).toBe("unstaged local content\n");
    expect(await readFile(path.join(project.rootPath, ".git/index"))).toEqual(index);
    expect((await git(project.rootPath, ["branch", "--show-current"])).stdout.trim()).toBe("main");
    await expect(call("runs.start", { taskId: next.id, workspaceMode: "worktree", agent: "codex", mode: "act", permissionMode: "trusted", prompt: "Continue" })).rejects.toThrow(/handoff location/);
  });

  it("retains a conflicted handoff and retries the same task after resolution without allowing premature startup or deletion", async () => {
    const { task, thread } = await captured();
    await completeLead(task.id, await call("orchestration.tasks.start", { taskId: task.id, requestKey: "complete" }));
    await writeFile(path.join(project.rootPath, "implementation.txt"), "local conflict\n");
    const request = { taskId: task.id, workspaceMode: "current" as const };
    await expect(call("tasks.forward", request)).rejects.toThrow(/Resolve/);
    const record = taskForwardings.source(core.db, task.id)!;
    expect(record.state).toBe("preparing");
    expect(tasks.get(core.db, task.id)?.status).toBe("review");
    expect(await readFile(path.join(project.rootPath, "implementation.txt"), "utf8")).toBe("local conflict\n");
    expect(core.teamDeletions.availability(thread.id).allowed).toBe(false);
    await expect(call("tasks.start", { taskId: record.targetTaskId })).rejects.toThrow(/handoff/);
    await expect(core.threads.startTask(tasks.get(core.db, record.targetTaskId)!)).rejects.toThrow(/handoff/);
    await expect(call("tasks.delete", { id: record.targetTaskId })).rejects.toThrow(/handoff/);
    await expect(call("tasks.update", { id: task.id, patch: { status: "archived" } })).rejects.toThrow(/handoff/);
    await expect(core.workspaces.prepare(tasks.get(core.db, record.targetTaskId)!, project)).rejects.toThrow(/handoff/);
    await expect(call("orchestration.tasks.start", { taskId: task.id, requestKey: "conflicted" })).rejects.toThrow(/forwarded/);
    await writeFile(path.join(record.stagingPath!, "implementation.txt"), "local conflict\n");
    // Reconstruct the service to prove recovery comes from its durable receipt.
    const recovered = new TaskForwardingService(
      core.db,
      core.teamTasks,
      core.teamOperations,
      core.workspaceWriters,
      core.taskCheckout,
      path.join(directory, "data"),
      () => "current",
      () => {},
    );
    const next = await recovered.forward(task.id, "current");
    expect(next.id).toBe(record.targetTaskId);
    expect(taskForwardings.source(core.db, task.id)?.state).toBe("ready");
    expect(tasks.get(core.db, task.id)?.status).toBe("archived");
    expect(tasks.list(core.db)).toHaveLength(2);
    expect(await readFile(path.join(project.rootPath, "implementation.txt"), "utf8")).toBe("local conflict\n");
  });
});
