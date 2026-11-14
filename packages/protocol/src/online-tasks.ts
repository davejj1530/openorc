import { z } from "zod";
import { TaskPriority, TaskStatus } from "./domain.js";
import { SpaceId } from "./spaces.js";

const id = z.string().min(1).max(200);
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const timestamp = z.number().finite();
export const OnlineTaskRef = z.object({ kind: z.literal("online"), accountId: id, spaceId: SpaceId, projectId: id, id }).strict();
export type OnlineTaskRef = z.infer<typeof OnlineTaskRef>;
export const OnlineTaskPerson = z.object({ userId: id, name: z.string(), image: z.string().nullable() });
export const OnlineTaskAssignee = OnlineTaskPerson.extend({ memberId: id, available: z.boolean() });
export type OnlineTaskAssignee = z.infer<typeof OnlineTaskAssignee>;
export const OnlineTaskLink = z.discriminatedUnion("state", [
  z.object({ state: z.literal("none") }),
  z.object({ state: z.literal("readable"), threadId: id, title: z.string() }),
  z.object({ state: z.literal("private") }),
  z.object({ state: z.literal("unavailable") }),
]);
export const OnlineTaskActivity = z.object({
  runId: id,
  state: z.enum(["working", "waiting", "idle", "completed", "failed", "cancelled"]),
  latestMessage: z.string().nullable(),
  lastAction: z.string().nullable(),
  waitingFor: z.string().nullable(),
  updatedAt: timestamp,
});
export const OnlineTask = z.object({
  id,
  spaceId: SpaceId,
  organizationId: id.nullable(),
  projectId: id,
  title: z.string(),
  spec: z.string().nullable(),
  status: TaskStatus,
  priority: TaskPriority,
  labels: z.array(z.string()),
  origin: z.enum(["user", "agent"]),
  creator: OnlineTaskPerson,
  updatedBy: OnlineTaskPerson.nullable(),
  assignee: OnlineTaskAssignee.nullable(),
  revision,
  assignmentRevision: revision,
  createdAt: timestamp,
  updatedAt: timestamp,
  completedAt: timestamp.nullable(),
  createdIn: OnlineTaskLink,
  execution: OnlineTaskLink,
  activity: OnlineTaskActivity.nullable(),
  viewer: z.object({
    unseenAssignment: z.boolean(),
    attention: z.array(z.enum(["assignment", "review", "proposal", "ask"])),
    mayEdit: z.boolean(),
    mayDelete: z.boolean(),
    mayOpenThread: z.boolean(),
    liveExecution: z.boolean(),
  }),
});
export type OnlineTask = z.infer<typeof OnlineTask>;
export const OnlineTaskEnvelope = z.object({ accessRevision: revision, task: OnlineTask });
export type OnlineTaskEnvelope = z.infer<typeof OnlineTaskEnvelope>;
export const OnlineTaskPage = z.object({ accessRevision: revision, tasks: z.array(OnlineTask), cursor: z.string().nullable() });
export type OnlineTaskPage = z.infer<typeof OnlineTaskPage>;
export const OnlineTaskAttention = z.object({ accessRevision: revision, count: revision });
export const OnlineTaskRoster = z.object({ accessRevision: revision, people: z.array(OnlineTaskAssignee), cursor: z.string().nullable() });
export const OnlineTaskHistoryEntry = z.object({
  id,
  kind: z.enum(["created", "edited", "assigned", "unassigned", "status_changed", "thread_linked"]),
  actor: OnlineTaskPerson.nullable(),
  at: timestamp,
  revision,
  changes: z.partialRecord(
    z.enum(["title", "spec", "status", "priority", "labels", "assignee", "thread"]),
    z.object({ before: z.union([z.string(), z.array(z.string()), z.null()]), after: z.union([z.string(), z.array(z.string()), z.null()]) }),
  ),
});
export type OnlineTaskHistoryEntry = z.infer<typeof OnlineTaskHistoryEntry>;
export const OnlineTaskHistory = z.object({ accessRevision: revision, entries: z.array(OnlineTaskHistoryEntry), cursor: z.string().nullable() });
export const OnlineTaskContext = z.object({ accessRevision: revision, task: OnlineTask, context: z.string().nullable() });

