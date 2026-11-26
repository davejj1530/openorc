import { z } from "zod";
import { HOSTED_AGENTS } from "./account.js";
import { PermissionPreset, RunMode } from "./domain.js";
import { OnlineTaskDelete, OnlineTaskEnvelope, OnlineTaskRef } from "./online-tasks.js";
import { SpaceId } from "./spaces.js";

/** Free preparation returns the document revision to carry on the ordinary send. */
export const OnlineTaskThread = OnlineTaskEnvelope.extend({ threadId: z.string().min(1), created: z.boolean(), draft: z.string() });
export type OnlineTaskThread = z.infer<typeof OnlineTaskThread>;
export const OnlineTaskOpen = OnlineTaskDelete;
export type OnlineTaskOpen = z.infer<typeof OnlineTaskOpen>;
export type OnlineTaskPreparation = ({ state: "ready" } & OnlineTaskThread) | ({ state: "conflict" } & z.infer<typeof OnlineTaskEnvelope>);
export const OnlineTaskSendContext = z.object({ id: z.string().min(1).max(128), ifRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) }).strict();
export type OnlineTaskSendContext = z.infer<typeof OnlineTaskSendContext>;
/** Routing inside opaque tool-result JSON; it is never a legacy Task or phone event field. */
export const OnlineTaskToolReference = OnlineTaskRef.omit({ kind: true, accountId: true })
  .extend({ place: z.literal("server") })
  .strict();
export type OnlineTaskToolReference = z.infer<typeof OnlineTaskToolReference>;
export const OnlineTaskThreadDraft = z
  .object({
    reference: OnlineTaskRef,
    threadId: z.string().min(1),
    ifRevision: OnlineTaskSendContext.shape.ifRevision,
    prompt: z.string(),
    inserted: z.boolean(),
    requestId: z.uuid(),
  })
  .strict();
export type OnlineTaskThreadDraft = z.infer<typeof OnlineTaskThreadDraft>;

/**
 * The settings a task's new thread is made with: the ones a new cloud thread's composer starts with, the person's own
 * permission among them. Ignored once the task has its thread.
 */
export const OnlineTaskThreadSettings = z
  .object({ agent: z.enum(HOSTED_AGENTS), model: z.string().trim().min(1).max(200), effort: z.string().trim().min(1).max(40).nullable(), mode: RunMode, permissionMode: PermissionPreset })
  .strict();
export type OnlineTaskThreadSettings = z.infer<typeof OnlineTaskThreadSettings>;
/** What Open thread sends: the revision the person saw, and the settings a new thread starts with. */
export const OnlineTaskOpenThread = OnlineTaskOpen.extend({ settings: OnlineTaskThreadSettings.optional() }).strict();

export const onlineTaskExecutionRpcParams = {
  "tasks.online.openThread": OnlineTaskOpenThread.extend({ spaceId: SpaceId, id: z.string().min(1) }).strict(),
  /** The task's thread on this computer, in its project's folder here: the one it has, else a new one ready to send. */
  "tasks.online.openHere": z.object({ spaceId: SpaceId, id: z.string().min(1) }).strict(),
};
export type OnlineTaskExecutionParams = z.infer<(typeof onlineTaskExecutionRpcParams)["tasks.online.openThread"]>;
export interface OnlineTaskExecutionRpcResults {
  "tasks.online.openThread": OnlineTaskPreparation;
  "tasks.online.openHere": { threadId: string };
}
