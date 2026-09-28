import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { CodexAdapter, RunHandle } from "@openorc/agents";
import { threads } from "@openorc/db";
import { git, commitAll } from "@openorc/git";
import type { CorePush, Project } from "@openorc/protocol";
import { OpenOrc } from "../openorc.js";

let root: string;
let dataDir: string;
let core: OpenOrc;
let project: Project;
const pushed: CorePush[] = [];
const live: string[] = [];

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "openorc-stop-repo-"));
  dataDir = await mkdtemp(path.join(os.tmpdir(), "openorc-stop-data-"));
  await git(root, ["init", "-q", "-b", "main"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "Test"]);
  await writeFile(path.join(root, "README.md"), "# Stop fixture\n");
  await commitAll(root, "init");
  core = await OpenOrc.create({ dataDir, ephemeral: true, transport: { push: (message) => pushed.push(message) } });
  project = await core.projects.import(root);
});
afterEach(async () => {
  await Promise.all(live.splice(0).map((id) => core.runs.closeAndWait(id)));
  vi.restoreAllMocks();
  pushed.length = 0;
});
afterAll(async () => {
  await core.close();
  await rm(root, { recursive: true, force: true });
  await rm(dataDir, { recursive: true, force: true });
});

async function session(interrupt: () => Promise<void>) {
  const thread = threads.insert(core.db, { projectId: project.id, title: "Stop test", agent: "codex", model: "fixture", mode: "act", permissionMode: "trusted" });
  vi.spyOn(CodexAdapter.prototype, "start").mockImplementation((spec) => {
    let finish!: (code: number) => void;
    const done = new Promise<number>((resolve) => {
      finish = resolve;
    });
    const handle = new RunHandle(spec.runId, {
      interrupt,
      send: async () => {},
      close() {
        handle.emit("exit", 0);
        finish(0);
      },
      done,
    });
    return handle;
  });
  const run = await core.runs.start({ scope: { thread, task: null }, project, agent: "codex", model: "fixture", mode: "act", permissionMode: "trusted", prompt: "Work", resume: false });
  live.push(run.id);
  return run;
}

const reply = (id: number) => pushed.find((message) => (message.type === "rpc.result" || message.type === "rpc.error") && message.id === id);

it("returns cancellation errors to the renderer and allows a later successful retry", async () => {
  const interrupt = vi.fn().mockRejectedValueOnce(new Error("Cancellation rejected")).mockResolvedValue(undefined);
  const run = await session(interrupt);
  await core.handle({ type: "rpc", id: 901, method: "runs.interrupt", params: { runId: run.id } });
  expect(reply(901)).toEqual({ type: "rpc.error", id: 901, message: "Cancellation rejected" });
  await core.handle({ type: "rpc", id: 902, method: "runs.interrupt", params: { runId: run.id } });
  expect(reply(902)).toEqual({ type: "rpc.result", id: 902, result: null });
  expect(interrupt).toHaveBeenCalledTimes(2);
});

it("agent updates refuse active turns, then fence admission while idle sessions close", async () => {
  const run = await session(async () => {});
  await expect(core.runs.reserveAgentUpdate()).rejects.toThrow("Finish agent work");
  expect(core.runs.isLive(run.id)).toBe(true);
  const handle = vi.mocked(CodexAdapter.prototype.start).mock.results.at(-1)!.value as RunHandle;
  handle.emit("event", { type: "turn.completed", runId: run.id, ts: Date.now(), turnId: "update-fixture", status: "success", durationMs: 1 });
  await vi.waitFor(() => expect(core.runs.isBusy(run.id)).toBe(false));
  const reserved = core.runs.reserveAgentUpdate();
  await expect(core.runs.send(run.id, "Racing message")).rejects.toThrow("agent update is running");
  await expect(core.runs.modelCatalog("codex")).rejects.toThrow("agent update is running");
  await expect(core.runs.compact(run.id)).rejects.toThrow("agent update is running");
  const release = await reserved;
  expect(core.runs.isLive(run.id)).toBe(false);
  expect(threads.get(core.db, run.threadId!)?.id).toBe(run.threadId);
  release();
  // Releasing the fence allows admission again; this specific old process has retired.
  await expect(core.runs.send(run.id, "Resume later")).rejects.toThrow("not live");
});
