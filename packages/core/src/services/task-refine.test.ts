import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { AcpAdapter, ClaudeAdapter, CodexAdapter, PiAdapter, RunHandle } from "@openorc/agents";
import { claudeAccounts, projects, runs, settings, subagents, taskComments, taskRefines, tasks, threads } from "@openorc/db";
import { commitAll, git } from "@openorc/git";
import { isHarnessId, type AgentEvent, type CommentRecipient, type RunSpec, type TaskSuggestion } from "@openorc/protocol";
import { OpenOrc } from "../openorc.js";
import { rpcClient } from "../rpc-test-client.js";
import { AttachmentService } from "./attachments.js";
import { inheritedProbe } from "./shell-environment.js";
import { refineStep } from "./task-refine.js";

let root: string, dataRoot: string, dataDir: string, core: OpenOrc, taskId: string, projectId: string;
const sessions = new Map<string, { spec: RunSpec; handle: RunHandle }>();
const recipient: CommentRecipient = { agent: "codex", model: "test-model", effort: "high" };
const call = rpcClient(() => core);
const suggestion: TaskSuggestion = {
  title: "Edit task labels as chips",
  description: "## Goal\nAdd and remove labels one at a time.\n\n## Acceptance criteria\n- [ ] Enter turns the text into a chip.",
  labels: ["tasks", "ui"],
  note: "Based on TaskDocumentFields.tsx.",
};

async function started(instruction = "", again = false, edited?: { title: string; description: string; labels: string[] }) {
  const refine = await call("tasks.refine.start", { taskId, recipient, instruction, again, ...(edited ? { edited } : {}) });
  await vi.waitFor(() => expect(taskRefines.get(core.db, refine.id)?.runId && sessions.has(taskRefines.get(core.db, refine.id)!.runId!)).toBe(true));
  return taskRefines.get(core.db, refine.id)!;
}
async function emit(runId: string, input: Omit<Extract<AgentEvent, { type: "turn.completed" }>, "runId" | "ts"> | Omit<Extract<AgentEvent, { type: "tool.started" }>, "runId" | "ts">) {
  sessions.get(runId)!.handle.emit("event", { ...input, runId, ts: Date.now() });
  await new Promise((r) => setTimeout(r, 20));
}
const finish = (runId: string) => emit(runId, { type: "turn.completed", turnId: "1", durationMs: 1, status: "success", resultText: "Done." });
function announceSession(runId: string): string {
  const sessionId = crypto.randomUUID();
  const { handle, spec } = sessions.get(runId)!;
  handle.emit("event", { type: "session.started", runId, ts: Date.now(), externalSessionId: sessionId, agent: spec.agent, model: spec.model ?? null });
  return sessionId;
}

beforeAll(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "task-refine-test-")));
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "Fixture"]);
  await writeFile(path.join(root, "README.md"), "# Refine\n");
  await commitAll(root, "Initial");
  dataRoot = await realpath(await mkdtemp(path.join(tmpdir(), "task-refine-data-")));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(dataRoot, { recursive: true, force: true });
});
beforeEach(async () => {
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
  vi.spyOn(AcpAdapter.prototype, "start").mockImplementation(spawn);
  vi.spyOn(PiAdapter.prototype, "start").mockImplementation(spawn);
  dataDir = path.join(dataRoot, crypto.randomUUID());
  core = await OpenOrc.create({ dataDir, shellProbe: inheritedProbe(), transport: { push: () => {} } });
  settings.set(core.db, "extraction.provider", "off");
  vi.spyOn(core.runs, "models").mockImplementation(async (agent) =>
    isHarnessId(agent) ? [{ agent, id: "test-model", label: "Test", isDefault: true, efforts: ["high", "low"], defaultEffort: "high" }] : [],
  );
  projectId = (await call("projects.import", { rootPath: root })).id;
  taskId = (await call("tasks.create", { projectId, title: "labels input is clunky", spec: "cant remove one without retyping", workspaceMode: "current" })).id;
});
afterEach(async () => {
  await core.close();
  vi.restoreAllMocks();
});

