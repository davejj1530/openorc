import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CodexAdapter, RunHandle } from "@openorc/agents";
import { runs, settings, tasks, threads } from "@openorc/db";
import { commitAll, git } from "@openorc/git";
import { WORKSPACE_ID, type ConversationScope, type Project, type RunSpec } from "@openorc/protocol";
import { OpenOrc } from "../openorc.js";
import { rpcClient } from "../rpc-test-client.js";
import { conversationFolder, type FolderKind } from "./conversation-folder.js";

let root: string;
let core: OpenOrc;
let project: Project;
const call = rpcClient(() => core);
const input = { agent: "codex" as const, model: "fixture", effort: undefined, mode: "act" as const, permissionMode: "trusted" as const, attachments: undefined, title: undefined };
const execution = { agent: "codex" as const, model: "fixture", effort: null, permissionMode: "trusted" as const };

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "openorc-folders-")));
  const checkout = path.join(root, "app");
  await mkdir(checkout);
  await git(checkout, ["init", "-q", "-b", "main"]);
  await git(checkout, ["config", "user.email", "fixture@example.com"]);
  await git(checkout, ["config", "user.name", "Fixture"]);
  await writeFile(path.join(checkout, "README.md"), "# Folder fixture\n");
  await commitAll(checkout, "Fixture baseline");
  vi.spyOn(CodexAdapter.prototype, "start").mockImplementation((spec: RunSpec) => {
    let finish!: (code: number) => void;
    const done = new Promise<number>((resolve) => {
      finish = resolve;
    });
    return new RunHandle(spec.runId, { send: async () => {}, interrupt() {}, close: () => finish(0), done });
  });
  core = await OpenOrc.create({ dataDir: path.join(root, "data"), ephemeral: true, transport: { push: () => {} } });
  settings.set(core.db, "extraction.provider", "off");
  vi.spyOn(core.textGeneration, "title").mockResolvedValue(null);
  vi.spyOn(core.runs, "models").mockResolvedValue([{ id: "fixture", label: "Fixture", agent: "codex", isDefault: true, efforts: ["high"], defaultEffort: "high", fastMode: { supported: false } }]);
  project = await core.projects.import(checkout);
});
afterEach(async () => {
  await core.close();
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

async function threadRun(start: Promise<{ thread: { id: string }; run: { id: string } | null }>): Promise<{ scope: ConversationScope; runId: string }> {
  const { thread, run } = await start;
  return { scope: { kind: "thread", id: thread.id }, runId: run!.id };
}

/** A Workspace conversation with no folder of its own, as a Workspace task's conversation without a creator has, continued once. */
async function workspaceThreadWithoutFolder(): Promise<{ scope: ConversationScope; runId: string }> {
  const thread = threads.insert(core.db, { projectId: WORKSPACE_ID, title: "Notes", agent: "codex", model: "fixture", mode: "act", permissionMode: "trusted" });
  const run = await core.threads.continueThread(thread.id, { ...input, prompt: "Tidy the notes" });
  return { scope: { kind: "thread", id: thread.id }, runId: run.id };
}

async function standaloneTask(workspaceMode: "current" | "worktree"): Promise<{ scope: ConversationScope; runId: string }> {
  const task = tasks.insert(core.db, { projectId: project.id, title: `A ${workspaceMode} task`, spec: null, priority: "none", labels: [], workspaceMode, baseRef: null, parentTaskId: null });
  await core.threads.startTask(task, execution, workspaceMode);
  return { scope: { kind: "task", id: task.id }, runId: runs.listForTask(core.db, task.id)[0]!.id };
}

const fixtures: { name: string; kind: FolderKind; readOnly: string | null; start: () => Promise<{ scope: ConversationScope; runId: string }> }[] = [
  {
    name: "a thread in the project checkout",
    kind: "checkout",
    readOnly: null,
    start: () => threadRun(core.threads.start({ ...input, projectId: project.id, prompt: "Work here", workspaceMode: "current" })),
  },
  {
    name: "a thread in its own worktree",
    kind: "worktree",
    readOnly: null,
    start: () => threadRun(core.threads.start({ ...input, projectId: project.id, prompt: "Work apart", workspaceMode: "worktree" })),
  },
  {
    name: "a thread in a pull request's copy",
    kind: "review",
    readOnly: "Pull request copies are read-only.",
    start: async () => {
      const started = await threadRun(core.threads.start({ ...input, projectId: project.id, prompt: "Review it", workspaceMode: "worktree" }));
      threads.update(core.db, started.scope.id, { branch: null });
      return started;
    },
  },
  {
    name: "a Workspace conversation in the folder it chose",
    kind: "workspace",
    readOnly: null,
    start: async () => {
      const chosen = path.join(root, "chosen");
      await mkdir(chosen);
      return threadRun(core.threads.start({ ...input, projectId: WORKSPACE_ID, workingDirectory: chosen, prompt: "Work in my folder" }));
    },
  },
  {
    name: "a Workspace conversation without a folder of its own, under the entrypoint",
    kind: "workspace",
    readOnly: null,
    start: async () => {
      const entrypoint = path.join(root, "entrypoint");
      await mkdir(entrypoint);
      await call("workspace.configure", { entrypoint });
      return workspaceThreadWithoutFolder();
    },
  },
  { name: "a Workspace conversation without a folder of its own or an entrypoint", kind: "workspace", readOnly: null, start: workspaceThreadWithoutFolder },
  { name: "a task in the project checkout", kind: "checkout", readOnly: null, start: () => standaloneTask("current") },
  { name: "a task in its own worktree", kind: "worktree", readOnly: null, start: () => standaloneTask("worktree") },
  {
    name: "a task started in a conversation, which runs in that conversation's worktree",
    kind: "worktree",
    readOnly: null,
    start: async () => {
      const task = await call("tasks.create", { projectId: project.id, title: "Run me in a conversation", workspaceMode: "worktree" });
      const run = await call("tasks.start", { taskId: task.id });
      expect(tasks.get(core.db, task.id)?.worktreePath).toBeNull();
      return { scope: { kind: "task", id: task.id }, runId: run.id };
    },
  },
];

it.each(fixtures)("resolves $name to the folder its run works in", async ({ start, kind, readOnly }) => {
  const { scope, runId } = await start();
  const folder = await conversationFolder(core.db, scope);
  expect(folder.root).toBe(runs.get(core.db, runId)?.workingDirectory);
  expect({ kind: folder.kind, readOnly: folder.readOnly }).toEqual({ kind, readOnly });
});

it("resolves a task in current mode to the checkout even with a worktree left from before", async () => {
  const stale = path.join(root, "stale-worktree");
  await mkdir(stale);
  const task = tasks.insert(core.db, { projectId: project.id, title: "Back in the checkout", spec: null, priority: "none", labels: [], workspaceMode: "current", baseRef: null, parentTaskId: null });
  tasks.update(core.db, task.id, { worktreePath: stale });
  expect(await conversationFolder(core.db, { kind: "task", id: task.id })).toMatchObject({ root: await realpath(project.rootPath), kind: "checkout" });
});

it("reports a conversation whose folder is gone instead of resolving somewhere else", async () => {
  const gone = path.join(root, "gone");
  await mkdir(gone);
  const { scope } = await threadRun(core.threads.start({ ...input, projectId: WORKSPACE_ID, workingDirectory: gone, prompt: "Work in my folder" }));
  await rm(gone, { recursive: true });
  await expect(conversationFolder(core.db, scope)).rejects.toThrow(`${gone} is missing. It may have been moved or deleted.`);
});
