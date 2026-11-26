import { projects, teamTaskThreads, threads as threadRows, type Db } from "@openorc/db";
import type { Hosted, WaitingTaskRun } from "@openorc/hosted";
import type { Project } from "@openorc/protocol";
import type { Logger } from "../transport.js";
import { AppSettingsService } from "./settings.js";
import type { ThreadService } from "./threads.js";

type Dependencies = {
  db: Db;
  account: () => Pick<Hosted, "taskRuns" | "spaces"> | null;
  threads: Pick<ThreadService, "start" | "queue">;
  log: Logger;
};

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * What a team column's agent is told beyond its own instructions: the task, where it came from, and where it goes when
 * the work is done. It moves the card itself with the task tools, on the team's board.
 */
function brief({ task, column, fromColumnName }: WaitingTaskRun): string {
  const next = column.nextColumnName;
  return [
    column.job.prompt,
    `This is the team task "${task.title}" (id ${task.id}) on its project's board on OpenOrc Cloud, in the "${column.name}" column${fromColumnName ? `, which it came to from "${fromColumnName}"` : ""}.`,
    task.spec ? `The task:\n${task.spec}` : null,
    next ? `When your work on it is finished, move it to the "${next}" column with task_update, naming this project's tasks on OpenOrc Cloud as its scope and "${next}" as its column.` : null,
    "A task whose work needs more can be moved back to an earlier column the same way. Leave it where it is until you have decided.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Team boards' column agents, run on this computer for the tasks of the person signed in. A card that lands in a
 * column with an agent asks it of the task's assignee; the server keeps it waiting until one of their computers claims
 * it. This one looks when it may have some: on a notice for this person, and on each new connection, which may have
 * missed notices or come after this computer was off. It claims each, and starts the column's agent in the project's
 * folder here, in a thread of its own for the task and column, or continues that thread when the card comes back. With
 * no folder here for the project, it says so, and the card shows it.
 */
export class TeamColumnRuns {
  private unsubscribe: (() => void) | null = null;
  private readonly looking = new Map<string, Promise<void>>();
  private readonly again = new Set<string>();

  constructor(private readonly deps: Dependencies) {}

  start(): void {
    const account = this.deps.account();
    if (!account || this.unsubscribe) return;
    this.unsubscribe = account.taskRuns.onWaiting((spaceId) => void this.check(spaceId));
    for (const spaceId of account.taskRuns.organizations()) void this.check(spaceId);
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** Looks at what waits in an organization, one look at a time. Asked again while it looks, it looks once more after. */
  check(spaceId: string): Promise<void> {
    const current = this.looking.get(spaceId);
    if (current) {
      this.again.add(spaceId);
      return current;
    }
    const look = this.look(spaceId)
      .catch((error: unknown) => this.deps.log.warn(`team column agents: a look in ${spaceId} failed: ${errorText(error)}`))
      .finally(() => {
        this.looking.delete(spaceId);
        if (this.again.delete(spaceId)) void this.check(spaceId);
      });
    this.looking.set(spaceId, look);
    return look;
  }

  private async look(spaceId: string): Promise<void> {
    const account = this.deps.account();
    if (!account) return;
    const waiting = await account.taskRuns.waiting(spaceId);
    if (waiting.length === 0) return;
    const paired = await account.spaces.projects(spaceId);
    for (const item of waiting) {
      const local = paired.find((project) => project.hostedProjectId === item.task.projectId)?.localProjectId;
      const project = local ? projects.get(this.deps.db, local) : null;
      if (!project?.rootPath) {
        await account.taskRuns.noFolder(spaceId, item.run.id);
        continue;
      }
      if (!(await account.taskRuns.claim(spaceId, item.run.id))) continue;
      await this.run(spaceId, project, item).catch((error: unknown) => this.deps.log.warn(`team column agents: "${item.column.name}" did not start for ${item.task.id}: ${errorText(error)}`));
    }
  }

  /** Its column's agent, in the thread that worked the task there before while there is one, else in a new one. */
  private async run(spaceId: string, project: Project, item: WaitingTaskRun): Promise<void> {
    const { db } = this.deps;
    const told = brief(item);
    const earlier = teamTaskThreads.get(db, spaceId, item.task.id, item.column.name);
    const thread = earlier ? threadRows.get(db, earlier) : null;
    if (thread && !thread.archivedAt) return void this.deps.threads.queue(thread.id, `This task is back in the "${item.column.name}" column.\n\n${told}`);
    const settings = new AppSettingsService(db);
    const { defaultPermissionMode: permissionMode, defaultWorkspaceMode: workspaceMode } = settings.get();
    const choice = item.column.job.choice;
    // The account a column names is its writer's; here the agent runs on this person's own.
    const { thread: started } = await this.deps.threads.start({
      projectId: project.id,
      agent: choice?.agent ?? settings.defaultAgent(),
      model: choice?.model,
      effort: choice?.effort ?? undefined,
      mode: "act",
      permissionMode,
      workspaceMode,
      prompt: told,
      attachments: undefined,
      title: `${item.column.name} · ${item.task.title}`.slice(0, 120),
    });
    teamTaskThreads.link(db, spaceId, item.task.id, item.column.name, started.id);
  }
}
