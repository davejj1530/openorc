import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CodexAdapter, RunHandle } from "@openorc/agents";
import { checkpoints, listEvents, projects, settings } from "@openorc/db";
import { commitAll, git } from "@openorc/git";
import { FolderPath, WORKSPACE_ID, type CorePush, type Project, type RpcParams, type RunSpec } from "@openorc/protocol";
import { OpenOrc } from "./openorc.js";
import { rpcClient } from "./rpc-test-client.js";
import { outsideChangesNote } from "./services/turn-start-checkpoint.js";

interface FakeRun {
  spec: RunSpec;
  handle: RunHandle;
  /** Each text the provider received, with how many checkpoints its thread had at that moment. */
  received: { text: string; rows: number }[];
  /** The process dies mid-turn. */
  crash: () => void;
}

let core: OpenOrc;
let folder: string;
let root: string;
let project: Project;
let runs: Map<string, FakeRun>;
let pushed: CorePush[];
const call = rpcClient(() => core);
const execFileAsync = promisify(execFile);
const conversation = { agent: "codex" as const, model: "fixture-codex", mode: "act" as const, permissionMode: "trusted" as const };

function rowsOf(runId: string): number {
  const run = core.db.stmt("SELECT thread_id FROM runs WHERE id = ?").get(runId) as { thread_id: string | null } | undefined;
  return run?.thread_id ? checkpoints.listForThread(core.db, run.thread_id).length : 0;
}

