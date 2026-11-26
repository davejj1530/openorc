import { z } from "zod";
import { BoardColumn, BoardColumnsSave } from "./board.js";
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
/**
 * The agent a team task's column started, asked of the person it runs for, on one of their computers or on OpenOrc
 * Cloud as them: waiting for it to start, running, on a computer with no folder for the project, held after agents sent
 * the card to the column too often (a person's own move starts it again), failed to start with why, or finished.
 */
export const OnlineTaskRun = z.object({
  id,
  columnId: id,
  /** On the runner's computer, or on OpenOrc Cloud as them; a server before cloud runs sends none, for a computer. */
  where: z.enum(["computer", "cloud"]).optional(),
  state: z.enum(["waiting", "running", "no_folder", "held", "failed", "finished"]),
  runner: z.object({ userId: id, name: z.string() }).nullable(),
  /** Why a failed run did not start, in a teammate's words. */
  reason: z.string().nullable().optional(),
  requestedAt: timestamp,
});
export type OnlineTaskRun = z.infer<typeof OnlineTaskRun>;

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
  /** The column of its project's board the task sits in. A server without boards leaves it out. */
  columnId: id.nullable().optional(),
  /** Its column's agent, while one is asked of someone. A server that runs none leaves it out. */
  run: OnlineTaskRun.nullable().optional(),
  /** The person whose computer the task's work runs on, in a thread there, and since when. A server that knows none leaves it out. */
  computer: z.object({ userId: id, name: z.string(), since: timestamp }).nullable().optional(),
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
  /** A move between board columns, by their names as they were then, beside `changes` so an app that knows no columns reads the entry still. */
  column: z.object({ before: z.string().nullable(), after: z.string().nullable() }).optional(),
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
    /** A column of the task's project board: the task takes it, and its stage as its status. */
    columnId: id.optional(),
  })
  .strict();
export type OnlineTaskPatch = z.infer<typeof OnlineTaskPatch>;
export const OnlineTaskCreate = OnlineTaskPatch.omit({ status: true, columnId: true })
  .extend({
    requestId: z.uuid(),
    projectId: id,
    title: z.string().trim().min(1).max(200),
    spec: z.string().max(200_000).optional(),
    source: z.discriminatedUnion("kind", [z.object({ kind: z.literal("thread"), threadId: id }).strict(), z.object({ kind: z.literal("private") }).strict()]).optional(),
  })
  .strict();
/**
 * A change. `runHere` asks for the column's agent on the person's own computer when the task has nobody to run it, and
 * assigns them. `by: "agent"` marks one an agent made on this computer, so the server counts its moves between columns
 * toward the hold, as it does a cloud agent's.
 */
export const OnlineTaskUpdate = z.object({ requestId: z.uuid(), ifRevision: revision, patch: OnlineTaskPatch, runHere: z.literal(true).optional(), by: z.literal("agent").optional() }).strict();
/** A whole board saved from the revision it was read at. */
export const OnlineBoardUpdate = z.object({ requestId: z.uuid(), ifRevision: revision, columns: BoardColumnsSave }).strict();
export const OnlineTaskDelete = z.object({ requestId: z.uuid(), ifRevision: revision }).strict();
export const OnlineTaskSeen = z.object({ requestId: z.uuid(), assignmentRevision: revision }).strict();
export const OnlineTaskList = z
  .object({ projectId: id.optional(), status: TaskStatus.optional(), assignee: z.literal("me").optional(), cursor: z.string().optional(), limit: z.number().int().min(1).max(200).optional() })
  .strict();
export type OnlineTaskCreation = ({ state: "saved" } & OnlineTaskEnvelope) | { state: "refused"; code: string; message: string };
export type OnlineTaskMutation = ({ state: "saved" } | { state: "conflict" }) & OnlineTaskEnvelope;
/**
 * `execution`: the server opens task threads. `board`: it keeps a board of columns for each project. `runs`: its
 * columns' agents run on the assignee's computer. `computer`: a task's thread can open on a person's own computer.
 */
export type OnlineTaskAvailability =
  | { state: "unavailable" }
  | {
      state: "ready";
      accountId: string;
      spaceId: string;
      execution: boolean;
      board: boolean;
      runs: boolean;
      /** Whether its columns' agents can run on OpenOrc Cloud, or why not. */
      runsCloud: { available: boolean; reason: string | null };
      computer: boolean;
      personal: boolean;
    };
/**
 * A project's shared board: its columns in order, none when it keeps the statuses, and the revision a save names.
 * `mayEdit`: the asking person may change its columns, which only an organization admin may. A server that does not
 * say lets nobody, so the app never offers a change it would refuse.
 */
export const OnlineBoard = z.object({ revision, columns: z.array(BoardColumn), mayEdit: z.boolean().default(false) });
export type OnlineBoard = z.infer<typeof OnlineBoard>;
/** A save from an older revision changes nothing and answers the board as it now is. */
export const OnlineBoardSave = OnlineBoard.extend({ state: z.enum(["saved", "conflict"]) });
export type OnlineBoardSave = z.infer<typeof OnlineBoardSave>;
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
  "tasks.online.board": z.object({ ...scope, projectId: id }).strict(),
  /** Several projects' shared boards at once, for the board of all of an organization's projects. */
  "tasks.online.boards": z.object({ ...scope, projectIds: z.array(id).max(200) }).strict(),
  "tasks.online.saveBoard": OnlineBoardUpdate.extend({ ...scope, projectId: id }).strict(),
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
  "tasks.online.board": OnlineBoard;
  "tasks.online.boards": (OnlineBoard & { projectId: string })[];
  "tasks.online.saveBoard": OnlineBoardSave;
}
