import { z } from "zod";
import type { HarnessId } from "./harness.js";

/** Day edges come from the viewer's calendar, so a day is theirs, daylight-saving changes included. A year and a week at most. */
export const ProjectActivityParams = z
  .object({
    id: z.string().min(1),
    boundaries: z.array(z.number().int().nonnegative()).min(2).max(380),
  })
  .strict()
  .refine(({ boundaries }) => boundaries.every((value, index) => index === 0 || value > boundaries[index - 1]!), "Activity days must increase.");

/**
 * One day of a project's conversations: the turns its agents finished, the threads they were in, each agent's share,
 * and the steps (tool calls) its agents and their subagents took.
 */
export interface ProjectActivityDay {
  turns: number;
  steps: number;
  threads: number;
  agents: { agent: HarnessId; turns: number }[];
}

/** One entry per day between the boundaries, oldest first. */
export interface ProjectActivity {
  days: ProjectActivityDay[];
}
