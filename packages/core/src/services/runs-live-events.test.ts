import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { CodexAdapter, RunHandle } from "@openorc/agents";
import { listEvents, threads } from "@openorc/db";
import { git, commitAll } from "@openorc/git";
import { WORKSPACE_ID, type AgentEvent, type CorePush, type Project } from "@openorc/protocol";
import { OpenOrc } from "../openorc.js";
import { executionProject } from "./workspace-home.js";

let root: string;
let dataDir: string;
let core: OpenOrc;
let project: Project;
const pushed: CorePush[] = [];
const live: string[] = [];

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "openorc-diff-refresh-repo-"));
  dataDir = await mkdtemp(path.join(os.tmpdir(), "openorc-diff-refresh-data-"));
  await git(root, ["init", "-q", "-b", "main"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "Test"]);
  await writeFile(path.join(root, "README.md"), "# Diff refresh fixture\n");
  await commitAll(root, "init");
  core = await OpenOrc.create({ dataDir, ephemeral: true, transport: { push: (message) => pushed.push(message) } });
  project = await core.projects.import(root);
});
afterEach(async () => {
  await Promise.all(live.splice(0).map((id) => core.runs.closeAndWait(id)));
  vi.restoreAllMocks();
  vi.useRealTimers();
  pushed.length = 0;
});
afterAll(async () => {
  await core.close();
  await rm(root, { recursive: true, force: true });
  await rm(dataDir, { recursive: true, force: true });
});

const conversation = { agent: "codex" as const, model: "fixture", mode: "act" as const, permissionMode: "trusted" as const };

/** A live run of `thread`, launched in its folder as a turn would be, whose provider events the test emits itself. */
async function session(thread = threads.insert(core.db, { projectId: project.id, title: "Diff refresh", ...conversation })) {
  let handle!: RunHandle;
  vi.spyOn(CodexAdapter.prototype, "start").mockImplementation((spec) => {
    let finish!: (code: number) => void;
    const done = new Promise<number>((resolve) => (finish = resolve));
    handle = new RunHandle(spec.runId, {
      interrupt: () => {},
      send: async () => {},
      close() {
        handle.emit("exit", 0);
        finish(0);
      },
      done,
    });
    return handle;
  });
  const run = await core.runs.start({ scope: { thread, task: null }, project: executionProject(core.db, thread), ...conversation, prompt: "Work", resume: false });
  live.push(run.id);
  const tool = (name: string): AgentEvent => ({ type: "tool.completed", runId: run.id, ts: Date.now(), toolCallId: `${name}-${Math.random()}`, name, output: "", isError: false });
  return { emit: (ev: AgentEvent) => handle.emit("event", ev), tool, runId: run.id, thread };
}

const diffRefreshes = (threadId: string) => pushed.filter((p) => p.type === "invalidate" && p.keys.includes(`threaddiff:${threadId}`)).length;
const settle = () => new Promise((resolve) => setImmediate(resolve));

it("refreshes working-tree diffs when a tool that can change files finishes, but not after a read", async () => {
  const { emit, tool, thread } = await session();
  pushed.length = 0;
  emit(tool("Read"));
  emit(tool("openorc.task_list"));
  await settle();
  expect(diffRefreshes(thread.id)).toBe(0);
  emit(tool("Bash"));
  await settle();
  expect(diffRefreshes(thread.id)).toBe(1);
});

it("refreshes every view of the checkout a run works in, and only those", async () => {
  const sibling = threads.insert(core.db, { projectId: project.id, title: "Same checkout", ...conversation });
  const elsewhere = threads.insert(core.db, { projectId: project.id, title: "Own worktree", ...conversation });
  threads.update(core.db, elsewhere.id, { worktreePath: path.join(root, "..", "elsewhere") });
  const { emit, tool, thread } = await session();
  pushed.length = 0;
  emit(tool("Bash"));
  await settle();
  const keys = pushed.flatMap((p) => (p.type === "invalidate" && p.keys.includes(`threaddiff:${thread.id}`) ? p.keys : []));
  expect(keys).toEqual(expect.arrayContaining([`threaddiff:${thread.id}`, `threaddiff:${sibling.id}`, `projectdiff:${project.id}`]));
  expect(keys).not.toContain("workspace-diff");
  expect(keys).not.toContain(`threaddiff:${elsewhere.id}`);
});

