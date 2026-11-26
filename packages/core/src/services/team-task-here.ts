import { projects, TASK_OWN_THREAD, teamTaskThreads, threads, type Db } from "@openorc/db";
import type { Hosted } from "@openorc/hosted";
import type { OnlineTask, Thread } from "@openorc/protocol";
import type { Logger } from "../transport.js";
import { AppSettingsService } from "./settings.js";

type Dependencies = {
  db: Db;
  account: () => Pick<Hosted, "tasks" | "spaces"> | null;
  invalidate: (keys: string[]) => void;
  log: Logger;
};

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** What the person's thread for a team task starts with, ready to send: the task, and how its agent reaches it. */
function draftFor(task: OnlineTask): string {
  return [`Work on the team task "${task.title}" (id ${task.id}) in this thread. Read it with task_get, naming this project's tasks on OpenOrc Cloud as its scope.`, task.spec ?? null]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * A team task's thread on this computer: in its project's folder here, ready to send, and named on the server as where
 * the task's work runs, so teammates see it and start no thread of their own. A deleted thread stops naming it.
 */
export class TeamTaskHere {
  constructor(private readonly deps: Dependencies) {}

  /** The task's thread here: the one it has, else a new one with its first message ready. */
  async open(spaceId: string, id: string): Promise<{ threadId: string }> {
    const account = this.deps.account();
    if (!account) throw new Error("Sign in to OpenOrc to open this task's thread.");
    const { task } = await account.tasks.get({ spaceId, id });
    const kept = teamTaskThreads.get(this.deps.db, spaceId, id, TASK_OWN_THREAD);
    const earlier = kept ? threads.get(this.deps.db, kept) : null;
    if (earlier && !earlier.archivedAt) {
      await account.tasks.onComputer(spaceId, id);
      return { threadId: earlier.id };
    }
    const local = (await account.spaces.projects(spaceId)).find((project) => project.hostedProjectId === task.projectId)?.localProjectId;
    const project = local ? projects.get(this.deps.db, local) : null;
    if (!project?.rootPath) throw new Error("Add this project on this computer to open its thread here.");
    // The server says first, so a task whose work runs elsewhere opens nothing here.
    await account.tasks.onComputer(spaceId, id);
    const thread = this.create(project.id, task);
    teamTaskThreads.link(this.deps.db, spaceId, id, TASK_OWN_THREAD, thread.id);
    this.deps.invalidate(["threads", "projects"]);
    return { threadId: thread.id };
  }

  /** Before a thread is deleted: what tells the server its team task's work no longer runs here, to call once it is gone. */
  releasing(threadId: string): (() => void) | null {
    const link = teamTaskThreads.ofThread(this.deps.db, threadId);
    if (link?.columnName !== TASK_OWN_THREAD) return null;
    return () =>
      void this.deps
        .account()
        ?.tasks.offComputer(link.spaceId, link.taskId)
        .catch((error: unknown) => this.deps.log.warn(`team tasks: ${link.taskId} still names this computer: ${errorText(error)}`));
  }

  private create(projectId: string, task: OnlineTask): Thread {
    const settings = new AppSettingsService(this.deps.db);
    const { defaultPermissionMode, defaultWorkspaceMode } = settings.get();
    const created = threads.insert(this.deps.db, {
      projectId,
      title: task.title,
      agent: settings.defaultAgent(),
      model: null,
      mode: "act",
      permissionMode: defaultPermissionMode,
      workspaceMode: defaultWorkspaceMode,
    });
    return threads.update(this.deps.db, created.id, { draft: draftFor(task) });
  }
}
