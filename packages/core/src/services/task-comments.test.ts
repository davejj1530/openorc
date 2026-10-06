import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { CodexAdapter, ClaudeAdapter, RunHandle } from "@openorc/agents";
import { taskComments, runs, threads, tasks, settings } from "@openorc/db";
import { git, commitAll } from "@openorc/git";
import type { CorePush, RpcMethod, RpcParams, RpcResults, RunSpec, CommentRecipient, AgentEvent } from "@openorc/protocol";
import { OpenOrc } from "../openorc.js";
import { inheritedProbe } from "./shell-environment.js";

let root: string,
  dataDir: string,
  core: OpenOrc,
  taskId: string,
  nextId = 0;
const pushes: CorePush[] = [];
const sessions = new Map<string, { spec: RunSpec; handle: RunHandle }>();
const recipient: CommentRecipient = { agent: "codex", model: "test-model", effort: "high" };
async function call<M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResults[M]> {
  const id = ++nextId;
  await core.handle({ type: "rpc", id, method, params });
  const r = pushes.find((p) => (p.type === "rpc.result" || p.type === "rpc.error") && p.id === id);
  if (!r || r.type === "rpc.error") throw new Error(r?.message ?? "No result");
  return (r as { result: RpcResults[M] }).result;
}
async function post(body: string, recipients = [recipient], key = crypto.randomUUID(), replyTo?: string) {
  return call("tasks.comments.post", { taskId, body, recipients, requestKey: key, source: "comment", replyTo });
}
async function response(commentId: string, index = 0) {
  await vi.waitFor(() => expect(taskComments.list(core.db, taskId).attempts.filter((a) => a.commentId === commentId)[index]?.runId).toBeTruthy());
  return taskComments.list(core.db, taskId).attempts.filter((a) => a.commentId === commentId)[index]!;
}
async function executionStarted(attemptId: string) {
  // onCreated records the run before its starting checkpoint and provider are ready. Git makes that take over a
  // second on CI runners, past waitFor's default.
  await vi.waitFor(
    () => {
      const runId = taskComments.attempt(core.db, attemptId)?.executionRunId;
      expect(runId).toBeTruthy();
      expect(sessions.has(runId!)).toBe(true);
      expect(tasks.get(core.db, taskId)?.status).toBe("in_progress");
    },
    { timeout: 5000 },
  );
  return taskComments.attempt(core.db, attemptId)!;
}
async function event(runId: string, input: Omit<Extract<AgentEvent, { type: "turn.completed" }>, "runId" | "ts"> | Omit<Extract<AgentEvent, { type: "message.completed" }>, "runId" | "ts">) {
  sessions.get(runId)!.handle.emit("event", { ...input, runId, ts: Date.now() });
  await new Promise((r) => setTimeout(r, 20));
}
async function finish(runId: string, text = "Here is my answer.") {
  await event(runId, { type: "message.completed", role: "assistant", messageId: "answer", text });
  await event(runId, { type: "turn.completed", turnId: "1", durationMs: 1, status: "success", resultText: text });
}
function announceSession(runId: string, sessionId = crypto.randomUUID()) {
  const { spec, handle } = sessions.get(runId)!;
  handle.emit("event", { type: "session.started", runId, ts: Date.now(), externalSessionId: sessionId, agent: spec.agent, model: spec.model ?? null });
  return sessionId;
}
async function openCore() {
  core = await OpenOrc.create({ dataDir, shellProbe: inheritedProbe(), transport: { push: (p) => pushes.push(p) } });
  settings.set(core.db, "extraction.provider", "off");
  vi.spyOn(core.runs, "models").mockImplementation(async (agent) =>
    agent === "codex" || agent === "claude" ? [{ agent, id: "test-model", label: "Test", isDefault: true, efforts: ["high", "low"], defaultEffort: "high" }] : [],
  );
}
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "task-comments-test-"));
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "Fixture"]);
  await writeFile(path.join(root, "README.md"), "# Comments\n");
  await commitAll(root, "Initial");
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});
beforeEach(async () => {
  pushes.length = 0;
  sessions.clear();
  const spawn = (spec: RunSpec) => {
    let resolve!: (value: number) => void;
    const done = new Promise<number>((r) => (resolve = r));
    let closed = false;
    const handle = new RunHandle(spec.runId, {
      send: async () => {},
      interrupt() {},
      close() {
        if (!closed) {
          closed = true;
          handle.emit("exit", 0);
          resolve(0);
        }
      },
      done,
    });
    sessions.set(spec.runId, { spec, handle });
    return handle;
  };
  vi.spyOn(CodexAdapter.prototype, "start").mockImplementation(spawn);
  vi.spyOn(ClaudeAdapter.prototype, "start").mockImplementation(spawn);
  dataDir = path.join(root, crypto.randomUUID());
  await openCore();
  const project = await call("projects.import", { rootPath: root });
  taskId = (await call("tasks.create", { projectId: project.id, title: "Comments fixture", spec: "Implement the feature", workspaceMode: "current" })).id;
});
afterEach(async () => {
  await core.close();
  vi.restoreAllMocks();
});

