import { z } from "zod";
import { HOSTED_AGENTS } from "./account.js";
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

/** The model a task's new thread is made with: the one a new cloud thread's composer starts with. Ignored once the task has its thread. */
export const OnlineTaskThreadSettings = z.object({ agent: z.enum(HOSTED_AGENTS), model: z.string().trim().min(1).max(200), effort: z.string().trim().min(1).max(40).nullable() }).strict();
export type OnlineTaskThreadSettings = z.infer<typeof OnlineTaskThreadSettings>;

export const onlineTaskExecutionRpcParams = {
  "tasks.online.openThread": OnlineTaskOpen.extend({ spaceId: SpaceId, id: z.string().min(1), settings: OnlineTaskThreadSettings.optional() }).strict(),
};
export type OnlineTaskExecutionParams = z.infer<(typeof onlineTaskExecutionRpcParams)["tasks.online.openThread"]>;
export interface OnlineTaskExecutionRpcResults {
  "tasks.online.openThread": OnlineTaskPreparation;
}