beforeEach(async () => {
  folder = await realpath(await mkdtemp(path.join(os.tmpdir(), "openorc-turn-start-")));
  runs = new Map();
  vi.spyOn(CodexAdapter.prototype, "start").mockImplementation((spec) => {
    let finish!: (code: number) => void;
    const done = new Promise<number>((resolve) => {
      finish = resolve;
    });
    const received: FakeRun["received"] = [];
    let closed = false;
    const end = (code: number) => {
      if (closed) return;
      closed = true;
      handle.emit("exit", code);
      finish(code);
    };
    const handle = new RunHandle(spec.runId, {
      done,
      send: async (text) => {
        received.push({ text, rows: rowsOf(spec.runId) });
      },
      interrupt() {},
      close: () => end(0),
    });
    runs.set(spec.runId, { spec, handle, received, crash: () => end(1) });
    return handle;
  });
  pushed = [];
  core = await OpenOrc.create({ dataDir: path.join(folder, "data"), ephemeral: true, transport: { push: (message) => pushed.push(message) } });
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

async function startThread(prompt: string, extra: Partial<RpcParams<"threads.start">> = {}) {
  const started = await call("threads.start", { projectId: project.id, ...conversation, workspaceMode: "current", prompt, ...extra });
  const runId = started.run!.id;
  await vi.waitFor(() => expect(runs.has(runId)).toBe(true));
  return { threadId: started.thread.id, runId };
}

async function endTurn(threadId: string, runId: string) {
  const { handle } = runs.get(runId)!;
  const ts = Date.now();
  handle.emit("event", { type: "message.completed", runId, role: "assistant", messageId: `reply-${runId}-${ts}`, text: "Done", ts });
  handle.emit("event", { type: "turn.completed", runId, turnId: `turn-${runId}-${ts}`, status: "success", durationMs: 1, ts });
  await vi.waitFor(() => expect(core.runs.threadActivity(threadId)).toBe("idle"));
}

/** Saves through the editor's RPC, as the Files tab does. */
async function save(threadId: string, file: string, text: string) {
  const scope = { kind: "thread" as const, id: threadId };
  const current = await call("files.read", { scope, path: file });
  const expected = current.kind === "file" ? { kind: "version" as const, version: current.version } : { kind: "absent" as const };
  expect(await call("files.write", { scope, path: FolderPath.parse(file), text, expected })).toMatchObject({ kind: "saved" });
}

/** The composer's two paths: a message to the live process, or a new process for an idle thread. */
const send = (runId: string, text: string) => call("runs.send", { runId, text });
const continueThread = async (threadId: string, prompt: string) => {
  const run = await call("runs.start", { threadId, ...conversation, prompt });
  await vi.waitFor(() => expect(runs.has(run.id)).toBe(true));
  return run.id;
};

function recordedPrompts(runId: string): string[] {
  core.ledger.flush();
  return listEvents(core.db, runId, { kinds: ["message.completed"] }).flatMap((event) => (event.type === "message.completed" && event.role === "user" ? [event.text] : []));
}

/** Journal times have millisecond resolution; a save in the same millisecond as the next turn start is told twice, which is fine, but not what these tests pin. */
const nextMillisecond = () => new Promise((resolve) => setTimeout(resolve, 2));
const rows = (threadId: string) => checkpoints.listForThread(core.db, threadId).map(({ runId, note, outside }) => ({ runId, note, outside }));
const starting = { runId: null, note: "Starting files", outside: null };
const userNote = (files: string) => `Since your last turn, the user changed these files: ${files}. Read them again before editing them.`;
const unknownNote = (files: string) => `Since your last turn, these files changed outside your turns, by the user or another agent: ${files}. Read them again before editing them.`;

it("splits an edit saved between turns into its own row before the live process hears the next message, and keeps the note out of the transcript", async () => {
  const { threadId, runId } = await startThread("First");
  await endTurn(threadId, runId);
  await save(threadId, "README.md", "# Mine\n");
  await send(runId, "Second");
  expect(runs.get(runId)!.received).toEqual([{ text: `Second\n\n${userNote("README.md")}`, rows: 2 }]);
  expect(rows(threadId)).toEqual([starting, { runId: null, note: "Your changes", outside: "user" }]);
  expect(recordedPrompts(runId)).toEqual(["First", "Second"]);
});

it("carries the note through a new process when the previous one had closed, recording the message alone", async () => {
  const { threadId, runId } = await startThread("First");
  await endTurn(threadId, runId);
  await core.runs.closeAndWait(runId);
  await save(threadId, "README.md", "# Mine\n");
  const next = await continueThread(threadId, "Second");
  expect(next).not.toBe(runId);
  expect(runs.get(next)!.spec.prompt).toBe(`Second\n\n${userNote("README.md")}`);
  expect(recordedPrompts(next)).toEqual(["Second"]);
  expect(rows(threadId)).toEqual([starting, { runId: null, note: "Your changes", outside: "user" }]);
});

it("leaves the user's edit out of the next turn's card, and keeps it through that turn's Undo", async () => {
  const { threadId, runId } = await startThread("First");
  await endTurn(threadId, runId);
  await save(threadId, "README.md", "# Mine\n");
  await send(runId, "Second");
  await writeFile(path.join(root, "agent.ts"), "export {};\n");
  await endTurn(threadId, runId);
  const [start, outside, turn] = checkpoints.listForThread(core.db, threadId);
  expect(turn).toMatchObject({ runId, outside: null });
  expect((await call("threads.turnChanges", { id: threadId, checkpointId: turn!.id })).files.map((file) => file.path)).toEqual(["agent.ts"]);
  expect(await call("threads.restore", { id: threadId, checkpointId: outside!.id })).toBeNull();
  expect(await readFile(path.join(root, "README.md"), "utf8")).toBe("# Mine\n");
  await expect(readFile(path.join(root, "agent.ts"))).rejects.toThrow();
  expect(await call("threads.restore", { id: threadId, checkpointId: start!.id })).toBeNull();
  expect(await readFile(path.join(root, "README.md"), "utf8")).toBe("# Fixture\n");
});

it("still delivers the message, without a note or a row, when the folder can't be saved between turns", async () => {
  const { threadId, runId } = await startThread("First");
  await endTurn(threadId, runId);
  await save(threadId, "README.md", "# Mine\n");
  const objects = path.join(root, ".git", "objects");
  await execFileAsync("chmod", ["-R", "a-w", objects]);
  try {
    await send(runId, "Second");
  } finally {
    await execFileAsync("chmod", ["-R", "u+w", objects]);
  }
  expect(runs.get(runId)!.received).toEqual([{ text: "Second", rows: 1 }]);
  expect(rows(threadId)).toEqual([starting]);
});

it("splits nothing off a thread that moved to another folder since its last row", async () => {
  const { threadId, runId } = await startThread("First");
  await endTurn(threadId, runId);
  await core.runs.closeAndWait(runId);
  const worktree = path.join(folder, "moved");
  await git(root, ["worktree", "add", "-q", "-b", "moved", worktree]);
  await writeFile(path.join(worktree, "README.md"), "# Elsewhere\n");
  core.db.stmt("UPDATE threads SET worktree_path = ?, workspace_mode = 'worktree' WHERE id = ?").run(worktree, threadId);
  const next = await continueThread(threadId, "Second");
  expect(runs.get(next)!.spec.prompt).toBe("Second");
  expect(rows(threadId)).toEqual([starting]);
});

it("refreshes the thread's checkpoint list when the turn starts, so the line shows before the agent replies", async () => {
  const { threadId, runId } = await startThread("First");
  await endTurn(threadId, runId);
  await save(threadId, "README.md", "# Mine\n");
  pushed.length = 0;
  await send(runId, "Second");
  expect(pushed.some((message) => message.type === "invalidate" && message.keys.includes(`checkpoints:${threadId}`))).toBe(true);
});

it("credits a change the editor never saved to unknown, even with no agent around", async () => {
  const { threadId, runId } = await startThread("First");
  await endTurn(threadId, runId);
  await writeFile(path.join(root, "README.md"), "# From a terminal\n");
  await send(runId, "Second");
  expect(runs.get(runId)!.received.map((message) => message.text)).toEqual([`Second\n\n${unknownNote("README.md")}`]);
  expect(rows(threadId)).toEqual([starting, { runId: null, note: "Changes between turns", outside: "unknown" }]);
});

it("marks the row unknown when another conversation finished a turn in the folder since this one's last checkpoint", async () => {
  const a = await startThread("A first");
  await endTurn(a.threadId, a.runId);
  const b = await startThread("B first");
  await writeFile(path.join(root, "b.ts"), "export {};\n");
  await endTurn(b.threadId, b.runId);
  await send(a.runId, "A second");
  expect(runs.get(a.runId)!.received.map((message) => message.text)).toEqual([`A second\n\n${unknownNote("b.ts")}`]);
  expect(rows(a.threadId).at(-1)).toEqual({ runId: null, note: "Changes between turns", outside: "unknown" });
});

it("marks the row unknown while another conversation that started earlier is still working in the folder", async () => {
  const b = await startThread("B first");
  const a = await startThread("A first");
  await endTurn(a.threadId, a.runId);
  await writeFile(path.join(root, "b.ts"), "export {};\n");
  await send(a.runId, "A second");
  expect(runs.get(a.runId)!.received.map((message) => message.text)).toEqual([`A second\n\n${unknownNote("b.ts")}`]);
  expect(rows(a.threadId).at(-1)).toEqual({ runId: null, note: "Changes between turns", outside: "unknown" });
  expect(core.runs.threadActivity(b.threadId)).toBe("running");
});

it("marks the row unknown when this conversation's own last run died mid-turn", async () => {
  const { threadId, runId } = await startThread("First");
  await writeFile(path.join(root, "partial.ts"), "export {};\n");
  runs.get(runId)!.crash();
  await vi.waitFor(() => expect(core.runs.liveRunForThread(threadId)).toBeNull());
  const next = await continueThread(threadId, "Second");
  expect(runs.get(next)!.spec.prompt).toBe(`Second\n\n${unknownNote("partial.ts")}`);
  expect(rows(threadId)).toEqual([starting, { runId: null, note: "Changes between turns", outside: "unknown" }]);
});

it("inserts no row and adds no note while the agent has background work", async () => {
  const { threadId, runId } = await startThread("First");
  await endTurn(threadId, runId);
  runs.get(runId)!.handle.emit("event", { type: "background.updated", runId, ts: Date.now(), running: 1 });
  await vi.waitFor(() => expect(core.runs.threadActivity(threadId)).toBe("running"));
  await save(threadId, "README.md", "# Mine\n");
  await send(runId, "Second");
  expect(runs.get(runId)!.received).toEqual([{ text: "Second", rows: 1 }]);
  expect(rows(threadId)).toEqual([starting]);
});

it("tells a Workspace conversation's agent which files the editor saved, with no checkpoint rows and nothing about other edits", async () => {
  const chosen = path.join(folder, "notes");
  await mkdir(chosen);
  const { threadId, runId } = await startThread("First", { projectId: WORKSPACE_ID, workingDirectory: chosen });
  await endTurn(threadId, runId);
  await save(threadId, "notes.md", "# Notes\n");
  await nextMillisecond();
  await writeFile(path.join(chosen, "elsewhere.md"), "# From a terminal\n");
  await send(runId, "Second");
  await endTurn(threadId, runId);
  await send(runId, "Third");
  expect(runs.get(runId)!.received).toEqual([
    { text: `Second\n\n${userNote("notes.md")}`, rows: 0 },
    { text: "Third", rows: 0 },
  ]);
  expect(checkpoints.listForThread(core.db, threadId)).toEqual([]);
  expect(recordedPrompts(runId)).toEqual(["First", "Second", "Third"]);
});

it("tells a project without git the same, with no checkpoint rows", async () => {
  const plain = path.join(folder, "plain");
  await mkdir(plain);
  const { id: projectId } = projects.insert(core.db, { name: "Plain", rootPath: plain, defaultBranch: null, gitRemote: null, settings: {} });
  const { threadId, runId } = await startThread("First", { projectId });
  await endTurn(threadId, runId);
  await save(threadId, "todo.md", "- ship it\n");
  await nextMillisecond();
  await send(runId, "Second");
  expect(runs.get(runId)!.received).toEqual([{ text: `Second\n\n${userNote("todo.md")}`, rows: 0 }]);
  expect(checkpoints.listForThread(core.db, threadId)).toEqual([]);
});

it("inserts one row for two turn starts with nothing changed between them, and no note the second time", async () => {
  const { threadId, runId } = await startThread("First");
  await endTurn(threadId, runId);
  await save(threadId, "README.md", "# Mine\n");
  await send(runId, "Second");
  await endTurn(threadId, runId);
  await send(runId, "Third");
  expect(runs.get(runId)!.received.map((message) => message.text)).toEqual([`Second\n\n${userNote("README.md")}`, "Third"]);
  expect(rows(threadId)).toEqual([starting, { runId: null, note: "Your changes", outside: "user" }]);
});

it("names at most thirty files in the note and counts the rest", () => {
  const paths = Array.from({ length: 32 }, (_, index) => `src/file-${String(index).padStart(2, "0")}.ts`);
  const note = outsideChangesNote({ checkpointId: null, by: "user", paths });
  expect(note).toBe(`Since your last turn, the user changed these files: ${paths.slice(0, 30).join(", ")} and 2 more. Read them again before editing them.`);
  expect(outsideChangesNote({ checkpointId: null, by: "unknown", paths: ["a.ts"] })).toBe(unknownNote("a.ts"));
});