it("keeps notes inert and persists discussion runs separately from task execution", async () => {
  await post("Just a note", []);
  expect(sessions.size).toBe(0);
  const c = await post("How would you implement this?");
  const a = await response(c.id);
  const run = runs.get(core.db, a.runId!)!;
  expect(run).toMatchObject({ taskId: null, threadId: null, commentTurnId: a.id, mode: "plan", permissionMode: "review" });
  expect(sessions.get(run.id)!.spec.internalMcp?.toolNames).toEqual(["ask_user", "approve", "task_comment_intent"]);
  await core.comments.intent(run.id, { intent: "discussion", quote: "" });
  await finish(run.id);
  expect(taskComments.attempt(core.db, a.id)?.state).toBe("success");
  expect(tasks.get(core.db, taskId)).toMatchObject({ status: "backlog", threadId: null, worktreePath: null });
  expect(runs.listForTask(core.db, taskId)).toEqual([]);
  expect(core.db.stmt("SELECT count(*) AS n FROM thread_checkpoints").get()?.n).toBe(0);
  expect(core.db.stmt("SELECT count(*) AS n FROM snapshots").get()?.n).toBe(0);
});

it("deduplicates submissions and recipients, streams replies, and does not dispatch output mentions", async () => {
  const key = crypto.randomUUID();
  const [c, d] = await Promise.all([post("@codex:test-model-high thoughts?", [recipient, recipient], key), post("@codex:test-model-high thoughts?", [recipient], key)]);
  expect(c.id).toBe(d.id);
  const a = await response(c.id);
  expect(taskComments.list(core.db, taskId).attempts).toHaveLength(1);
  await finish(a.runId!, "@claude:test-model-high might also have an opinion.");
  expect(sessions.size).toBe(1);
  expect(taskComments.attempt(core.db, a.id)?.body).toContain("@claude");
});

it("runs independent recipients and serializes subsequent requests to the same recipient", async () => {
  const c = await post("Compare approaches", [recipient, { agent: "claude", model: "test-model", effort: "low" }]);
  const a = await response(c.id, 0),
    b = await response(c.id, 1);
  const sessionId = announceSession(a.runId!);
  const next = await post("Follow up", [recipient], crypto.randomUUID(), a.id);
  expect(taskComments.list(core.db, taskId).attempts.find((a) => a.commentId === next.id)?.state).toBe("queued");
  await finish(a.runId!);
  await finish(b.runId!);
  const follow = await response(next.id);
  expect(sessions.size).toBe(3);
  expect(sessions.get(follow.runId!)!.spec.resumeSessionId).toBe(sessionId);
  await finish(follow.runId!);
});

it.each(["claude"] as const)("resumes %s's existing session when replying to its response", async (agent) => {
  const target = { ...recipient, agent };
  const c = await post("How would you implement this?", [target]);
  const a = await response(c.id);
  const sessionId = announceSession(a.runId!);
  await finish(a.runId!);
  const next = await post("What about the alternative?", [target], crypto.randomUUID(), a.id);
  const b = await response(next.id);
  expect(sessions.get(b.runId!)!.spec).toMatchObject({ resumeSessionId: sessionId, mode: "plan", permissionMode: "review" });
  expect(sessions.get(b.runId!)!.spec.internalMcp?.toolNames).toEqual(["ask_user", "approve", "task_comment_intent"]);
  await finish(b.runId!);
});

