import { Db, projects, threads } from "@openorc/db";
import type { WaitingTaskAnswer } from "@openorc/hosted";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TeamTaskAnswers } from "./team-task-answers.js";

let folder: string;
let db: Db;
let threadId: string;
let waiting: WaitingTaskAnswer[];
const delivered = vi.fn(async (_spaceId: string, _reportId: string) => {});
const queue = vi.fn();
const account = { taskAnswers: { onWaiting: () => () => {}, organizations: () => ["org-1"], waiting: async () => waiting, delivered } };

beforeEach(() => {
  folder = mkdtempSync(path.join(os.tmpdir(), "openorc-team-answers-"));
  db = Db.open(path.join(folder, "data.sqlite"));
  const projectId = projects.insert(db, { name: "studio", rootPath: folder, defaultBranch: "main", gitRemote: null, settings: {} }).id;
  threadId = threads.insert(db, { projectId, title: "Review", agent: "claude", model: null, mode: "act", permissionMode: "trusted" }).id;
});
afterEach(() => {
  db.close();
  rmSync(folder, { recursive: true, force: true });
  vi.clearAllMocks();
});

const answers = () => new TeamTaskAnswers({ db, account: () => account as never, threads: { queue }, log: { info: () => {}, warn: () => {}, error: () => {} } as never });
const answer = (reportId: string, thread: string, reply: string): WaitingTaskAnswer => ({ reportId, taskId: "task-1", threadId: thread, reply, by: { userId: "dana", name: "Dana Lee" } });

it("passes a teammate's answer to the agent's thread here as the reply chosen, once, and says it was delivered", async () => {
  waiting = [answer("report-1", threadId, "Approve the plan"), answer("report-2", "a-deleted-thread", "Try again")];
  await answers().check("org-1");
  expect(queue.mock.calls).toEqual([[threadId, "Approve the plan"]]);
  expect(delivered.mock.calls).toEqual([
    ["org-1", "report-1"],
    ["org-1", "report-2"],
  ]);
});
