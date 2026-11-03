import { z } from "zod";
import { ThreadFilter } from "./domain.js";

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
  /** Page parent rows and include each selected parent's full tree. */
  includeChildren: z.boolean().optional(),
  selectedId: z.string().optional(),
  limit: z.number().int().positive().optional(),
  offset: z.number().int().nonnegative().optional(),
});