export const OnlineTaskPatch = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    spec: z.string().max(200_000).nullable().optional(),
    status: TaskStatus.optional(),
    priority: TaskPriority.optional(),
    labels: z.array(z.string().max(80)).max(32).optional(),
    assigneeMemberId: id.nullable().optional(),
  })
  .strict();
export type OnlineTaskPatch = z.infer<typeof OnlineTaskPatch>;
export const OnlineTaskCreate = OnlineTaskPatch.omit({ status: true })
  .extend({
    requestId: z.uuid(),
    projectId: id,
    title: z.string().trim().min(1).max(200),
    spec: z.string().max(200_000).optional(),
    source: z.discriminatedUnion("kind", [z.object({ kind: z.literal("thread"), threadId: id }).strict(), z.object({ kind: z.literal("private") }).strict()]).optional(),
  })
  .strict();
export const OnlineTaskUpdate = z.object({ requestId: z.uuid(), ifRevision: revision, patch: OnlineTaskPatch }).strict();
export const OnlineTaskDelete = z.object({ requestId: z.uuid(), ifRevision: revision }).strict();
export const OnlineTaskSeen = z.object({ requestId: z.uuid(), assignmentRevision: revision }).strict();
export const OnlineTaskList = z
  .object({ projectId: id.optional(), status: TaskStatus.optional(), assignee: z.literal("me").optional(), cursor: z.string().optional(), limit: z.number().int().min(1).max(200).optional() })
  .strict();
export type OnlineTaskCreation = ({ state: "saved" } & OnlineTaskEnvelope) | { state: "refused"; code: string; message: string };
export type OnlineTaskMutation = ({ state: "saved" } | { state: "conflict" }) & OnlineTaskEnvelope;
export type OnlineTaskAvailability = { state: "unavailable" } | { state: "ready"; accountId: string; spaceId: string; execution: boolean; personal: boolean };
const scope = { spaceId: SpaceId };
const target = { ...scope, id };
export const onlineTaskRpcParams = {
  "tasks.online.state": z.object(scope).strict(),
  "tasks.online.list": OnlineTaskList.extend(scope).strict(),
  "tasks.online.get": z.object(target).strict(),
  "tasks.online.create": OnlineTaskCreate.extend(scope).strict(),
  "tasks.online.update": OnlineTaskUpdate.extend(target).strict(),
  "tasks.online.delete": OnlineTaskDelete.extend(target).strict(),
  "tasks.online.seen": OnlineTaskSeen.extend(target).strict(),
  "tasks.online.attention": z.object(scope).strict(),
  "tasks.online.assignees": z.object({ ...scope, projectId: id, query: z.string().optional(), cursor: z.string().optional() }).strict(),
  "tasks.online.activity": z.object({ ...target, cursor: z.string().optional(), limit: z.number().int().min(1).max(200).optional() }).strict(),
  "tasks.online.context": z.object(target).strict(),
};
export type OnlineTaskParams<M extends keyof typeof onlineTaskRpcParams> = z.infer<(typeof onlineTaskRpcParams)[M]>;
export interface OnlineTaskRpcResults {
  "tasks.online.state": OnlineTaskAvailability;
  "tasks.online.list": OnlineTaskPage;
  "tasks.online.get": OnlineTaskEnvelope;
  "tasks.online.create": OnlineTaskCreation;
  "tasks.online.update": OnlineTaskMutation;
  "tasks.online.delete": { state: "deleted" } | ({ state: "conflict" } & OnlineTaskEnvelope);
  "tasks.online.seen": OnlineTaskEnvelope;
  "tasks.online.attention": z.infer<typeof OnlineTaskAttention>;
  "tasks.online.assignees": z.infer<typeof OnlineTaskRoster>;
  "tasks.online.activity": z.infer<typeof OnlineTaskHistory>;
  "tasks.online.context": z.infer<typeof OnlineTaskContext>;
}
