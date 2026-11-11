import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { CodexAdapter, RunHandle } from "@openorc/agents";
import { threads } from "@openorc/db";
import { git, commitAll } from "@openorc/git";
import type { Project } from "@openorc/protocol";
import { OpenOrc } from "../openorc.js";

let root: string;
let dataDir: string;
let core: OpenOrc;
let project: Project;
const live: string[] = [];

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "openorc-stop-repo-"));
  dataDir = await mkdtemp(path.join(os.tmpdir(), "openorc-stop-data-"));
  await git(root, ["init", "-q", "-b", "main"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "Test"]);
  await writeFile(path.join(root, "README.md"), "# Stop fixture\n");
  await commitAll(root, "init");
  core = await OpenOrc.create({ dataDir, ephemeral: true, transport: { push: () => {} } });
  project = await core.projects.import(root);
});
afterEach(async () => {
  await Promise.all(live.splice(0).map((id) => core.runs.closeAndWait(id)));
  vi.restoreAllMocks();
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

it("returns cancellation errors to the renderer and allows a later successful retry", async () => {
  const interrupt = vi.fn().mockRejectedValueOnce(new Error("Cancellation rejected")).mockResolvedValue(undefined);
  const run = await session(interrupt);
  expect(await core.handle({ type: "rpc", id: 901, method: "runs.interrupt", params: { runId: run.id } })).toEqual({ type: "rpc.error", id: 901, message: "Cancellation rejected" });
  expect(await core.handle({ type: "rpc", id: 902, method: "runs.interrupt", params: { runId: run.id } })).toEqual({ type: "rpc.result", id: 902, result: null });
  expect(interrupt).toHaveBeenCalledTimes(2);
});

it("an agent's update leaves its working conversation running, and its next turn starts on the new version", async () => {
  const run = await session(async () => {});
  const release = core.runs.reserveAgentUpdate("codex");
  await core.runs.send(run.id, "During the update");
  expect(core.runs.isBusy(run.id)).toBe(true);
  release();
  const start = vi.mocked(CodexAdapter.prototype.start);
  const handle = start.mock.results.at(-1)!.value as RunHandle;
  handle.emit("event", { type: "turn.completed", runId: run.id, ts: Date.now(), turnId: "update-fixture", status: "success", durationMs: 1 });
  await vi.waitFor(() => expect(core.runs.isBusy(run.id)).toBe(false));
  expect(start).toHaveBeenCalledOnce();

  await core.runs.send(run.id, "After the update");
  expect(start).toHaveBeenCalledTimes(2);
  expect(core.runs.isLive(run.id)).toBe(false);
  const replacement = core.runs.liveRunForThread(run.threadId!)!;
  live.push(replacement.id);
  expect(replacement.id).not.toBe(run.id);
});

it("answers a request to stop agent updates when none is running", async () => {
  expect(await core.handle({ type: "rpc", id: 903, method: "agents.updates.cancel", params: {} })).toMatchObject({ type: "rpc.result", id: 903, result: { updating: false } });
});