it("refreshes every Workspace conversation in the folder a Workspace run writes to, and none in another folder", async () => {
  const [notes, other] = await Promise.all([mkdtemp(path.join(os.tmpdir(), "openorc-diff-refresh-notes-")), mkdtemp(path.join(os.tmpdir(), "openorc-diff-refresh-other-"))]);
  try {
    const inFolder = (title: string, folder: string) => threads.update(core.db, threads.insert(core.db, { projectId: WORKSPACE_ID, title, ...conversation }).id, { workingDirectory: folder });
    const writer = inFolder("Notes", notes);
    const sibling = inFolder("Same notes", notes);
    const elsewhere = inFolder("Other notes", other);
    const { emit, tool } = await session(writer);
    pushed.length = 0;
    emit(tool("Write"));
    await settle();
    const keys = pushed.flatMap((p) => (p.type === "invalidate" ? p.keys : []));
    expect(keys).toEqual(expect.arrayContaining([`threaddiff:${writer.id}`, `threaddiff:${sibling.id}`]));
    expect(keys).not.toContain(`threaddiff:${elsewhere.id}`);
  } finally {
    await Promise.all([notes, other].map((folder) => rm(folder, { recursive: true, force: true })));
  }
});

it("keeps refreshing diffs while a run works, even with no tool events, and stops once it is idle", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const { emit, runId, thread } = await session();
  pushed.length = 0;
  await vi.advanceTimersByTimeAsync(8_000);
  expect(diffRefreshes(thread.id)).toBe(1);
  emit({ type: "turn.completed", runId, ts: Date.now(), turnId: "turn-1", status: "success", durationMs: 1 });
  await vi.waitFor(() => expect(pushed.some((p) => p.type === "invalidate" && p.keys.includes(`checkpoints:${thread.id}`))).toBe(true));
  const settled = diffRefreshes(thread.id);
  await vi.advanceTimersByTimeAsync(24_000);
  expect(diffRefreshes(thread.id)).toBe(settled);
});

it("streams normalized events to the renderer and writes native payloads to the provider log, not the ledger", async () => {
  const { emit, runId } = await session();
  pushed.length = 0;
  emit({ type: "raw", runId, ts: Date.now(), agent: "codex", payload: { method: "item/completed", params: { item: { type: "agentMessage" } } } });
  emit({ type: "raw", runId, ts: Date.now(), agent: "codex", payload: { method: "item/agentMessage/delta", params: { delta: "Hi" } } });
  emit({ type: "message.delta", runId, ts: Date.now(), messageId: "m1", role: "assistant", text: "Hi" });
  await new Promise((resolve) => setTimeout(resolve, 40));
  const streamed = pushed.flatMap((p) => (p.type === "frame" ? p.frame.events : [])).map((ev) => ev.type);
  expect(streamed).toContain("message.delta");
  expect(streamed).not.toContain("raw");
  core.ledger.flush();
  expect(listEvents(core.db, runId, { includeRaw: true }).map((ev) => ev.type)).not.toContain("raw");
  const logged = async () => {
    const folder = path.join(dataDir, "logs", "provider");
    return (await Promise.all((await readdir(folder)).map((name) => readFile(path.join(folder, name), "utf8")))).join("");
  };
  await vi.waitFor(async () => expect(await logged()).toContain(`"runId":"${runId}"`));
  expect(await logged()).toContain("item/completed");
  expect(await logged()).not.toContain("agentMessage/delta");
});

it("sends pending frames before a transcript page, so a loading window can drop fragments the page already replaced", async () => {
  const { emit, runId } = await session();
  await settle();
  pushed.length = 0;
  emit({ type: "message.delta", runId, ts: 1, messageId: "m", role: "assistant", text: "Hel" });
  emit({ type: "message.delta", runId, ts: 2, messageId: "m", role: "assistant", text: "lo" });
  emit({ type: "message.completed", runId, ts: 3, messageId: "m", role: "assistant", text: "Hello" });
  const page = await core.handle({ type: "rpc", id: 7, method: "events.page", params: { runId, turns: 1 } });
  expect(page.type).toBe("rpc.result");
  // The window gets the page on the same port as the pushes, after every push made before it resolved.
  expect(pushed.some((p) => p.type === "frame" && p.frame.events.some((ev) => ev.type === "message.completed"))).toBe(true);
});