it("resumes each recipient's own session when replying to a user comment after restart", async () => {
  const recipients = [recipient, { ...recipient, effort: "low" }];
  const c = await post("Compare approaches", recipients);
  const a = await response(c.id, 0),
    b = await response(c.id, 1);
  const first = announceSession(a.runId!);
  await finish(a.runId!);
  const second = announceSession(b.runId!);
  await finish(b.runId!);
  await core.close();
  await openCore();
  const next = await post("Explain the tradeoffs", recipients, crypto.randomUUID(), c.id);
  const x = await response(next.id, 0),
    y = await response(next.id, 1);
  expect(sessions.get(x.runId!)!.spec.resumeSessionId).toBe(first);
  expect(sessions.get(y.runId!)!.spec.resumeSessionId).toBe(second);
  await finish(x.runId!);
  await finish(y.runId!);
});

it("keeps new comments and changed recipients separate and seeds missing sessions from context", async () => {
  const c = await post("Discuss the cache");
  const a = await response(c.id);
  announceSession(a.runId!);
  await finish(a.runId!, "Cache the parsed result.");
  for (const [target, replyTo] of [
    [recipient, undefined],
    [{ ...recipient, effort: "low" }, a.id],
    [{ ...recipient, agent: "claude" }, a.id],
  ] as const) {
    const next = await post("Another question", [target], crypto.randomUUID(), replyTo);
    const b = await response(next.id);
    expect(sessions.get(b.runId!)!.spec.resumeSessionId).toBeUndefined();
    await finish(b.runId!);
  }
  runs.update(core.db, a.runId!, { externalSessionId: null });
  const next = await post("What would you cache?", [recipient], crypto.randomUUID(), a.id);
  const b = await response(next.id);
  expect(sessions.get(b.runId!)!.spec.resumeSessionId).toBeUndefined();
  expect(sessions.get(b.runId!)!.spec.prompt).toContain("Cache the parsed result.");
  await finish(b.runId!);
});

it("rebuilds context on explicit retry when the provider has forgotten a resumed session", async () => {
  const c = await post("Discuss the cache");
  const a = await response(c.id);
  announceSession(a.runId!);
  await finish(a.runId!);
  const next = await post("What about invalidation?", [recipient], crypto.randomUUID(), a.id);
  const b = await response(next.id);
  await event(b.runId!, { type: "turn.completed", turnId: "1", durationMs: 1, status: "error", resultText: "Session not found" });
  expect(taskComments.attempt(core.db, b.id)?.state).toBe("error");
  const count = sessions.size;
  await call("tasks.comments.retry", { taskId, attemptId: b.id });
  const retried = await response(next.id);
  expect(sessions.size).toBe(count + 1);
  expect(sessions.get(retried.runId!)!.spec.resumeSessionId).toBeUndefined();
  expect(sessions.get(retried.runId!)!.spec.prompt).toContain("What about invalidation?");
  await finish(retried.runId!);
});

it("uses saved context after later task edits and refuses execution from description requests", async () => {
  await call("tasks.update", { id: taskId, patch: { spec: "@codex:test-model-high Implement this now" } });
  expect(sessions.size).toBe(0);
  const c = await call("tasks.comments.post", { taskId, source: "description", body: "", recipients: [], requestKey: "description" });
  await call("tasks.update", { id: taskId, patch: { spec: "Changed later" } });
  const a = await response(c.id);
  expect(sessions.get(a.runId!)?.spec.prompt).toContain("Implement this now");
  await expect(core.comments.intent(a.runId!, { intent: "execution", quote: "Implement this now" })).rejects.toThrow("latest user's");
  await finish(a.runId!);
  expect(tasks.get(core.db, taskId)?.threadId).toBeNull();
});

it("rejects quoted authorization and lets ambiguous comments ask for clarification", async () => {
  const c = await post("What does `implement this` mean?");
  const a = await response(c.id);
  await expect(core.comments.intent(a.runId!, { intent: "execution", quote: "implement this" })).rejects.toThrow("latest user's");
  await core.comments.intent(a.runId!, { intent: "clarification", quote: "" });
  await finish(a.runId!, "Do you want an explanation or implementation?");
  expect(tasks.get(core.db, taskId)?.status).toBe("backlog");
});

