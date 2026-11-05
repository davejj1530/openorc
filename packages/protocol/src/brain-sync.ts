import { z } from "zod";
import { Memory, Task } from "./domain.js";
import { HarnessId } from "./harness.js";

// Lazy: domain.ts reaches this module through rpc.ts before its own schemas are made.
const MemoryTombstone = z.object({ id: z.string().min(1).max(200), removedAt: z.number().int().nonnegative() }).strict();

/** A project memory one side removed: the other drops it and never takes it back. */
export type MemoryTombstone = z.infer<typeof MemoryTombstone>;

const MemoryChoice = z
  .object({
    enabled: z.boolean(),
    provider: z.enum(["auto", ...HarnessId.options, "apikey", "off"]),
    /** The model chosen for each provider that has one. */
    models: z.partialRecord(HarnessId, z.string().min(1).max(200)),
  })
  .strict();

/** How the Mac's memory distils runs, which its cloud brain follows. Its Anthropic API key goes sealed, apart. */
export type MemoryChoice = z.infer<typeof MemoryChoice>;

/** Which model names conversations and writes their background text: the Mac's, which its cloud brain follows. */
export const TextGenerationChoice = z
  .object({
    provider: z.enum(["auto", ...HarnessId.options, "off"]),
    /** The model chosen for each provider that has one. */
    models: z.partialRecord(HarnessId, z.string().min(1).max(200)),
  })
  .strict();
export type TextGenerationChoice = z.infer<typeof TextGenerationChoice>;

/** One project's memory as one side changed it since a point on its own clock. */
export interface MemoryExchangeProject {
  /** The brain's project: its copy of the Mac's. */
  projectId: string;
  /** Where the side's next read starts, on its own clock. */
  next: number;
  rows: Memory[];
  removed: MemoryTombstone[];
}

/** The Mac's open tasks as its cloud brain last heard them; never edited there. */
export interface MacBacklog {
  at: number;
  tasks: Task[];
}

/**
 * Asked by a Mac of its own cloud brain over its owner session, never by a phone, and refused by a Mac: what the two keep
 * of each other's work while both are awake. Neither wakes the brain nor counts as using it.
 */
export const brainSyncRpcParams = {
  /**
   * The Mac's changes to each project's memory since it last sent, and its memory choices, which the brain's follows.
   * The brain takes them and answers its own changes since `since`, with any of its rows that beat the Mac's.
   */
  "brain.memory.exchange": MemoryChoice.extend({
    projects: z
      .array(
        z
          .object({ projectId: z.string().min(1).max(200), since: z.number().int().nonnegative(), rows: z.array(z.lazy(() => Memory)).max(10_000), removed: z.array(MemoryTombstone).max(100_000) })
          .strict(),
      )
      .max(1000),
  }).strict(),
  /** The Mac's open tasks of the projects the brain has, on the brain's projects, as of `at`. */
  "brain.backlog": z.object({ at: z.number().int().nonnegative(), tasks: z.array(z.lazy(() => Task)).max(10_000) }).strict(),
  /** The Mac's text generation choice, which the brain's follows. */
  "brain.textGeneration": TextGenerationChoice,
};

export interface BrainSyncRpcResults {
  "brain.memory.exchange": { projects: MemoryExchangeProject[] };
  "brain.backlog": null;
  "brain.textGeneration": null;
}
