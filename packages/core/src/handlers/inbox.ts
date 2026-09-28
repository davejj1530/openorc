import { Db, tasks, teamDeletedThreads, teamTasks, threads } from "@openorc/db";
import { type RpcResults } from "@openorc/protocol";
import { RunService } from "../services/runs.js";
import { TeamCoordinator } from "../services/team-coordinator.js";
import type { Handlers } from "./types.js";
type Dependencies = {
  runService: Pick<RunService, "pending">;
  db: Db;
  teams: Pick<TeamCoordinator, "binding">;
};

export function createInboxHandlers({ runService, db, teams }: Dependencies): Pick<Handlers, "inbox.list"> {
  return {
    "inbox.list": () => {
      const items: RpcResults["inbox.list"]["items"] = [];
      for (const p of runService.pending()) {
        const thread = p.threadId ? threads.get(db, p.threadId) : null;
        // A deleted owner's lead request belongs to the saved task that admitted its execution.
        const retained = thread && teamDeletedThreads.has(db, thread.id) ? teamTasks.admittingTask(db, teams.binding(p.runId)?.executionId ?? "") : null;
        const taskId = p.taskId || retained;
        const task = taskId ? tasks.get(db, taskId) : null;
        if (task) items.push({ kind: "task", task, runId: p.runId, reason: "approval", detail: p.detail });
        else if (thread && !teamDeletedThreads.has(db, thread.id)) items.push({ kind: "thread", thread, runId: p.runId, reason: "approval", detail: p.detail });
      }
      for (const task of tasks.list(db, { statuses: ["proposed"] })) {
        items.push({ kind: "task", task, runId: null, reason: "proposed", detail: "Proposed by the agent, waiting for your go-ahead" });
      }
      for (const task of tasks.list(db, { statuses: ["review"] })) {
        items.push({ kind: "task", task, runId: null, reason: "review", detail: "Finished run waiting for your review" });
      }
      return { items };
    },
  };
}
