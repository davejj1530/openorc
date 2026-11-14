import { randomUUID } from "node:crypto";
import { OnlineTaskOpen } from "@openorc/protocol";
import { fixturePerson, taskFixtureView, taskFixtureWire, type TaskFixtureDeps, type TaskFixtureRecord } from "./stand-in-task-data.js";

type Reply = { status: number; body: unknown };
type Receipt = { digest: string; threadId: string; created: boolean };
const refusal = (status: number, message: string, code?: string): Reply => ({ status, body: { message, code } });

export class StandInTaskThreads {
  readonly #receipts = new Map<string, Receipt>();
  constructor(private readonly deps: TaskFixtureDeps) {}
  open(record: TaskFixtureRecord, who: string, body: unknown, accessRevision: number): Reply {
    const parsed = OnlineTaskOpen.safeParse(body);
    if (!parsed.success) return refusal(400, "Check the task revision.");
    const task = record.task;
    const key = JSON.stringify([who, task.spaceId, task.id, parsed.data.requestId]);
    const digest = JSON.stringify(parsed.data),
      prior = this.#receipts.get(key);
    if (prior && prior.digest !== digest) return refusal(409, "This request ID was already used.", "REQUEST_CHANGED");
    if (task.execution.state === "unavailable" || task.execution.state === "private") return refusal(409, "Thread unavailable", "TASK_THREAD_UNAVAILABLE");
    if (task.execution.state === "readable") {
      if (!this.#readable(task.execution.threadId, task.spaceId, who)) return refusal(409, "Thread unavailable", "TASK_THREAD_UNAVAILABLE");
      const receipt = prior ?? { digest, threadId: task.execution.threadId, created: false };
      this.#receipts.set(key, receipt);
      return this.#reply(record, who, accessRevision, receipt);
    }
    if (parsed.data.ifRevision !== task.revision) return { status: 409, body: { code: "TASK_CHANGED", current: { accessRevision, task: taskFixtureWire(taskFixtureView(this.deps, record, who)) } } };
    const threads = this.deps.threads;
    if (!threads) return refusal(404, "Thread unavailable");
    const threadId = threads.addThread(who, { projectId: task.projectId, title: task.title });
    threads.route({ method: "PATCH", path: `/hosted/threads/${threadId}`, query: new URLSearchParams(), space: task.spaceId }, who, { settings: { mode: "act", permissionMode: "review" } });
    task.execution = { state: "readable", threadId, title: task.title };
    task.revision++;
    task.updatedAt = Date.now();
    task.updatedBy = fixturePerson(this.deps, who);
    record.history.push({ id: randomUUID(), actor: task.updatedBy, kind: "thread_linked", at: task.updatedAt, revision: task.revision, changes: { thread: { before: null, after: threadId } } });
    const receipt = { digest, threadId, created: true };
    this.#receipts.set(key, receipt);
    for (const reader of this.deps.spaces.readers(task.spaceId)) this.deps.tell(reader, ["projects", "threads"], task.spaceId);
    return this.#reply(record, who, accessRevision, receipt);
  }
  #readable(id: string, space: string, who: string): boolean {
    return this.deps.threads?.route({ method: "GET", path: `/hosted/threads/${id}`, query: new URLSearchParams(), space }, who, {})?.status === 200;
  }
  #reply(record: TaskFixtureRecord, who: string, accessRevision: number, receipt: Receipt): Reply {
    const task = taskFixtureView(this.deps, record, who);
    return {
      status: 200,
      body: { accessRevision, task: taskFixtureWire(task), threadId: receipt.threadId, created: receipt.created, draft: `${task.title}\n\nTask ID: ${task.id}${task.spec ? `\n\n${task.spec}` : ""}` },
    };
  }
}
