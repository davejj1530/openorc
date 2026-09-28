import { Db, orchestration, runs, tasks, threads } from "@openorc/db";
import { TeamCoordinator } from "../services/team-coordinator.js";
type Dependencies = {
  teams: Pick<TeamCoordinator, "binding" | "statusForRun">;
  db: Db;
};
export function createContextHost({ teams, db }: Dependencies) {
  const assertTeamActor = (runId: string) => {
    if (teams.binding(runId)) teams.statusForRun(runId);
    else {
      const run = runs.get(db, runId);
      const threadId = run?.threadId ?? (run?.taskId ? tasks.get(db, run.taskId)?.threadId : null);
      if (threadId && orchestration.getInstance(db, threadId)) throw new Error("This old run has no authority in the pinned team.");
    }
  };
  const taskFor = (runId: string) => {
    const run = runs.get(db, runId);
    return run?.taskId ? tasks.get(db, run.taskId) : null;
  };
  const projectFor = (runId: string) => {
    assertTeamActor(runId);
    const run = runs.get(db, runId);
    const task = run?.taskId ? tasks.get(db, run.taskId) : null;
    const thread = run?.threadId ? threads.get(db, run.threadId) : null;
    return task?.projectId ?? thread?.projectId ?? null;
  };
  return { assertTeamActor, taskFor, projectFor };
}
export type RunContext = ReturnType<typeof createContextHost>;
