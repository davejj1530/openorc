import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { AcpAdapter, ClaudeAdapter, CodexAdapter, PiAdapter, RunHandle } from "@openorc/agents";
import { claudeAccounts, projects, runs, settings, subagents, taskRefines, tasks, threads } from "@openorc/db";
import { commitAll, git } from "@openorc/git";
import { isHarnessId, type AgentEvent, type CommentRecipient, type RunSpec, type TaskSuggestion } from "@openorc/protocol";
import { OpenOrc } from "../openorc.js";
import { rpcClient } from "../rpc-test-client.js";
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

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "task-refine-test-"));
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "Fixture"]);
  await writeFile(path.join(root, "README.md"), "# Refine\n");
  await commitAll(root, "Initial");
  dataRoot = await mkdtemp(path.join(tmpdir(), "task-refine-data-"));
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
  expect(() => core.refines.suggest(refine.runId!, suggestion)).toThrow("no longer active");
});

it("continues the same session when refining again on the same model", async () => {
  const first = await started();
  const sessionId = crypto.randomUUID();
  const { handle, spec } = sessions.get(first.runId!)!;
  handle.emit("event", { type: "session.started", runId: first.runId!, ts: Date.now(), externalSessionId: sessionId, agent: spec.agent, model: spec.model ?? null });
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
  const sessionId = crypto.randomUUID();
  sessions.get(first.runId)!.handle.emit("event", { type: "session.started", runId: first.runId, ts: Date.now(), externalSessionId: sessionId, agent: "claude", model: "test-model" });
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

it("turns a refine left running when OpenOrc closed into an error", async () => {
  const refine = await started();
  await call("tasks.refine.stop", { taskId });
  taskRefines.update(core.db, refine.id, { state: "running", step: "Reading files" });
  core.refines.recover();
  expect(taskRefines.get(core.db, refine.id)).toMatchObject({ state: "error", step: null, error: "OpenOrc closed before the suggestion was ready." });
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
  expect(refineStep("Grep", { pattern: "x" })).toBe("Searching the project");
  expect(refineStep("Bash", { command: "ls" })).toBe("Running a command");
  expect(refineStep("approve", {})).toBeNull();
});
