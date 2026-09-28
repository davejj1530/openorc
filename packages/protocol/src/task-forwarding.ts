import { z } from "zod";
import { WorkspaceMode } from "./domain.js";
import { TeamTreeCapture } from "./team-workspaces.js";

/** The original team task remains history; the destination owns future execution. */
export const TaskForwarding = z.object({
  sourceTaskId: z.string(),
  targetTaskId: z.string(),
  sourceThreadId: z.string(),
  workspaceMode: WorkspaceMode,
  state: z.enum(["preparing", "ready"]),
  context: z.string(),
  snapshot: TeamTreeCapture.nullable(),
  baseSha: z.string().nullable(),
  stagingPath: z.string().nullable(),
  previewId: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.number(),
});
export type TaskForwarding = z.infer<typeof TaskForwarding>;
export interface TaskForwardingState {
  allowed: boolean;
  reason: string | null;
  workspaceMode: z.infer<typeof WorkspaceMode>;
  forwarding: TaskForwarding | null;
}
