import {
  OnlineBoard,
  OnlineBoardSave,
  OnlineTask,
  OnlineTaskActivity,
  OnlineTaskAttention,
  OnlineTaskContext,
  OnlineTaskEnvelope,
  OnlineTaskHistory,
  OnlineTaskHistoryEntry,
  OnlineTaskPage,
  OnlineTaskReport,
  OnlineTaskRoster,
  type OnlineTaskParams,
} from "@openorc/protocol";
import { z } from "zod";
import type { Route } from "./wire.js";

const date = z.iso.datetime().transform((value) => Date.parse(value));
export const wireOnlineTask = OnlineTask.extend({ createdAt: date, updatedAt: date, completedAt: date.nullable(), activity: OnlineTaskActivity.extend({ updatedAt: date }).nullable() });
export const wireTaskEnvelope = OnlineTaskEnvelope.extend({ task: wireOnlineTask });
const page = OnlineTaskPage.extend({ tasks: z.array(wireOnlineTask) });
/** A time the server may send as a number or as a date. */
const when = z.union([z.number(), date]);
const wireReport = OnlineTaskReport.extend({ at: when, answer: OnlineTaskReport.shape.answer.unwrap().extend({ at: when }).nullable() });
const history = OnlineTaskHistory.extend({ entries: z.array(OnlineTaskHistoryEntry.extend({ at: date })) });
const context = OnlineTaskContext.extend({ task: wireOnlineTask });
const path = (id: string) => `/tasks/${encodeURIComponent(id)}`;
const board = (projectId: string) => `/projects/${encodeURIComponent(projectId)}/board`;
const query = (values: object): string => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value !== undefined) params.set(key, String(value));
  return params.size ? `?${params}` : "";
};
const get = <T>(path: string, reply: z.ZodType<T>): Route<T> => ({ method: "GET", path, reply });
export const TASK_ROUTES = {
  list: (input: Omit<OnlineTaskParams<"tasks.online.list">, "spaceId">) => get(`/tasks${query(input)}`, page),
  get: (id: string) => get(path(id), wireTaskEnvelope),
  create: { method: "POST", path: "/tasks", reply: wireTaskEnvelope } satisfies Route<z.infer<typeof wireTaskEnvelope>>,
  update: (id: string): Route<z.infer<typeof wireTaskEnvelope>> => ({ method: "PATCH", path: path(id), reply: wireTaskEnvelope }),
  delete: (id: string): Route<null> => ({ method: "DELETE", path: path(id), reply: null }),
  seen: (id: string): Route<z.infer<typeof wireTaskEnvelope>> => ({ method: "POST", path: `${path(id)}/seen`, reply: wireTaskEnvelope }),
  attention: get("/tasks/attention", OnlineTaskAttention),
  assignees: (input: Omit<OnlineTaskParams<"tasks.online.assignees">, "spaceId">) => get(`/tasks/assignees${query(input)}`, OnlineTaskRoster),
  activity: (id: string, input: { cursor?: string; limit?: number }) => get(`${path(id)}/activity${query(input)}`, history),
  context: (id: string) => get(`${path(id)}/context`, context),
  board: (projectId: string) => get(board(projectId), OnlineBoard),
  saveBoard: (projectId: string): Route<OnlineBoardSave> => ({ method: "PUT", path: board(projectId), reply: OnlineBoardSave }),
  computer: (id: string, method: "POST" | "DELETE"): Route<z.infer<typeof wireTaskEnvelope>> => ({ method, path: `${path(id)}/computer`, reply: wireTaskEnvelope }),
  reports: (id: string) => get(`${path(id)}/reports`, z.array(wireReport)),
  postReport: (id: string): Route<z.infer<typeof wireReport>> => ({ method: "POST", path: `${path(id)}/reports`, reply: wireReport }),
  answer: (id: string, reportId: string): Route<z.infer<typeof wireReport>> => ({ method: "POST", path: `${path(id)}/reports/${encodeURIComponent(reportId)}/answer`, reply: wireReport }),
};
