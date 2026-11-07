import { Db, retiredTeams, tasks, threads } from "@openorc/db";
import { type RpcResults } from "@openorc/protocol";
import { RunService } from "../services/runs.js";
import type { Handlers } from "./types.js";
type Dependencies = {
  runService: Pick<RunService, "pending">;
  db: Db;
};

export function createInboxHandlers({ runService, db }: Dependencies): Pick<Handlers, "inbox.list"> {
  return {
    "inbox.list": () => {
      const items: RpcResults["inbox.list"]["items"] = [];
      for (const p of runService.pending()) {
        const thread = p.threadId ? threads.get(db, p.threadId) : null;
        const taskId = p.taskId;
        const task = taskId ? tasks.get(db, taskId) : null;
        if (task?.retiredTeam || (thread && retiredTeams.isHidden(db, thread.id))) continue;
        if (task) items.push({ kind: "task", task, runId: p.runId, reason: "approval", detail: p.detail });
        else if (thread) items.push({ kind: "thread", thread, runId: p.runId, reason: "approval", detail: p.detail });
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
