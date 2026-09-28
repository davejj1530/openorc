import { afterAll, describe, expect, it, vi } from "vitest";
import { Db, LedgerWriter, projects, threads, listEvents, runs as runRepo } from "@openorc/db";
import { RunService } from "./runs.js";
import { ShellEnvironment } from "./shell-environment.js";
import { ThreadService } from "./threads.js";
import { WorkspaceService } from "./workspace.js";
import { FrameCoalescer } from "../frames.js";
import { CodexAdapter, RunHandle } from "@openorc/agents";

// Service-only fixture: no sockets, filesystem repositories, or provider processes.
const db = Db.memory();
const ledger = new LedgerWriter(db);
const log = { info() {}, warn() {}, error() {} };
const fixtureEnvironment = new ShellEnvironment({ env: { ...process.env, OPENORC_CLAUDE_BIN: "/fixture/claude", OPENORC_CODEX_BIN: "/fixture/codex" } });
const runs = new RunService(
  db,
  ledger,
  new FrameCoalescer(() => {}),
  async () => {
    throw new Error("This fixture must not open MCP or start a provider");
  },
  () => {},
  log,
  { brief: () => "", onRunFinished() {}, onThreadTurn() {}, notify() {}, claudeVersion: async () => null, environment: () => fixtureEnvironment.current() },
);
const service = new ThreadService(
  db,
  runs,
  new WorkspaceService(db, { dataDir: "/unused" }, log),
  () => {},
  log,
  async () => null,
);
const core = { db, ledger, runs, threads: service };
const project = projects.insert(db, { name: "Fixture", rootPath: "/unused", gitRemote: null, defaultBranch: "main", settings: {} });
function planThread() {
  return threads.insert(db, { projectId: project.id, title: "Parent", agent: "codex", model: null, mode: "plan", permissionMode: "trusted" });
}
afterAll(async () => {
  await runs.closeAll();
  ledger.close();
  db.close();
});

describe("delegated task reporting", () => {
  it.each(["success"] as const)("reports %s through the real run lifecycle without losing the final message", async (outcome) => {
    const thread = planThread();
    const parent = runRepo.insert(db, { id: `lifecycle-parent-${outcome}`, taskId: null, threadId: thread.id, agent: "codex", model: "fixture", mode: "plan", permissionMode: "trusted" });
    const { task } = await service.spawnTask(thread, { title: "Lifecycle report", spec: "Show the real outcome", execution: "backlog" }, "agent");
    const scoped = new RunService(
      db,
      ledger,
      new FrameCoalescer(() => {}),
      async () => ({ port: 0, urlForRun: () => "http://fixture.invalid", revoke: () => {}, close: async () => {} }),
      () => {},
      log,
      {
        brief: () => "",
        onRunFinished: (run, scope) => {
          if (scope.task) void service.onTaskRunFinished(run, scope.task);
        },
        onThreadTurn() {},
        notify() {},
        claudeVersion: async () => null,
        environment: () => fixtureEnvironment.current(),
      },
    );
    let handle!: RunHandle;
    const adapter = vi.spyOn(CodexAdapter.prototype, "start").mockImplementation((spec) => {
      let finish!: (code: number) => void;
      const done = new Promise<number>((resolve) => {
        finish = resolve;
      });
      handle = new RunHandle(spec.runId, {
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
    try {
      const child = await scoped.start({ scope: { task, thread: null }, project, agent: "codex", model: "fixture", mode: "act", permissionMode: "trusted", prompt: "Fixture", resume: false });
      if (outcome === "success") {
        handle.emit("event", { type: "message.completed", runId: child.id, ts: Date.now(), messageId: "final", role: "assistant", text: "Implemented the layout. All targeted checks pass." });
        handle.emit("event", { type: "turn.completed", runId: child.id, ts: Date.now(), turnId: "first", status: "success", durationMs: 1 });
      } else {
        handle.emit("event", { type: "error", runId: child.id, ts: Date.now(), fatal: true, message: "Provider could not start" });
        handle.close();
      }
      await vi.waitFor(() => {
        ledger.flush();
        expect(listEvents(db, parent.id)).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ type: "message.completed", role: "system", text: expect.stringContaining(outcome === "success" ? "All targeted checks pass." : "Provider could not start") }),
          ]),
        );
      });
    } finally {
      await scoped.closeAll();
      adapter.mockRestore();
    }
  });

  it("exposes actual waiting state and the latest commentary to the parent agent", async () => {
    const thread = planThread();
    const parent = runRepo.insert(core.db, { id: "progress-parent", taskId: null, threadId: thread.id, agent: "codex", model: null, mode: "act", permissionMode: "trusted" });
    const { task } = await core.threads.spawnTask(thread, { title: "Report progress", spec: "Implement the requested changes", execution: "backlog" }, "agent");
    const child = runRepo.insert(core.db, { id: "progress-child", taskId: task.id, threadId: null, agent: "codex", model: null, mode: "act", permissionMode: "trusted" });
    core.ledger.push({
      type: "message.completed",
      runId: child.id,
      ts: Date.now(),
      messageId: "progress",
      role: "assistant",
      text: "I found the settings layout and am checking the provider adapters.",
    });
    const permission = core.runs.requestApproval(child.id, "progress-consent", "openorc.task_context", {});
    try {
      const card = await core.threads.toolGet(parent.id, task.id);
      expect(card).toMatchObject({ activity: { state: "waiting", waitingFor: "openorc.task_context", latestMessage: "I found the settings layout and am checking the provider adapters." } });
    } finally {
      core.runs.resolveApproval(child.id, "progress-consent", "deny");
      await permission;
    }
  });

  it.each(["act"] as const)("retains a completion report in the %s thread even without a responding parent agent", async (mode) => {
    const thread = threads.update(core.db, planThread().id, { mode });
    const parent = runRepo.insert(core.db, { id: `report-parent-${mode}`, taskId: null, threadId: thread.id, agent: "codex", model: null, mode, permissionMode: "trusted" });
    const { task } = await core.threads.spawnTask(thread, { title: "Report result", spec: "Keep the result visible", execution: "backlog" }, "agent");
    const child = runRepo.insert(core.db, { id: `report-child-${mode}`, taskId: task.id, threadId: null, agent: "codex", model: null, mode: "act", permissionMode: "trusted" });
    runRepo.update(core.db, child.id, { state: "error", resultText: "Provider failed before implementation.", error: "Provider unavailable", endedAt: Date.now() });
    const finished = runRepo.get(core.db, child.id)!;
    const resume = vi.spyOn(core.threads, "continueThread").mockRejectedValue(new Error("Parent unavailable"));
    try {
      await core.threads.onTaskRunFinished(finished, task);
      await core.threads.onTaskRunFinished(finished, task);
      core.ledger.flush();
      const reports = listEvents(core.db, parent.id).filter((e) => e.type === "message.completed" && e.role === "system");
      expect(reports).toHaveLength(1);
      expect(reports[0]).toMatchObject({ text: expect.stringContaining("Provider failed before implementation.") });
      expect(resume).toHaveBeenCalledTimes(mode === "act" ? 1 : 0);
    } finally {
      resume.mockRestore();
    }
  });
});