it("runs read-only with one tool, and leaves the task alone until the suggestion is used", async () => {
  const refine = await started("Add how to verify it");
  const run = runs.get(core.db, refine.runId!)!;
  expect(run).toMatchObject({ taskId: null, threadId: null, commentTurnId: null, refineId: refine.id, mode: "plan", permissionMode: "review" });
  const { spec } = sessions.get(run.id)!;
  expect(spec.internalMcp?.toolNames).toEqual(["approve", "task_suggest"]);
  expect(spec.prompt).toContain("cant remove one without retyping");
  expect(spec.prompt).toContain("Task: labels input is clunky\n");
  expect(spec.prompt).not.toContain(taskId);
  expect(spec.prompt).toContain(`Project folder: ${spec.cwd}. The task is about this project`);
  expect(spec.prompt).toContain("Add how to verify it");

  await emit(run.id, { type: "tool.started", toolCallId: "read", name: "Read", input: { file_path: "/repo/src/TaskDocumentFields.tsx" }, parentToolCallId: null });
  expect(taskRefines.get(core.db, refine.id)?.step).toBe("Reading TaskDocumentFields.tsx");

  core.refines.suggest(run.id, suggestion);
  await finish(run.id);
  expect(await call("tasks.refine.get", { taskId })).toMatchObject({
    state: "ready",
    suggestion,
    step: null,
    base: { title: "labels input is clunky", spec: "cant remove one without retyping", labels: [] },
  });
  expect(tasks.get(core.db, taskId)).toMatchObject({ title: "labels input is clunky", spec: "cant remove one without retyping", labels: [] });
  expect(runs.listForTask(core.db, taskId)).toEqual([]);

  await call("tasks.refine.dismiss", { taskId });
  expect(await call("tasks.refine.get", { taskId })).toBeNull();
});

it("says when the agent found nothing to change, or finished without a suggestion", async () => {
  const first = await started();
  core.refines.suggest(first.runId!, { title: " labels input is clunky ", description: "cant remove one without retyping\n", labels: [], note: "It already says what it needs to." });
  await finish(first.runId!);
  expect(taskRefines.get(core.db, first.id)?.state).toBe("unchanged");

  const second = await started();
  expect(taskRefines.get(core.db, first.id)).toMatchObject({ state: "unchanged" });
  expect((await call("tasks.refine.get", { taskId }))?.id).toBe(second.id);
  await finish(second.runId!);
  expect(taskRefines.get(core.db, second.id)).toMatchObject({ state: "error", error: "The agent finished without suggesting anything." });
});

it("refuses a second refine while one runs, and stops on request", async () => {
  const refine = await started();
  await expect(call("tasks.refine.start", { taskId, recipient, instruction: "", again: false })).rejects.toThrow("already being refined");
  await call("tasks.refine.stop", { taskId });
  expect(taskRefines.get(core.db, refine.id)?.state).toBe("cancelled");
  expect(core.runs.isLive(refine.runId!)).toBe(false);
  expect(() => core.refines.suggest(refine.runId!, suggestion)).toThrow("no longer active");
});

it("keeps a suggestion the agent saved before it was stopped", async () => {
  const refine = await started();
  core.refines.suggest(refine.runId!, suggestion);
  await call("tasks.refine.stop", { taskId });
  expect(await call("tasks.refine.get", { taskId })).toMatchObject({ id: refine.id, state: "ready", suggestion, step: null });
});

