import { randomUUID } from "node:crypto";
import type { TaskCard, TaskScope, TaskTools } from "@openorc/mcp";
import { TaskPriority, type OnlineTask } from "@openorc/protocol";
import { captureOnlineTaskScope, type CapturedOnlineTaskScope, type OnlineTaskScopeDependencies } from "./online-task-scope.js";

type CreateInput = Parameters<TaskTools["create"]>[1] & { scope: TaskScope };
type UpdateInput = Parameters<TaskTools["update"]>[2] & { scope: TaskScope };

const NO_CONTEXT = "No task context.";
const SAVED = "Saved to backlog. To work on it, open this task's cloud thread.";
const START_IN_CLOUD = "Open this task's cloud thread to start it.";
const READ_FIRST = "Read this task before changing it.";
const READ_AGAIN = "This task changed. Read it again before changing it.";

/**
 * The task tools of an agent on this Mac when it names an online task's space and project. Each call captures the run's
 * account, process and project and holds them after every wait, so switching space, account or run never retargets
 * it. A change uses the revision this run last read of that task, never a newer one read on its behalf; after a
 * conflict the agent reads it again. A create or change whose reply was lost goes again under its first request.
 * Starting an online task belongs to its cloud thread, and context never reads this Mac's memory.
 */
export class OnlineTaskTools {
  /** The revision each run last read of each task, by captured target. */
  readonly #seen = new Map<string, Map<string, number>>();
  /** A write's request id until the server answers it, by captured target and the write's words. */
  readonly #requests = new Map<string, string>();
  constructor(readonly deps: OnlineTaskScopeDependencies) {}

  /** As the Mac lists a project's tasks: every one but the archived, open ones first. */
  async list(runId: string, scope: TaskScope): Promise<TaskCard[]> {
    const at = await this.#capture(runId, scope);
    const read = { spaceId: at.spaceId, projectId: at.projectId, limit: 200 };
    const open = await at.tasks.list(read);
    const done = await at.tasks.list({ ...read, status: "done" });
    at.assert();
    return [...open.tasks, ...done.tasks].filter((task) => task.projectId === at.projectId).map((task) => this.#card(at, task));
  }
  async get(runId: string, id: string, scope: TaskScope): Promise<TaskCard> {
    const at = await this.#capture(runId, scope);
    return this.#card(at, await this.#read(at, id));
  }
  async create(runId: string, input: CreateInput): ReturnType<TaskTools["create"]> {
    const at = await this.#capture(runId, input.scope);
    const priority = TaskPriority.safeParse(input.priority);
    const fields = { title: input.title, spec: input.spec, ...(priority.success ? { priority: priority.data } : {}), ...(input.labels ? { labels: input.labels } : {}) };
    const request = this.#request(at, ["create", fields]);
    const result = await at.tasks.creation({ spaceId: at.spaceId, projectId: at.projectId, requestId: request.id, ...fields });
    request.done();
    if (result.state === "refused") throw new Error(result.message);
    return { task: this.#card(at, at.task(result.task)), duplicate: false, started: false, message: SAVED };
  }
  async update(runId: string, id: string, input: UpdateInput): Promise<TaskCard> {
    const at = await this.#capture(runId, input.scope);
    // The task must be this run's project's; the revision read here is not the agent's.
    await this.#read(at, id);
    const seen = this.#seen.get(at.key);
    const ifRevision = input.ifRevision ?? seen?.get(id);
    if (ifRevision === undefined) throw new Error(READ_FIRST);
    const patch = { ...(input.status ? { status: input.status } : {}), ...(input.spec !== undefined ? { spec: input.spec } : {}) };
    const request = this.#request(at, ["update", id, ifRevision, patch]);
    const result = await at.tasks.editing({ spaceId: at.spaceId, id, ifRevision, requestId: request.id, patch });
    request.done();
    if (result.state === "refused") throw new Error(result.message);
    if (result.state === "conflict") {
      seen?.delete(id);
      throw new Error(READ_AGAIN);
    }
    return this.#card(at, at.task(result.task));
  }
  async start(runId: string, id: string, scope: TaskScope): Promise<TaskCard> {
    const at = await this.#capture(runId, scope);
    return { ...this.#card(at, await this.#read(at, id)), message: START_IN_CLOUD };
  }
  async context(runId: string, scope: TaskScope, taskId?: string): Promise<string> {
    const at = await this.#capture(runId, scope);
    if (!taskId) return NO_CONTEXT;
    const result = await at.tasks.context({ spaceId: at.spaceId, id: taskId });
    at.task(result.task);
    return result.context ?? NO_CONTEXT;
  }

  #capture(runId: string, scope: TaskScope): Promise<CapturedOnlineTaskScope> {
    return captureOnlineTaskScope(this.deps, runId, scope);
  }
  async #read(at: CapturedOnlineTaskScope, id: string): Promise<OnlineTask> {
    const { task } = await at.tasks.get({ spaceId: at.spaceId, id });
    return at.task(task);
  }
  #request(at: CapturedOnlineTaskScope, write: unknown[]) {
    const key = JSON.stringify([at.key, ...write]);
    const id = this.#requests.get(key) ?? randomUUID();
    this.#requests.set(key, id);
    return { id, done: () => this.#requests.delete(key) };
  }
  /** The task as the Mac's tools give it, naming the server's task; the agent has now read this revision. */
  #card(at: CapturedOnlineTaskScope, task: OnlineTask): TaskCard {
    const seen = this.#seen.get(at.key) ?? new Map<string, number>();
    this.#seen.set(at.key, seen.set(task.id, task.revision));
    return {
      id: task.id,
      taskRef: { place: "server", spaceId: task.spaceId, projectId: task.projectId, id: task.id },
      revision: task.revision,
      title: task.title,
      spec: task.spec,
      status: task.status,
      branch: null,
      current: false,
      resultSummary: null,
      activity: task.activity,
    };
  }
}
