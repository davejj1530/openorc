import { z } from "zod";
import { OnlineTaskDelete, OnlineTaskEnvelope } from "./online-tasks.js";
import { SpaceId } from "./spaces.js";

/** Free preparation returns the document revision to carry on the ordinary send. */
export const OnlineTaskThread = OnlineTaskEnvelope.extend({ threadId: z.string().min(1), created: z.boolean(), draft: z.string() });
export type OnlineTaskThread = z.infer<typeof OnlineTaskThread>;
export const OnlineTaskOpen = OnlineTaskDelete;
export type OnlineTaskOpen = z.infer<typeof OnlineTaskOpen>;
export type OnlineTaskPreparation = ({ state: "ready" } & OnlineTaskThread) | ({ state: "conflict" } & z.infer<typeof OnlineTaskEnvelope>);
export const OnlineTaskSendContext = z.object({ id: z.string().min(1), ifRevision: z.number().int().nonnegative() }).strict();
export type OnlineTaskSendContext = z.infer<typeof OnlineTaskSendContext>;

export const onlineTaskExecutionRpcParams = {
  "tasks.online.openThread": OnlineTaskOpen.extend({ spaceId: SpaceId, id: z.string().min(1) }).strict(),
};
export type OnlineTaskExecutionParams = z.infer<(typeof onlineTaskExecutionRpcParams)["tasks.online.openThread"]>;
export interface OnlineTaskExecutionRpcResults {
  "tasks.online.openThread": OnlineTaskPreparation;
}