it("keeps the earlier suggestion when Refine again is stopped or fails, and puts it away once the new one has its own", async () => {
  const first = await started();
  core.refines.suggest(first.runId!, suggestion);
  await finish(first.runId!);

  await started("Shorter", true);
  await call("tasks.refine.stop", { taskId });
  expect(await call("tasks.refine.get", { taskId })).toMatchObject({ id: first.id, state: "ready", suggestion, error: null });

  const failed = await started("Shorter", true);
  sessions.get(failed.runId!)!.handle.emit("event", { type: "error", runId: failed.runId!, ts: Date.now(), message: "You've hit your usage limit.", fatal: true });
  await emit(failed.runId!, { type: "turn.completed", turnId: "1", durationMs: 1, status: "error" });
  expect(await call("tasks.refine.get", { taskId })).toMatchObject({ id: first.id, state: "ready", suggestion, error: "You've hit your usage limit." });

  const next = await started("Shorter", true);
  expect(sessions.get(next.runId!)!.spec.prompt).toContain(`Your previous suggestion, which the user hasn't used:\nTitle: ${suggestion.title}`);
  core.refines.suggest(next.runId!, { ...suggestion, title: "Labels as chips" });
  await finish(next.runId!);
  expect(await call("tasks.refine.get", { taskId })).toMatchObject({ id: next.id, state: "ready", error: null });
  await call("tasks.refine.dismiss", { taskId });
  expect(await call("tasks.refine.get", { taskId })).toBeNull();
});

it("continues the same session when refining again on the same model", async () => {
  const first = await started();
  const sessionId = announceSession(first.runId!);
  core.refines.suggest(first.runId!, suggestion);
  await finish(first.runId!);

  const again = await started("Shorter, drop the scope section", true, { title: "Show labels as chips", description: "## Goal\nMine.", labels: ["ui"] });
  const next = sessions.get(again.runId!)!.spec;
  expect(next.resumeSessionId).toBe(sessionId);
  expect(next.prompt).toContain("Shorter, drop the scope section");
  expect(next.prompt).toContain("The user edited your previous suggestion. Start from their version and keep their edits");
  expect(next.prompt).toContain("Title: Show labels as chips\nLabels: ui\n\n## Goal\nMine.");
});

it("refines on the Claude account chosen, and continues its session only on that account", async () => {
  const [work, personal, client] = ["Work", "Personal", "Client"].map((name) => claudeAccounts.add(core.db, name).id) as [string, string, string];
  await call("projects.updateSettings", { id: projectId, settings: { claudeAccounts: { only: true, accountIds: [work, personal], defaultId: work, autoSwitch: false } } });
  const claude: CommentRecipient = { agent: "claude", model: "test-model", effort: "high" };
  const refined = async (claudeAccountId: string, again = false) => {
    const refine = await call("tasks.refine.start", { taskId, recipient: claude, claudeAccountId, instruction: "", again });
    await vi.waitFor(() => expect(sessions.has(taskRefines.get(core.db, refine.id)?.runId ?? "")).toBe(true));
    const runId = taskRefines.get(core.db, refine.id)!.runId!;
    return { runId, spec: sessions.get(runId)!.spec, account: runs.get(core.db, runId)?.claudeAccountId };
  };
  await expect(call("tasks.refine.start", { taskId, recipient: claude, claudeAccountId: client, instruction: "", again: false })).rejects.toThrow("This project only uses these Claude accounts");

  const first = await refined(personal);
  expect(first.account).toBe(personal);
  const sessionId = announceSession(first.runId);
  core.refines.suggest(first.runId, suggestion);
  await finish(first.runId);

  const same = await refined(personal, true);
  expect(same).toMatchObject({ account: personal, spec: { resumeSessionId: sessionId } });
  core.refines.suggest(same.runId, suggestion);
  await finish(same.runId);

  const other = await refined(work, true);
  expect(other.account).toBe(work);
  expect(other.spec.resumeSessionId ?? null).toBeNull();
  expect(other.spec.prompt).toContain("Your previous suggestion, which the user hasn't used");
});

