import { Db, retiredTeams, runs, tasks, threads } from "@openorc/db";
export function createContextHost({ db }: { db: Db }) {
  const assertRunAvailable = (runId: string) => {
    const run = runs.get(db, runId);
    const threadId = run?.threadId ?? (run?.taskId ? tasks.get(db, run.taskId)?.threadId : null);
    if ((threadId && retiredTeams.isHidden(db, threadId)) || (run?.taskId && retiredTeams.hasTask(db, run.taskId))) throw new Error("This item is no longer available.");
  };
  const taskFor = (runId: string) => {
    const run = runs.get(db, runId);
    return run?.taskId ? tasks.get(db, run.taskId) : null;
  };
  const projectFor = (runId: string) => {
    assertRunAvailable(runId);
    const run = runs.get(db, runId);
    const task = run?.taskId ? tasks.get(db, run.taskId) : null;
    const thread = run?.threadId ? threads.get(db, run.threadId) : null;
    return task?.projectId ?? thread?.projectId ?? null;
  };
  return { assertRunAvailable, taskFor, projectFor };
}
export type RunContext = ReturnType<typeof createContextHost>;
