import { SubagentStatus } from "@openorc/protocol";
import { z } from "zod";
import type { Route, WireThread } from "./wire.js";

export const wireNativeChild = z.object({
  id: z.string(),
  rootId: z.string(),
  parentId: z.string(),
  relation: z.literal("subagent"),
  agent: z.enum(["claude", "codex", "opencode"]),
  title: z.string(),
  status: SubagentStatus,
  agentType: z.string().nullable(),
  toolCallId: z.string().nullable(),
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime().nullable(),
  stoppable: z.boolean(),
  hostRunId: z.string().nullable(),
});
export type WireNativeChild = z.infer<typeof wireNativeChild>;
export const nativeRowFields = { nativeChild: wireNativeChild.optional(), nativeReadFailed: z.boolean().optional(), nativeListKey: z.string().optional() };
export type NativeThread = WireThread & { nativeChild?: WireNativeChild; nativeReadFailed?: boolean; nativeListKey?: string };

/**
 * A row an agent started under another (a native helper), read through its family's helper list. A person's own
 * subthread (relation "started") is a thread of its own. A server from before person subthreads names no relation, and
 * every row it lists under another is a helper.
 */
export const isNativeHelper = (row: Pick<WireThread, "parentId" | "relation">): boolean => Boolean(row.parentId) && row.relation !== "started";

export const SUBTHREAD_ROUTES = {
  children: (id: string) =>
    ({ method: "GET", path: `/hosted/threads/${encodeURIComponent(id)}/subthreads`, reply: z.object({ children: z.array(wireNativeChild) }) }) satisfies Route<{ children: WireNativeChild[] }>,
  stop: (id: string) => ({ method: "POST", path: `/hosted/threads/${encodeURIComponent(id)}/subagent/stop`, reply: null }) satisfies Route<null>,
};
