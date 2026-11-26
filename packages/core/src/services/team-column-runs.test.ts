import { Db, projects, threads } from "@openorc/db";
import type { WaitingTaskRun } from "@openorc/hosted";
import type { SpaceProject } from "@openorc/protocol";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TeamColumnRuns } from "./team-column-runs.js";

let folder: string;
let db: Db;
let localId: string;
let waiting: WaitingTaskRun[];
let paired: SpaceProject[];
let listener: ((spaceId: string) => void) | null;
const claim = vi.fn(async (_spaceId: string, _id: string) => true);
const noFolder = vi.fn(async (_spaceId: string, _id: string) => {});
const start = vi.fn();
const queue = vi.fn();

const account = {
  taskRuns: {
    onWaiting: (next: (spaceId: string) => void) => {
      listener = next;
      return () => (listener = null);
    },
    organizations: () => ["org-1"],
    waiting: async () => waiting,
    claim,
    noFolder,
  },
  spaces: { projects: async () => paired },
};

const item = (runId: string, column = "Review", taskId = "task-1"): WaitingTaskRun =>
  ({
    run: { id: runId, columnId: `col-${column}`, state: "waiting", runner: { userId: "me", name: "Dana Lee" }, requestedAt: 1 },
    task: { id: taskId, projectId: "cloud-project", title: "Fix the header", spec: "The header wraps on phones." },
    column: {
      id: `col-${column}`,
      name: column,
      job: { prompt: "Review the change.", choice: { agent: "codex", model: "gpt-6-astra", effort: "high", claudeAccountId: "someone-else" } },
      nextColumnName: "Done",
    },
    fromColumnName: "Build",
  }) as unknown as WaitingTaskRun;

beforeEach(() => {
  folder = mkdtempSync(path.join(os.tmpdir(), "openorc-team-runs-"));
  db = Db.open(path.join(folder, "data.sqlite"));
  localId = projects.insert(db, { name: "studio", rootPath: folder, defaultBranch: "main", gitRemote: null, settings: {} }).id;
  paired = [{ localProjectId: localId, hostedProjectId: "cloud-project" } as SpaceProject];
  waiting = [];
  listener = null;
  start.mockImplementation(async (input: { title: string }) => ({
    thread: threads.insert(db, { projectId: localId, title: input.title, agent: "codex", model: null, mode: "act", permissionMode: "trusted" }),
    run: null,
  }));
});
afterEach(() => {
  db.close();
  rmSync(folder, { recursive: true, force: true });
  vi.clearAllMocks();
});

const runner = () => new TeamColumnRuns({ db, account: () => account as never, threads: { start, queue } as never, log: { info: () => {}, warn: () => {}, error: () => {} } as never });

it("claims a run waiting for this person and starts its column's agent in the project's folder here, told the task and where it goes next", async () => {
  waiting = [item("run-1")];
  await runner().check("org-1");
  expect(claim).toHaveBeenCalledWith("org-1", "run-1");
  const input = start.mock.calls[0]![0] as { projectId: string; agent: string; model: string; claudeAccountId?: string; title: string; prompt: string };
  expect(input).toMatchObject({ projectId: localId, agent: "codex", model: "gpt-6-astra", title: "Review · Fix the header", mode: "act" });
  // The account the column names is its writer's; here it runs on this person's own.
  expect(input.claudeAccountId).toBeUndefined();
  expect(input.prompt).toContain("Review the change.");
  expect(input.prompt).toContain('team task "Fix the header" (id task-1)');
  expect(input.prompt).toContain('which it came to from "Build"');
  expect(input.prompt).toContain("The header wraps on phones.");
  expect(input.prompt).toContain('move it to the "Done" column with task_update');
});

it("continues the thread that worked the task in that column when the card comes back", async () => {
  waiting = [item("run-1")];
  const team = runner();
  await team.check("org-1");
  waiting = [item("run-2")];
  await team.check("org-1");
  expect(start).toHaveBeenCalledTimes(1);
  expect(queue).toHaveBeenCalledWith(expect.any(String), expect.stringMatching(/^This task is back in the "Review" column\./));
});

it("says this computer has no folder for the project, and claims nothing", async () => {
  paired = [];
  waiting = [item("run-1")];
  await runner().check("org-1");
  expect(noFolder).toHaveBeenCalledWith("org-1", "run-1");
  expect(claim).not.toHaveBeenCalled();
  expect(start).not.toHaveBeenCalled();
});

it("starts nothing for a run another of the person's computers took first", async () => {
  claim.mockResolvedValueOnce(false);
  waiting = [item("run-1")];
  await runner().check("org-1");
  expect(start).not.toHaveBeenCalled();
});

it("looks in each organization as it starts, and again whenever told runs may be waiting", async () => {
  const team = runner();
  waiting = [item("run-1")];
  team.start();
  await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
  waiting = [item("run-2", "Build", "task-2")];
  listener?.("org-1");
  await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(2));
  team.stop();
  expect(listener).toBeNull();
});
