import { z } from "zod";
import { ThreadFilter } from "./domain.js";
import { SpaceId } from "./spaces.js";

export const THREAD_CHILD_PAGE = 5;

export const ThreadListParams = z.object({
  spaceId: SpaceId.optional(),
  ownership: z.enum(["mine", "everyone"]).optional(),
  projectId: z.string().optional(),
  projectIds: z.array(z.string()).optional(),
  projectsOnly: z.boolean().optional(),
  filter: ThreadFilter.optional(),
  /** Most recent activity across projects, without pin priority. */
  orderBy: z.literal("activity").optional(),
  pinnedOnly: z.boolean().optional(),
  /** Only threads that need you: unread, waiting on you, or with an agent on them. Older hosts ignore it and list them all. */
  needsYou: z.boolean().optional(),
  /** Conversations that accept messages, excluding native subagents, before pagination. */
  excludeSubagents: z.boolean().optional(),
  /** Page roots and each parent's children, retaining active paths and work needing attention. */
  includeChildren: z.boolean().optional(),
  selectedId: z.string().optional(),
  childLimits: z.record(z.string(), z.number().int().min(THREAD_CHILD_PAGE)).optional(),
  /** Only threads on this Claude account, before pagination; a thread with none is the existing CLI login's. */
  claudeAccountId: z.string().optional(),
  limit: z.number().int().positive().optional(),
  offset: z.number().int().nonnegative().optional(),
});
