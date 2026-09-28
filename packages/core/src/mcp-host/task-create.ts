import { Db, runs, threads } from "@openorc/db";
import type { McpHost } from "@openorc/mcp";
import { TaskPriority } from "@openorc/protocol";
import type { TeamCoordinator } from "../services/team-coordinator.js";
import type { TeamTaskService } from "../services/team-tasks.js";
import type { ThreadService } from "../services/threads.js";
import type { RunContext } from "./context.js";

type Dependencies = {
  teams: Pick<TeamCoordinator, "binding" | "dispatchReplay" | "statusForRun" | "dispatch">;
  teamTasks: Pick<TeamTaskService, "captureReplay" | "capture">;
  threadService: Pick<ThreadService, "toolGet" | "toolCreate">;
  db: Db;
  assertTeamActor: RunContext["assertTeamActor"];
};
type CreateTask = McpHost["tasks"]["create"];
type Input = Parameters<CreateTask>[1];
type Result = Awaited<ReturnType<CreateTask>>;
type ReplayDependencies = Pick<Dependencies, "teams" | "teamTasks" | "threadService">;

/** Replay precedes mode admission: a lost reply cannot turn an accepted assignment into a new proposal. */
function replayTask({ teams, teamTasks, threadService }: ReplayDependencies, runId: string, input: Input): Promise<Result> | null {
  const captured = teamTasks.captureReplay(runId, { ...input, priority: input.priority === undefined ? undefined : TaskPriority.parse(input.priority) });
  if (captured) {
    return threadService.toolGet(runId, captured.task.id).then((task) => {
      if (!task) throw new Error("Captured team task was not found.");
      return { ...captured, task };
    });
  }
  if (input.execution !== "delegate" || !input.memberKey || !input.requestKey) return null;
  const previous = teams.dispatchReplay(runId, {
    memberKey: input.memberKey,
    requestKey: input.requestKey,
    title: input.title,
    spec: input.spec,
    dependencies: input.dependencies ?? [],
    attachments: [],
  });
  if (!previous) return null;
  if (input.dependencyTaskIds?.length) throw new Error("Immediate delegation uses assignment dependencies. Reuse the original request.");
  return threadService.toolGet(runId, previous.taskId!).then((task) => {
    if (!task) throw new Error("Reserved team task was not found.");
    return { task, duplicate: true, started: false, message: "This request already reserved the team assignment. Its accepted input and current task document are preserved." };
  });
}

async function captureTask({ teamTasks, threadService }: Pick<Dependencies, "teamTasks" | "threadService">, runId: string, input: Input): Promise<Result> {
  const captured = teamTasks.capture(runId, { ...input, priority: input.priority === undefined ? undefined : TaskPriority.parse(input.priority) });
  const task = await threadService.toolGet(runId, captured.task.id);
  if (!task) throw new Error("Captured team task was not found.");
  return { ...captured, task };
}

async function dispatchTask({ teams, threadService }: Pick<Dependencies, "teams" | "threadService">, runId: string, input: Input): Promise<Result> {
  if (!input.memberKey || !input.requestKey) throw new Error("Team dispatch requires member_key and request_key.");
  if (input.dependencyTaskIds?.length) throw new Error("Immediate delegation uses assignment dependencies. Save a backlog task to retain task dependencies.");
  const before = teams.statusForRun(runId);
  const actor = teams.dispatch(runId, {
    memberKey: input.memberKey,
    requestKey: input.requestKey,
    title: input.title,
    spec: input.spec,
    dependencies: input.dependencies ?? [],
    attachments: [],
  });
  const task = await threadService.toolGet(runId, actor.taskId!);
  if (!task) throw new Error("Reserved team task was not found.");
  return {
    task,
    duplicate: before.actors.some((item) => item.id === actor.id),
    started: false,
    message: "Team assignment reserved and queued. Call team_wait and end your turn to release capacity and receive results.",
  };
}

function createOrdinaryTask(threadService: Dependencies["threadService"], runId: string, input: Input) {
  if (input.memberKey || input.requestKey || input.dependencies?.length || input.dependencyTaskIds?.length)
    throw new Error("Team assignment fields require an authenticated team run. No task was created.");
  return threadService.toolCreate(runId, {
    title: input.title,
    spec: input.spec,
    execution: input.execution,
    labels: input.labels,
    ...(input.workspaceMode ? { workspaceMode: input.workspaceMode } : {}),
    ...(input.priority ? { priority: input.priority as never } : {}),
  });
}

export function createTaskCreateHost({ teams, teamTasks, threadService, db, assertTeamActor }: Dependencies): CreateTask {
  return async (runId, input) => {
    assertTeamActor(runId);
    if (!teams.binding(runId)) return createOrdinaryTask(threadService, runId, input);
    if (input.workspaceMode !== undefined) throw new Error("Team assignments use their team workspace policy; workspace_mode is only for ordinary tasks.");
    const replayed = replayTask({ teams, teamTasks, threadService }, runId, input);
    if (replayed) return replayed;
    if (input.execution !== "delegate" || runs.get(db, runId)?.mode !== "act" || threads.get(db, teams.statusForRun(runId).threadId)?.mode !== "act")
      return captureTask({ teamTasks, threadService }, runId, input);
    return dispatchTask({ teams, threadService }, runId, input);
  };
}
