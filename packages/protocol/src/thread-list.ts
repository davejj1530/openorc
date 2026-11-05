import { z } from "zod";
import { ThreadFilter } from "./domain.js";

export const THREAD_CHILD_PAGE = 5;

export const ThreadListParams = z.object({
  projectId: z.string().optional(),
  projectIds: z.array(z.string()).optional(),
  projectsOnly: z.boolean().optional(),
  filter: ThreadFilter.optional(),
  /** Most recent activity across projects, without pin priority. */
  orderBy: z.literal("activity").optional(),
  pinnedOnly: z.boolean().optional(),
  /** Conversations that accept messages, excluding native subagents, before pagination. */
  excludeSubagents: z.boolean().optional(),
  /** Page roots and each parent's children, retaining active paths and work needing attention. */
  includeChildren: z.boolean().optional(),
  selectedId: z.string().optional(),
  childLimits: z.record(z.string(), z.number().int().min(THREAD_CHILD_PAGE)).optional(),
  limit: z.number().int().positive().optional(),
  offset: z.number().int().nonnegative().optional(),
});
