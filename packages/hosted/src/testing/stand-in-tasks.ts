import { randomUUID } from "node:crypto";
import { OnlineTaskCreate, OnlineTaskDelete, OnlineTaskSeen, OnlineTaskUpdate, type OnlineTask, type OnlineTaskAssignee, type OnlineTaskHistoryEntry } from "@openorc/protocol";
import { taskFixture, taskFixtureView, taskFixtureWire, fixturePerson, type TaskFixtureDeps, type TaskFixtureRecord } from "./stand-in-task-data.js";
import { userOf } from "./stand-in-spaces.js";
import { StandInTaskThreads } from "./stand-in-task-threads.js";

type Reply = { status: number; body: unknown };
type Request = { method: string; path: string; query: URLSearchParams; space: string | null };
const refused = (status: number, message: string, code?: string): Reply => ({ status, body: { message, ...(code ? { code } : {}) } });
const absent = () => refused(404, "This task isn't available.");
const ok = (body: unknown): Reply => ({ status: 200, body });

/** Loopback task fixture: real request boundaries, viewer-specific attention, and durable retry identities. */
export class StandInTasks {
  enabled = false;
  accessRevision = 1;
  readonly frozen = new Set<string>();
  readonly records = new Map<string, TaskFixtureRecord>();
  readonly #receipts = new Map<string, { digest: string; reply: Reply }>();
  readonly #threads: StandInTaskThreads;
  constructor(private readonly deps: TaskFixtureDeps) {
    this.#threads = new StandInTaskThreads(deps);
  }
  seed(spaceId: string, who: string, projectId: string, values: Partial<OnlineTask> = {}) {
    const record = taskFixture(this.deps, spaceId, who, projectId, values);
    this.records.set(record.task.id, record);
    return record.task;
  }
  roster(spaceId: string, projectId: string): OnlineTaskAssignee[] {
    return (this.deps.spaces.teams.get(spaceId)?.members ?? [])
      .filter((member) => this.deps.spaces.canRead(spaceId, projectId, member.email))
      .map((member) => ({
        ...fixturePerson(this.deps, member.email),
        memberId: member.id,
        available: !this.frozen.has(member.email),
      }));
  }
  changed(spaceId: string): void {
    for (const who of this.deps.spaces.readers(spaceId)) this.deps.tell(who, ["projects"], spaceId);
  }
  route(request: Request, who: string, body: unknown): Reply | null {
    if (!/^\/tasks(?:\/|$)/.test(request.path)) return null;
    if (!this.enabled) return absent();
    const spaceId = request.space;
    if (!spaceId) return refused(400, "Name the space in x-openorc-space.");
    if (!this.deps.spaces.readers(spaceId).includes(who)) return absent();
    if (this.frozen.has(who) && this.deps.spaces.teams.has(spaceId)) return refused(403, "Organization access is frozen.", "organization_frozen");
    if (request.path === "/tasks" && request.method === "GET") return this.#list(spaceId, who, request.query);
    if (request.path === "/tasks/attention")
      return ok({ accessRevision: this.accessRevision, count: this.#visible(spaceId, who).filter((record) => taskFixtureView(this.deps, record, who).viewer.attention.length).length });
    if (request.path === "/tasks/assignees") return this.#roster(spaceId, who, request.query);
    return this.#target(request, spaceId, who, body);
  }
  #target(request: Request, spaceId: string, who: string, body: unknown): Reply {
    if (request.path === "/tasks" && request.method === "POST") return this.#receipt(request, spaceId, who, body, () => this.#create(spaceId, who, body));
    const match = /^\/tasks\/([^/]+)(?:\/(seen|activity|context|open-thread))?$/.exec(request.path);
    const record = match?.[1] ? this.records.get(decodeURIComponent(match[1])) : undefined;
    if (!record || record.task.spaceId !== spaceId || !this.#readable(record, who)) return absent();
    if (match?.[2] === "open-thread" && request.method === "POST") return this.#threads.open(record, who, body, this.accessRevision);
    if (request.method === "GET") return this.#read(record, who, match?.[2]);
    return this.#receipt(request, spaceId, who, body, () => this.#write(request, record, who, body));
  }
  #visible(spaceId: string, who: string) {
    return [...this.records.values()].filter((record) => record.task.spaceId === spaceId && this.#readable(record, who));
  }
  #readable(record: TaskFixtureRecord, who: string): boolean {
    return this.deps.spaces.canRead(record.task.spaceId, record.task.projectId, who);
  }
  #envelope(record: TaskFixtureRecord, who: string) {
    return { accessRevision: this.accessRevision, task: taskFixtureWire(taskFixtureView(this.deps, record, who)) };
  }
  #roster(spaceId: string, who: string, query: URLSearchParams): Reply {
    const projectId = query.get("projectId");
    if (!projectId || !this.deps.spaces.project(spaceId, projectId) || !this.deps.spaces.canRead(spaceId, projectId, who)) return absent();
    const search = (query.get("query") ?? "").toLowerCase();
    return ok({ accessRevision: this.accessRevision, people: this.roster(spaceId, projectId).filter((person) => person.name.toLowerCase().includes(search)), cursor: null });
  }
  #list(spaceId: string, who: string, query: URLSearchParams): Reply {
    const status = query.get("status"),
      projectId = query.get("projectId");
    const tasks = this.#visible(spaceId, who)
      .map((record) => taskFixtureView(this.deps, record, who))
      .filter(
        (task) =>
          (!projectId || task.projectId === projectId) &&
          (status ? task.status === status : task.status !== "done" && task.status !== "archived") &&
          (query.get("assignee") !== "me" || task.assignee?.userId === userOf(who)),
      )
      .sort((a, b) => Number(b.viewer.unseenAssignment) - Number(a.viewer.unseenAssignment) || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
    const offset = Number(query.get("cursor") ?? 0),
      limit = Math.min(200, Number(query.get("limit") ?? 100));
    return ok({ accessRevision: this.accessRevision, tasks: tasks.slice(offset, offset + limit).map(taskFixtureWire), cursor: offset + limit < tasks.length ? String(offset + limit) : null });
  }
  #read(record: TaskFixtureRecord, who: string, subpath?: string): Reply {
    if (subpath === "activity") return ok({ accessRevision: this.accessRevision, entries: record.history.map((entry) => ({ ...entry, at: new Date(entry.at).toISOString() })), cursor: null });
    if (subpath === "context") return ok({ ...this.#envelope(record, who), context: null });
    return ok(this.#envelope(record, who));
  }
  #receipt(request: Request, spaceId: string, who: string, body: unknown, apply: () => Reply): Reply {
    if (!body || typeof body !== "object" || !("requestId" in body) || typeof body.requestId !== "string") return refused(400, "A request ID is required.");
    const key = JSON.stringify([who, spaceId, request.method, request.path, body.requestId]);
    const digest = JSON.stringify(body),
      prior = this.#receipts.get(key);
    if (prior) return prior.digest === digest ? prior.reply : refused(409, "This request ID was already used.", "REQUEST_CHANGED");
    const reply = apply();
    if (reply.status < 300) {
      this.#receipts.set(key, { digest, reply });
      this.changed(spaceId);
    }
    return reply;
  }
  #create(spaceId: string, who: string, body: unknown): Reply {
    const parsed = OnlineTaskCreate.safeParse(body);
    if (!parsed.success) return refused(400, "Check the task's fields.");
    const { projectId, title, spec, priority, labels, assigneeMemberId, source } = parsed.data;
    if (!this.deps.spaces.project(spaceId, projectId) || !this.deps.spaces.canRead(spaceId, projectId, who)) return absent();
    const assignee = assigneeMemberId ? this.roster(spaceId, projectId).find((person) => person.memberId === assigneeMemberId && person.available) : null;
    if (assigneeMemberId && !assignee) return refused(400, "Choose someone who can use this project.");
    const task = this.seed(spaceId, who, projectId, {
      title,
      spec: spec ?? null,
      priority: priority ?? "none",
      labels: labels ?? [],
      assignee: assignee ?? null,
      assignmentRevision: assignee ? 1 : 0,
      createdIn: source?.kind === "private" ? { state: "private" } : { state: "none" },
    });
    const record = this.records.get(task.id)!;
    if (assignee?.userId === userOf(who)) record.seen = task.assignmentRevision;
    this.#history(record, who, "created", {});
    return { status: 201, body: this.#envelope(record, who) };
  }
  #write(request: Request, record: TaskFixtureRecord, who: string, body: unknown): Reply {
    if (request.path.endsWith("/seen") && request.method === "POST") {
      const parsed = OnlineTaskSeen.safeParse(body);
      if (!parsed.success) return refused(400, "Check the assignment revision.");
      if (record.task.assignee?.userId === userOf(who) && record.task.assignmentRevision === parsed.data.assignmentRevision) record.seen = parsed.data.assignmentRevision;
      return ok(this.#envelope(record, who));
    }
    if (request.method === "DELETE") return this.#delete(record, who, body);
    if (request.method === "PATCH") return this.#update(record, who, body);
    return absent();
  }
  #conflict(record: TaskFixtureRecord, who: string): Reply {
    return { status: 409, body: { code: "TASK_CHANGED", message: "This task changed.", current: this.#envelope(record, who) } };
  }
  #delete(record: TaskFixtureRecord, who: string, body: unknown): Reply {
    const parsed = OnlineTaskDelete.safeParse(body);
    if (!parsed.success) return refused(400, "Check the task revision.");
    if (record.task.viewer.liveExecution) return refused(409, "Wait for this task's turn to finish.", "TASK_RUNNING");
    if (!taskFixtureView(this.deps, record, who).viewer.mayDelete) return refused(403, "Only its creator or an admin can delete this task.");
    if (parsed.data.ifRevision !== record.task.revision) return this.#conflict(record, who);
    this.records.delete(record.task.id);
    return { status: 204, body: null };
  }
  #update(record: TaskFixtureRecord, who: string, body: unknown): Reply {
    const parsed = OnlineTaskUpdate.safeParse(body);
    if (!parsed.success) return refused(400, "Check the task's fields.");
    if (parsed.data.ifRevision !== record.task.revision) return this.#conflict(record, who);
    const { assigneeMemberId, ...fields } = parsed.data.patch;
    const task = record.task;
    const changes: OnlineTaskHistoryEntry["changes"] = {};
    const assignment = this.#assign(record, who, assigneeMemberId, changes);
    if (assignment) return assignment;
    for (const key of ["title", "spec", "status", "priority", "labels"] as const) {
      const value = fields[key];
      if (value !== undefined && JSON.stringify(task[key]) !== JSON.stringify(value)) changes[key] = { before: task[key], after: value };
    }
    if (Object.keys(changes).length) {
      Object.assign(task, fields);
      task.revision++;
      task.updatedAt = Date.now();
      task.updatedBy = fixturePerson(this.deps, who);
      task.completedAt = task.status === "done" ? task.updatedAt : null;
      let kind: OnlineTaskHistoryEntry["kind"] = fields.status ? "status_changed" : "edited";
      if (changes.assignee) kind = task.assignee ? "assigned" : "unassigned";
      this.#history(record, who, kind, changes);
    }
    return ok(this.#envelope(record, who));
  }
  #assign(record: TaskFixtureRecord, who: string, memberId: string | null | undefined, changes: OnlineTaskHistoryEntry["changes"]): Reply | null {
    const task = record.task;
    if (memberId === undefined || memberId === (task.assignee?.memberId ?? null)) return null;
    const assignee = memberId ? this.roster(task.spaceId, task.projectId).find((person) => person.memberId === memberId && person.available) : null;
    if (memberId && !assignee) return refused(400, "Choose someone who can use this project.");
    changes.assignee = { before: task.assignee?.memberId ?? null, after: memberId };
    task.assignee = assignee ?? null;
    task.assignmentRevision++;
    record.seen = assignee?.userId === userOf(who) ? task.assignmentRevision : 0;
    return null;
  }
  #history(record: TaskFixtureRecord, who: string, kind: OnlineTaskHistoryEntry["kind"], changes: OnlineTaskHistoryEntry["changes"]): void {
    record.history.push({ id: randomUUID(), actor: fixturePerson(this.deps, who), kind, at: Date.now(), revision: record.task.revision, changes });
  }
}
