import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CodexAdapter, RunHandle } from "@openorc/agents";
import { checkpoints, projects, settings } from "@openorc/db";
import { commitAll, git, treeHash } from "@openorc/git";
import type { Project, RunSpec } from "@openorc/protocol";
import { OpenOrc } from "./openorc.js";
import { rpcClient } from "./rpc-test-client.js";

let core: OpenOrc;
let folder: string;
let root: string;
let project: Project;
let turns: Map<string, { spec: RunSpec; handle: RunHandle }>;

beforeEach(async () => {
  folder = await mkdtemp(path.join(os.tmpdir(), "openorc-thread-restore-"));
  turns = new Map();
  vi.spyOn(CodexAdapter.prototype, "start").mockImplementation((spec) => {
    let close!: (code: number) => void;
    const done = new Promise<number>((resolve) => {
      close = resolve;
    });
    let closed = false;
    const handle = new RunHandle(spec.runId, {
      done,
      send: async () => undefined,
      interrupt() {},
      close() {
        if (closed) return;
        closed = true;
        handle.emit("exit", 0);
        close(0);
      },
    });
    turns.set(spec.runId, { spec, handle });
    return handle;
  });
  core = await OpenOrc.create({ dataDir: path.join(folder, "data"), ephemeral: true, transport: { push: () => {} } });
  settings.set(core.db, "extraction.provider", "off");
  root = path.join(folder, "repository");
  await mkdir(root);
  await git(root, ["init", "-q", "-b", "main"]);
  await git(root, ["config", "user.email", "fixture@example.com"]);
  await git(root, ["config", "user.name", "Fixture"]);
  await writeFile(path.join(root, "README.md"), "# Fixture\n");
  await commitAll(root, "Fixture baseline");
  project = projects.insert(core.db, { name: "Fixture", rootPath: root, defaultBranch: "main", gitRemote: null, settings: {} });
  vi.spyOn(core.runs, "models").mockResolvedValue([
    { id: "fixture-codex", label: "Scripted provider", agent: "codex", isDefault: true, efforts: ["high"], defaultEffort: "high", fastMode: { supported: false } },
  ]);
  // An ended turn names its thread; a real titler would still be running when the core closes.
  vi.spyOn(core.textGeneration, "title").mockResolvedValue(null);
});
afterEach(async () => {
  if (core) await core.close();
  vi.restoreAllMocks();
  if (folder) await rm(folder, { recursive: true, force: true });
});

const call = rpcClient(() => core);

function endTurn(runId: string) {
  const { handle } = turns.get(runId)!;
  handle.emit("event", { type: "message.completed", runId, role: "assistant", messageId: `reply-${runId}`, text: "Done", ts: Date.now() });
  handle.emit("event", { type: "turn.completed", runId, turnId: `turn-${runId}`, status: "success", durationMs: 1, ts: Date.now() });
}

/** A thread whose agent has started, with a checkpoint of the clean tree and a file written after it. */
async function threadWithChange() {
  const started = await call("threads.start", {
    projectId: project.id,
    agent: "codex",
    model: "fixture-codex",
    mode: "act",
    permissionMode: "trusted",
    workspaceMode: "current",
    prompt: "Write a scratch file",
  });
  const threadId = started.thread.id;
  const runId = started.run!.id;
  await vi.waitFor(() => expect(turns.has(runId)).toBe(true));
  const checkpoint = checkpoints.insert(core.db, { threadId, runId: null, turn: 1, treeSha: await treeHash(root), diffStat: { files: 0, insertions: 0, deletions: 0, untracked: 0 } });
  await writeFile(path.join(root, "scratch.txt"), "temporary\n");
  return { threadId, runId, checkpointId: checkpoint.id };
}

it("undoes a turn while the agent waits between turns, closing its process first", async () => {
  const { threadId, runId, checkpointId } = await threadWithChange();
  await expect(call("threads.restore", { id: threadId, checkpointId })).rejects.toThrow(/end the current turn before restoring/);

  endTurn(runId);
  await vi.waitFor(() => expect(core.runs.threadActivity(threadId)).toBe("idle"));
  expect(core.runs.liveRunForThread(threadId)).not.toBeNull();

  await call("threads.restore", { id: threadId, checkpointId });
  await expect(readFile(path.join(root, "scratch.txt"), "utf8")).rejects.toThrow();
  expect(core.runs.liveRunForThread(threadId)).toBeNull();
});

it("leaves an idle agent running while commands it started are still going", async () => {
  const { threadId, runId, checkpointId } = await threadWithChange();
  endTurn(runId);
  await vi.waitFor(() => expect(core.runs.threadActivity(threadId)).toBe("idle"));
  vi.spyOn(core.runs, "threadBackgroundCommands").mockReturnValue([{ id: "dev-server", command: "pnpm dev", description: "Dev server", startedAt: Date.now() }] as never);

  await expect(call("threads.restore", { id: threadId, checkpointId })).rejects.toThrow(/stop the thread's background commands before restoring/);
  await expect(call("threads.moveWorkspace", { id: threadId, to: "worktree" })).rejects.toThrow(/stop the thread's background commands before moving the thread/);
  expect(await readFile(path.join(root, "scratch.txt"), "utf8")).toBe("temporary\n");
  expect(core.runs.liveRunForThread(threadId)).not.toBeNull();
});