it("hands off clear work to one linked thread and posts one durable outcome", async () => {
  const c = await post("Can you implement this?");
  const a = await response(c.id);
  const discussionSession = announceSession(a.runId!);
  await core.comments.intent(a.runId!, { intent: "execution", quote: "Can you implement this?" });
  await finish(a.runId!, "I’ll hand this to the execution thread.");
  const launched = await executionStarted(a.id);
  expect(tasks.get(core.db, taskId)?.status).toBe("in_progress");
  expect(launched.threadId).toBeTruthy();
  expect(sessions.get(launched.executionRunId!)?.spec).toMatchObject({ model: "test-model", effort: "high", mode: "act" });
  announceSession(launched.executionRunId!);
  await finish(launched.executionRunId!, "Implemented and tested.");
  await vi.waitFor(() => expect(taskComments.attempt(core.db, a.id)?.state).toBe("completed"));
  await core.comments.execute(taskId, a.id);
  expect(sessions.size).toBe(2);
  expect(taskComments.attempt(core.db, a.id)?.body.match(/Work completed/g)).toHaveLength(1);
  expect(taskComments.attempt(core.db, a.id)?.body).toContain("Implemented and tested.");
  const follow = await post("Explain the changes", [recipient], crypto.randomUUID(), a.id);
  const next = await response(follow.id);
  expect(sessions.get(next.runId!)!.spec).toMatchObject({ resumeSessionId: discussionSession, mode: "plan" });
  await finish(next.runId!);
});

it.each(["codex", "claude"] as const)("starts sibling tasks independently while their creator is busy (%s)", async (agent) => {
  const firstTask = tasks.get(core.db, taskId)!;
  const owner = threads.insert(core.db, {
    projectId: firstTask.projectId,
    title: "Two tasks",
    agent: "codex",
    model: "test-model",
    effort: "high",
    mode: "act",
    permissionMode: "review",
    workspaceMode: "current",
  });
  tasks.update(core.db, taskId, { threadId: owner.id });
  const firstComment = await post("Implement task A");
  const first = await response(firstComment.id);
  await core.comments.intent(first.runId!, { intent: "execution", quote: "Implement task A" });
  await finish(first.runId!);
  const firstExecution = await executionStarted(first.id);
  expect(firstExecution.threadId).toBe(owner.id);

  taskId = (await call("tasks.create", { projectId: firstTask.projectId, threadId: owner.id, title: "Task B", workspaceMode: "current" })).id;
  const secondComment = await post("Implement task B", [{ ...recipient, agent }]);
  const second = await response(secondComment.id);
  await core.comments.intent(second.runId!, { intent: "execution", quote: "Implement task B" });
  await finish(second.runId!);
  await vi.waitFor(() => expect(["working", "error"]).toContain(taskComments.attempt(core.db, second.id)?.state));
  const secondExecution = await executionStarted(second.id);
  expect(secondExecution.error).toBeNull();
  expect(secondExecution.executionRunId).toBeTruthy();
  expect(secondExecution.threadId).not.toBe(owner.id);
  expect(core.runs.liveRunForThread(owner.id)?.id).toBe(firstExecution.executionRunId);
  expect(sessions.get(secondExecution.executionRunId!)?.spec).toMatchObject({ agent, model: "test-model", effort: "high" });
});

it("requires one executor after a multi-recipient work request", async () => {
  const c = await post("Implement this", [recipient, { agent: "claude", model: "test-model", effort: "low" }]);
  const a = await response(c.id),
    b = await response(c.id, 1);
  await core.comments.intent(a.runId!, { intent: "execution", quote: "Implement this" });
  await finish(a.runId!);
  await finish(b.runId!);
  expect(tasks.get(core.db, taskId)?.threadId).toBeNull();
  expect(taskComments.attempt(core.db, a.id)?.state).toBe("choose_executor");
  await call("tasks.comments.execute", { taskId, attemptId: b.id });
  expect(taskComments.attempt(core.db, b.id)?.executionRunId).toBeTruthy();
  expect(sessions.size).toBe(3);
});

it("respects an existing Plan thread and does not change its settings", async () => {
  const task = tasks.get(core.db, taskId)!;
  const owner = threads.insert(core.db, { projectId: task.projectId, title: "Planning", agent: "codex", model: null, mode: "plan", permissionMode: "review" });
  tasks.update(core.db, taskId, { threadId: owner.id });
  const c = await post("Implement this");
  const a = await response(c.id);
  await core.comments.intent(a.runId!, { intent: "execution", quote: "Implement this" });
  await finish(a.runId!);
  await vi.waitFor(() => expect(taskComments.attempt(core.db, a.id)?.state).toBe("error"));
  expect(taskComments.attempt(core.db, a.id)?.error).toContain("implementation mode");
  expect(threads.get(core.db, owner.id)?.mode).toBe("plan");
  expect(sessions.size).toBe(1);
});

