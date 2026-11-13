import { afterEach, expect, it } from "vitest";
import { ProjectActivityParams, type HarnessId } from "@openorc/protocol";
import { Db } from "./database.js";
import { LedgerWriter } from "./ledger.js";
import { projectActivity } from "./project-activity.js";
import { projects, runs, threads } from "./repos.js";

const databases: Db[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function fixture() {
  const db = Db.memory();
  databases.push(db);
  const writer = new LedgerWriter(db, { artifactThresholdBytes: 500 });
  const project = (name: string) => projects.insert(db, { name, rootPath: `/tmp/${name}`, gitRemote: null, defaultBranch: "main", settings: {} }).id;
  const thread = (projectId: string, agent: HarnessId) => threads.insert(db, { projectId, title: "Work", agent, model: null, mode: "act", permissionMode: "trusted" }).id;
  let count = 0;
  function turns(threadId: string, agent: HarnessId, times: number[], steps: number[] = []) {
    const runId = `run-${++count}`;
    runs.insert(db, { id: runId, taskId: null, threadId, agent, model: null, mode: "act", permissionMode: "trusted" });
    for (const ts of steps) writer.push({ type: "tool.completed", runId, ts, toolCallId: `call-${runId}-${ts}`, name: "Read", isError: false, output: "" });
    for (const ts of times) writer.push({ type: "turn.completed", runId, ts, turnId: `turn-${runId}-${ts}`, status: "success", durationMs: 1 });
    writer.flush();
  }
  return { db, project, thread, turns };
}

it("counts each day's finished turns, threads and agents in the project's own conversations, and every thread's steps", () => {
  const f = fixture();
  const mine = f.project("mine");
  const other = f.project("other");
  const codex = f.thread(mine, "codex");
  const claude = f.thread(mine, "claude");
  const child = f.thread(mine, "claude");
  threads.update(f.db, child, { parentThreadId: claude, parentRelation: "subagent" });
  const started = f.thread(mine, "codex");
  threads.update(f.db, started, { parentThreadId: claude, parentRelation: "started" });
  f.turns(codex, "codex", [5, 12, 13, 29], [11, 12, 26]);
  f.turns(claude, "claude", [14, 30, 2]);
  f.turns(child, "claude", [15, 16], [15, 15]);
  f.turns(started, "codex", [18]);
  f.turns(f.thread(other, "codex"), "codex", [12], [12]);

  const activity = projectActivity(f.db, ProjectActivityParams.parse({ id: mine, boundaries: [10, 20, 25, 30] }));

  expect(activity.days).toEqual([
    {
      turns: 4,
      steps: 4,
      threads: 3,
      agents: [
        { agent: "codex", turns: 3 },
        { agent: "claude", turns: 1 },
      ],
    },
    { turns: 0, steps: 0, threads: 0, agents: [] },
    { turns: 1, steps: 1, threads: 1, agents: [{ agent: "codex", turns: 1 }] },
  ]);
});