it("turns Claude's Plan-mode ExitPlanMode back to task_suggest, so the plan doesn't swallow the suggestion", async () => {
  const refine = await started();
  const plans: unknown[] = [];
  sessions.get(refine.runId!)!.handle.on("event", (event: AgentEvent) => void (event.type === "plan.updated" && plans.push(event)));
  const answer = await core.runs.requestApproval(refine.runId!, "exit-plan", "ExitPlanMode", { plan: "# Task refinement\n\n## Goal\nChips." });
  expect(answer).toMatchObject({ decision: "deny", message: expect.stringContaining("Call task_suggest now") });
  expect(plans).toEqual([]);
  expect(sessions.get(refine.runId!)!.spec.systemPromptAppendix).toContain("don't write a plan file or call ExitPlanMode");
});

it("answers a Refine's question at once, sending the agent back to task_suggest", async () => {
  const refine = await started();
  const answer = await core.runs.requestApproval(refine.runId!, "ask", "AskUserQuestion", { questions: [{ question: "Chips or tags?" }] });
  expect(answer).toMatchObject({ decision: "deny", message: expect.stringContaining("call task_suggest now") });
  expect(core.runs.pending()).toEqual([]);
});

it("reads a Worktree task's thread's worktree, and the project folder once that worktree was removed", async () => {
  taskId = (await call("tasks.create", { projectId, title: "Chips in a worktree", spec: "Work in a worktree.", workspaceMode: "worktree" })).id;
  const project = projects.get(core.db, projectId)!;
  const opened = await call("tasks.openThread", { taskId });
  const thread = await core.workspaces.prepareThread(threads.get(core.db, opened.id)!, project);
  expect(thread.worktreePath).toBeTruthy();
  const first = await started();
  expect(sessions.get(first.runId!)!.spec.cwd).toBe(thread.worktreePath);

  await call("tasks.refine.stop", { taskId });
  // Cleanup can leave a thread pointing at a folder it makes again on its next turn.
  await core.workspaces.cleanupThread(thread, project, { keepPath: true });
  expect(threads.get(core.db, thread.id)?.worktreePath).toBe(thread.worktreePath);
  const second = await started();
  expect(sessions.get(second.runId!)!.spec.cwd).toBe(project.rootPath);
});

it("ends a refine left running when OpenOrc closed as an error, or with the suggestion it saved", async () => {
  const refine = await started();
  await call("tasks.refine.stop", { taskId });
  taskRefines.update(core.db, refine.id, { state: "running", step: "Reading files" });
  core.refines.endRunning();
  expect(taskRefines.get(core.db, refine.id)).toMatchObject({ state: "error", step: null, error: "OpenOrc closed before the suggestion was ready." });

  const same = { title: "labels input is clunky", description: "cant remove one without retyping", labels: [], note: "It already says what it needs to." };
  taskRefines.update(core.db, refine.id, { state: "running", step: "Writing its suggestion", suggestion: same });
  core.refines.endRunning();
  expect(taskRefines.get(core.db, refine.id)).toMatchObject({ state: "unchanged", step: null, error: null, suggestion: same });
});