it("supports cancellation and explicit retry without launching cancelled queued replies", async () => {
  const c = await post("Think");
  const a = await response(c.id);
  const queued = await post("Later");
  const b = taskComments.list(core.db, taskId).attempts.find((a) => a.commentId === queued.id)!;
  await call("tasks.comments.cancel", { taskId, attemptId: b.id });
  await call("tasks.comments.cancel", { taskId, attemptId: a.id });
  expect(taskComments.attempt(core.db, a.id)?.state).toBe("cancelled");
  expect(sessions.size).toBe(1);
  await call("tasks.comments.retry", { taskId, attemptId: b.id });
  const next = await response(queued.id);
  await finish(next.runId!);
  expect(sessions.size).toBe(2);
});

it("exposes only comment-scoped MCP tools and blocks mutation calls", async () => {
  const c = await post("How would you implement this?");
  const a = await response(c.id);
  const mcp = await core.mcpServer();
  async function request(method: string, params: unknown) {
    const result = await fetch(mcp.urlForRun(a.runId!), {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const text = await result.text();
    const data =
      text
        .split("\n")
        .find((line) => line.startsWith("data: "))
        ?.slice(6) ?? text;
    return JSON.parse(data);
  }
  expect((await request("tools/list", {})).result.tools.map((t: { name: string }) => t.name).sort()).toEqual(["approve", "ask_user", "task_comment_intent"]);
  const forbidden = await request("tools/call", { name: "task_start", arguments: { id: taskId } });
  expect(forbidden.result?.isError ?? Boolean(forbidden.error)).toBe(true);
  const result = await request("tools/call", { name: "task_comment_intent", arguments: { intent: "discussion", quote: "" } });
  expect(result.result.isError).not.toBe(true);
  await finish(a.runId!);
  expect(tasks.get(core.db, taskId)?.status).toBe("backlog");
});

it("marks interrupted attempts for explicit recovery and retains partial replies", async () => {
  const c = await post("Think");
  const a = await response(c.id);
  await event(a.runId!, { type: "message.completed", messageId: "partial", role: "assistant", text: "Partial reply" });
  await core.comments.cancel(taskId, a.id);
  taskComments.update(core.db, a.id, { state: "running" });
  core.comments.recover();
  expect(taskComments.attempt(core.db, a.id)).toMatchObject({ state: "error", body: "Partial reply" });
  expect(sessions.size).toBe(1);
});

it("keeps interactive questions on the comment and rejects write approval", async () => {
  const c = await post("Which approach?");
  const a = await response(c.id);
  const answer = core.runs.requestUserInput(a.runId!, "choose", {
    questions: [
      {
        id: "approach",
        question: "Which approach?",
        options: [
          { label: "Small", description: "A narrow implementation" },
          { label: "Broad", description: "A larger change" },
        ],
      },
    ],
  });
  expect(core.comments.list(taskId).questions).toHaveLength(1);
  await call("approvals.resolve", { runId: a.runId!, approvalId: "choose", decision: "allow", answers: { approach: ["Small"] } });
  expect(await answer).toMatchObject({ status: "answered", answers: { approach: ["Small"] } });
  expect(core.comments.list(taskId).questions).toHaveLength(0);
  expect(await core.runs.requestApproval(a.runId!, "write", "Bash", { command: "touch file" })).toMatchObject({ decision: "deny" });
  await finish(a.runId!);
});

it("queues another comment as a follow-up while the task is already working", async () => {
  const c = await post("Implement this");
  const a = await response(c.id);
  await core.comments.intent(a.runId!, { intent: "execution", quote: "Implement this" });
  await finish(a.runId!);
  await executionStarted(a.id);
  const next = await post("Implement this too");
  const b = await response(next.id);
  await core.comments.intent(b.runId!, { intent: "execution", quote: "Implement this too" });
  await finish(b.runId!);
  await vi.waitFor(() => expect(taskComments.attempt(core.db, b.id)?.threadId).toBeTruthy());
  const queued = taskComments.attempt(core.db, b.id)!;
  expect(queued.state).toBe("success");
  expect(queued.error).toBeNull();
  expect(queued.threadId).toBe(taskComments.attempt(core.db, a.id)?.threadId);
  expect(core.threads.get(queued.threadId!)?.queued).toHaveLength(1);
  await core.comments.execute(taskId, b.id);
  expect(core.threads.get(queued.threadId!)?.queued).toHaveLength(1);
  expect(sessions.size).toBe(3);
});

it("cancels pending responses before deleting their task", async () => {
  const c = await post("Think about this");
  const a = await response(c.id);
  await call("tasks.delete", { id: taskId });
  expect(taskComments.attempt(core.db, a.id)).toBeNull();
  expect(runs.get(core.db, a.runId!)).toBeNull();
  expect(core.runs.isLive(a.runId!)).toBe(false);
});

it.each([false, true])("accepts one follow-up per comment and settles executor choices (late reply: %s)", async (lateReply) => {
  const ownerRun = await call("tasks.start", { taskId });
  const c = await post("Implement this too", [recipient, { agent: "claude", model: "test-model", effort: "low" }]);
  const a = await response(c.id),
    b = await response(c.id, 1);
  await core.comments.intent(a.runId!, { intent: "execution", quote: "Implement this too" });
  await core.comments.intent(b.runId!, { intent: "execution", quote: "Implement this too" });
  await finish(a.runId!);
  if (!lateReply) await finish(b.runId!);
  await core.comments.execute(taskId, a.id);
  if (lateReply) await finish(b.runId!);
  await core.comments.execute(taskId, b.id);
  expect(taskComments.list(core.db, taskId).attempts.some((attempt) => attempt.state === "choose_executor")).toBe(false);
  expect(core.threads.get(ownerRun.threadId!)?.queued).toHaveLength(1);
  expect(core.db.stmt("SELECT request_key FROM thread_queue WHERE thread_id = ?").all(ownerRun.threadId!)).toEqual([{ request_key: `task-comment:${c.id}` }]);
});

it("retries implementation after a failed first start instead of treating its thread link as acceptance", async () => {
  const start = vi.spyOn(core.threads, "startTaskInThread").mockRejectedValueOnce(new Error("Sign in before starting"));
  const c = await post("Implement this");
  const a = await response(c.id);
  await core.comments.intent(a.runId!, { intent: "execution", quote: "Implement this" });
  await finish(a.runId!);
  await vi.waitFor(() => expect(taskComments.attempt(core.db, a.id)?.state).toBe("error"));
  await call("tasks.comments.retry", { taskId, attemptId: a.id });
  const retried = await response(c.id);
  await core.comments.intent(retried.runId!, { intent: "execution", quote: "Implement this" });
  await finish(retried.runId!);
  await vi.waitFor(() => expect(taskComments.attempt(core.db, a.id)?.executionRunId).toBeTruthy());
  expect(start).toHaveBeenCalledTimes(2);
});

it("lets a mentioned Orcling reply as itself, read-only, with its current model", async () => {
  const gloop = await call("orclings.create", {
    draft: {
      name: "Gloop",
      look: { shape: 0, eyes: 0, texture: 0, glasses: 0, accessory: 0, bodyColor: "#52b8a0", eyeColor: "#1b1c20" },
      settings: { agent: "codex", model: "test-model", effort: "low", fastMode: false },
      permission: "allow",
    },
  });
  const c = await post("@Gloop what would you change?", []);
  const a = await response(c.id);
  expect(a.recipient).toEqual({ agent: "codex", model: "test-model", effort: "low", orclingId: gloop.id });
  const run = runs.get(core.db, a.runId!)!;
  expect(run).toMatchObject({ orclingId: gloop.id, mode: "plan", permissionMode: "review" });
  const spec = sessions.get(run.id)!.spec;
  expect(spec.systemPromptAppendix).toContain("# You are Gloop");
  expect(spec.systemPromptAppendix).not.toContain("orcling_remember");
  expect(spec.internalMcp?.toolNames).toEqual(["ask_user", "approve", "task_comment_intent"]);
  await core.comments.intent(run.id, { intent: "discussion", quote: "" });
  await finish(run.id);
  expect(taskComments.attempt(core.db, a.id)?.state).toBe("success");
});
