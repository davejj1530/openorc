import { Db, projects, TASK_OWN_THREAD, teamTaskThreads, threads } from "@openorc/db";
import type { SpaceProject } from "@openorc/protocol";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TeamTaskHere } from "./team-task-here.js";
import { ensureWorkspaceHome } from "./workspace-home.js";

let folder: string;
let db: Db;
let localId: string;
let paired: SpaceProject[];
const onComputer = vi.fn(async () => ({}));
const offComputer = vi.fn(async () => {});
const task = { id: "task-1", projectId: "cloud-project", title: "Fix the header", spec: "It wraps on phones." };
const account = { tasks: { get: async () => ({ task }), onComputer, offComputer }, spaces: { projects: async () => paired } };

beforeEach(async () => {
  folder = mkdtempSync(path.join(os.tmpdir(), "openorc-team-here-"));
  db = Db.open(path.join(folder, "data.sqlite"));
  await ensureWorkspaceHome(db, folder);
  localId = projects.insert(db, { name: "studio", rootPath: folder, defaultBranch: "main", gitRemote: null, settings: {} }).id;
  paired = [{ localProjectId: localId, hostedProjectId: "cloud-project" } as SpaceProject];
});
afterEach(() => {
  db.close();
  rmSync(folder, { recursive: true, force: true });
  vi.clearAllMocks();
});

const here = () => new TeamTaskHere({ db, account: () => account as never, invalidate: () => {}, log: { info: () => {}, warn: () => {}, error: () => {} } as never });

it("opens a team task's thread in its project's folder here, ready to send, once the server names this computer", async () => {
  const { threadId } = await here().open("org-1", "task-1");
  const thread = threads.get(db, threadId)!;
  expect(thread).toMatchObject({ projectId: localId, title: "Fix the header", mode: "act" });
  expect(thread.draft).toContain('Work on the team task "Fix the header" (id task-1)');
  expect(thread.draft).toContain("It wraps on phones.");
  expect(onComputer).toHaveBeenCalledWith("org-1", "task-1");
  expect(teamTaskThreads.get(db, "org-1", "task-1", TASK_OWN_THREAD)).toBe(threadId);
  // Opened again, it is the same thread.
  expect((await here().open("org-1", "task-1")).threadId).toBe(threadId);
  expect(threads.list(db).filter((each) => each.projectId === localId)).toHaveLength(1);
});

it("opens nothing, and tells the server nothing, without the project's folder here", async () => {
  paired = [];
  await expect(here().open("org-1", "task-1")).rejects.toThrow("Add this project on this computer to open its thread here.");
  expect(onComputer).not.toHaveBeenCalled();
});

it("opens nothing when the server refuses, as for work that runs on a teammate's computer", async () => {
  onComputer.mockRejectedValueOnce(new Error("Its work runs on Dana's computer."));
  await expect(here().open("org-1", "task-1")).rejects.toThrow("Its work runs on Dana's computer.");
  expect(threads.list(db).filter((each) => each.projectId === localId)).toHaveLength(0);
});

it("tells the server once the task's own thread is deleted, and nothing for any other thread", async () => {
  const { threadId } = await here().open("org-1", "task-1");
  const release = here().releasing(threadId);
  expect(here().releasing("another-thread")).toBeNull();
  release?.();
  await vi.waitFor(() => expect(offComputer).toHaveBeenCalledWith("org-1", "task-1"));
});
