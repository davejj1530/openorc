import { randomUUID } from "node:crypto";
import type { OnlineTask, OnlineTaskHistoryEntry } from "@openorc/protocol";
import type { StandInSpaces } from "./stand-in-spaces.js";
import { userOf } from "./stand-in-spaces.js";

export interface TaskFixtureDeps {
  spaces: StandInSpaces;
  person(email: string): { name: string; image: string | null };
  tell(who: string, topics: string[], space?: string): void;
}
export interface TaskFixtureRecord {
  task: OnlineTask;
  seen: number;
  history: OnlineTaskHistoryEntry[];
  asks: Set<string>;
}
export function fixturePerson(deps: TaskFixtureDeps, who: string) {
  return { userId: userOf(who), ...deps.person(who) };
}
export function taskFixture(deps: TaskFixtureDeps, spaceId: string, who: string, projectId: string, values: Partial<OnlineTask> = {}): TaskFixtureRecord {
  const task: OnlineTask = {
    id: randomUUID(),
    spaceId,
    organizationId: deps.spaces.teams.has(spaceId) ? spaceId : null,
    projectId,
    title: "Export activity",
    spec: null,
    status: "backlog",
    priority: "none",
    labels: [],
    origin: "user",
    creator: fixturePerson(deps, who),
    updatedBy: null,
    assignee: null,
    revision: 1,
    assignmentRevision: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    completedAt: null,
    createdIn: { state: "none" },
    execution: { state: "none" },
    activity: null,
    viewer: { unseenAssignment: false, attention: [], mayEdit: true, mayDelete: false, mayOpenThread: false, liveExecution: false },
    ...values,
  };
  return { task, seen: 0, history: [], asks: new Set() };
}
export function taskFixtureView(deps: TaskFixtureDeps, record: TaskFixtureRecord, who: string): OnlineTask {
  const { task } = record;
  const userId = userOf(who);
  const active = task.status !== "done" && task.status !== "archived";
  const unseen = active && task.assignee?.userId === userId && task.assignmentRevision > record.seen;
  const responsible = task.assignee?.userId ?? task.creator.userId;
  const attention: OnlineTask["viewer"]["attention"] = [];
  if (unseen) attention.push("assignment");
  if (active && responsible === userId && task.status === "review") attention.push("review");
  if (active && responsible === userId && task.status === "proposed") attention.push("proposal");
  if (record.asks.has(userId)) attention.push("ask");
  return {
    ...task,
    viewer: {
      ...task.viewer,
      unseenAssignment: unseen,
      attention,
      mayDelete: !task.viewer.liveExecution && (task.creator.userId === userId || deps.spaces.member(task.spaceId, who)?.role === "admin"),
    },
  };
}
export function taskFixtureWire(task: OnlineTask) {
  return {
    ...task,
    createdAt: new Date(task.createdAt).toISOString(),
    updatedAt: new Date(task.updatedAt).toISOString(),
    completedAt: task.completedAt === null ? null : new Date(task.completedAt).toISOString(),
    activity: task.activity ? { ...task.activity, updatedAt: new Date(task.activity.updatedAt).toISOString() } : null,
  };
}