it("starts one refine when two starts arrive together", async () => {
  const start = () => call("tasks.refine.start", { taskId, recipient, instruction: "", again: false });
  const both = await Promise.allSettled([start(), start()]);
  expect(both.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
  expect(both.find((result) => result.status === "rejected")).toMatchObject({ reason: expect.objectContaining({ message: "This task is already being refined." }) });
  await vi.waitFor(() => expect(sessions.size).toBe(1));
});

it("keeps a Refine's subagents out of the task's thread", async () => {
  const opened = await call("tasks.openThread", { taskId });
  const refine = await started();
  sessions
    .get(refine.runId!)!
    .handle.emit("event", { type: "subagent.started", runId: refine.runId!, ts: Date.now(), subagentId: "explore", toolCallId: "explore", title: "Explore", agentType: "Explore" });
  await new Promise((r) => setTimeout(r, 20));
  expect(subagents.byNative(core.db, opened.id, "explore")).toBeNull();
});

it("names what the agent is doing from its tool call", () => {
  expect(refineStep("Read", { file_path: "C:\\repo\\src\\app.ts" })).toBe("Reading app.ts");
  expect(refineStep("mcp__openorc_1__task_suggest", {})).toBe("Writing its suggestion");
  expect(refineStep(`openorc_${"0a".repeat(16)}.task_suggest`, {})).toBe("Writing its suggestion");
  expect(refineStep(`openorc_${"0a".repeat(16)}_task_suggest`, {})).toBe("Writing its suggestion");
  expect(refineStep("Grep", { pattern: "x" })).toBe("Searching the project");
  expect(refineStep("Bash", { command: "ls" })).toBe("Running a command");
  expect(refineStep("approve", {})).toBeNull();
  expect(refineStep("Agent", { prompt: "Find the label input" })).toBe("Asking a subagent");
  expect(refineStep("TaskCreate", {})).toBe("Working");
});

it("hands its suggestion back through task_suggest on OpenOrc's MCP server, which offers it no thread tools", async () => {
  const refine = await started();
  const mcp = await core.mcpServer();
  async function request(method: string, params: unknown) {
    const result = await fetch(mcp.urlForRun(refine.runId!), {
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
  expect((await request("tools/list", {})).result.tools.map((t: { name: string }) => t.name).sort()).toEqual(["approve", "task_suggest"]);
  const forbidden = await request("tools/call", { name: "task_start", arguments: { id: taskId } });
  expect(forbidden.result?.isError ?? Boolean(forbidden.error)).toBe(true);
  const saved = await request("tools/call", { name: "task_suggest", arguments: suggestion });
  expect(saved.result.isError).not.toBe(true);
  await finish(refine.runId!);
  expect(taskRefines.get(core.db, refine.id)).toMatchObject({ state: "ready", suggestion });
  expect(tasks.get(core.db, taskId)?.status).toBe("backlog");
});

it("stops a task's Refine and removes it when the task is deleted", async () => {
  const refine = await started();
  await call("tasks.delete", { id: taskId });
  expect(core.runs.isLive(refine.runId!)).toBe(false);
  expect(taskRefines.get(core.db, refine.id)).toBeNull();
  expect(runs.get(core.db, refine.runId!)).toBeNull();
});

it("starts a fresh session when refining again on another model or effort", async () => {
  vi.mocked(core.runs.models).mockImplementation(async (agent) =>
    isHarnessId(agent) ? ["test-model", "other-model"].map((id) => ({ agent, id, label: id, isDefault: id === "test-model", efforts: ["high", "low"], defaultEffort: "high" })) : [],
  );
  const refinedOn = async (chosen: CommentRecipient) => {
    const refine = await call("tasks.refine.start", { taskId, recipient: chosen, instruction: "", again: true });
    await vi.waitFor(() => expect(sessions.has(taskRefines.get(core.db, refine.id)?.runId ?? "")).toBe(true));
    const runId = taskRefines.get(core.db, refine.id)!.runId!;
    announceSession(runId);
    core.refines.suggest(runId, suggestion);
    await finish(runId);
    return sessions.get(runId)!.spec;
  };
  await refinedOn(recipient);

  for (const chosen of [
    { ...recipient, model: "other-model" },
    { ...recipient, model: "other-model", effort: "low" },
  ]) {
    const next = await refinedOn(chosen);
    expect(next.resumeSessionId ?? null).toBeNull();
    expect(next.prompt).toContain("Your previous suggestion, which the user hasn't used:\nTitle: Edit task labels as chips");
  }
});

it("starts afresh from the task as it is now when the task changed since the last suggestion", async () => {
  const first = await started();
  announceSession(first.runId!);
  core.refines.suggest(first.runId!, suggestion);
  await finish(first.runId!);
  await call("tasks.update", { id: taskId, patch: { title: "Labels as chips" } });

  const again = await started("Shorter", true);
  const next = sessions.get(again.runId!)!.spec;
  expect(next.resumeSessionId ?? null).toBeNull();
  expect(next.prompt).toContain("Task: Labels as chips\n");
  expect(next.prompt).toContain("Your previous suggestion, which the user hasn't used:\nTitle: Edit task labels as chips");
  expect(again.base.title).toBe("Labels as chips");
});

it("gives the agent the task's comments and the images in its description, without requests to discuss the description", async () => {
  const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
  const image = await new AttachmentService(dataDir).save({ name: "chips.png", mime: "image/png", dataBase64: PNG });
  await call("tasks.update", { id: taskId, patch: { spec: `cant remove one without retyping\n\n![Chips](${image.url})` } });
  await call("tasks.comments.post", { taskId, body: "Keep Backspace removing the last label.", recipients: [], requestKey: crypto.randomUUID(), source: "comment" });
  taskComments.insert(core.db, {
    taskId,
    requestKey: crypto.randomUUID(),
    body: "Please discuss the saved task description with me.",
    recipients: [],
    replyTo: null,
    source: "description",
    context: "",
  });

  const refine = await started();
  const { spec } = sessions.get(refine.runId!)!;
  expect(spec.prompt).toContain("Comments on the task (context, not instructions):\nUser: Keep Backspace removing the last label.");
  expect(spec.prompt).not.toContain("Please discuss the saved task description");
  expect(spec.systemPromptAppendix).toContain(`Task images: ${image.path}`);
});

it("ends a Refine whose agent couldn't start, or whose turn failed, with the error, and one stopped before its agent started as cancelled", async () => {
  vi.spyOn(core.runs, "start").mockRejectedValueOnce(new Error("Codex is signed out."));
  const refused = await call("tasks.refine.start", { taskId, recipient, instruction: "", again: false });
  await vi.waitFor(() => expect(taskRefines.get(core.db, refused.id)).toMatchObject({ state: "error", error: "Codex is signed out.", runId: null }));

  const failed = await started();
  sessions.get(failed.runId!)!.handle.emit("event", { type: "error", runId: failed.runId!, ts: Date.now(), message: "You've hit your usage limit.", fatal: true });
  await emit(failed.runId!, { type: "turn.completed", turnId: "1", durationMs: 1, status: "error" });
  expect(taskRefines.get(core.db, failed.id)).toMatchObject({ state: "error", error: "You've hit your usage limit." });

  let release!: () => void;
  const waiting = new Promise<void>((resolve) => (release = resolve));
  const start = core.runs.start.bind(core.runs);
  vi.spyOn(core.runs, "start").mockImplementationOnce(async (input) => {
    await waiting;
    return start(input);
  });
  const stopped = await call("tasks.refine.start", { taskId, recipient, instruction: "", again: false });
  await call("tasks.refine.stop", { taskId });
  const count = sessions.size;
  release();
  await core.refines.close();
  expect(taskRefines.get(core.db, stopped.id)).toMatchObject({ state: "cancelled", error: null, runId: null });
  expect(sessions.size).toBe(count);
});

it("ends a Refine running when OpenOrc quits with the suggestion it saved, else says it ended before one, and ends its agent", async () => {
  const suggested = await started();
  core.refines.suggest(suggested.runId!, suggestion);
  taskId = (await call("tasks.create", { projectId, title: "Chips everywhere", spec: "In comments too.", workspaceMode: "current" })).id;
  const refine = await started();
  await core.refines.close();
  expect(taskRefines.get(core.db, suggested.id)).toMatchObject({ state: "ready", step: null, error: null, suggestion });
  expect(taskRefines.get(core.db, refine.id)).toMatchObject({ state: "error", step: null, error: "OpenOrc closed before the suggestion was ready." });
  expect(core.runs.isLive(suggested.runId!)).toBe(false);
  expect(core.runs.isLive(refine.runId!)).toBe(false);
});

it("takes a suggestion with a long title and many long labels", async () => {
  const refine = await started();
  const long = { ...suggestion, title: "T".repeat(300), labels: Array.from({ length: 40 }, (_, index) => `label ${index} `.padEnd(100, "x")) };
  core.refines.suggest(refine.runId!, long);
  await finish(refine.runId!);
  expect(taskRefines.get(core.db, refine.id)).toMatchObject({ state: "ready", suggestion: long });
});
