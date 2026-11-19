import { z } from "zod";
import { PermissionPreset, RunMode } from "./domain.js";
import { AgentKind } from "./events.js";

/**
 * A change to a thread: its title and what its next turns run with, and the reader's own read, pin, resolve and snooze.
 * On OpenOrc Cloud the settings are the thread's, for everyone in it.
 */
export const ThreadUpdateParams = z.object({
  id: z.string(),
  /** Through a surviving task of a deleted conversation, only mode, permissions and the draft can change. */
  patch: z.object({
    executionTarget: z.never().optional(),
    title: z.string().optional(),
    mode: RunMode.optional(),
    permissionMode: PermissionPreset.optional(),
    model: z.string().nullable().optional(),
    effort: z.string().nullable().optional(),
    fastMode: z.boolean().optional(),
    agent: AgentKind.optional(),
    archived: z.boolean().optional(),
    pinned: z.boolean().optional(),
    done: z.boolean().optional(),
    /** Epoch milliseconds as a safe integer (zod's int): SQLite stores larger ones that node:sqlite then cannot read back. */
    snoozedUntil: z.number().int().nonnegative().nullable().optional(),
    /** True marks the thread read; false marks it unread. */
    seen: z.boolean().optional(),
    draft: z.string().nullable().optional(),
    prUrl: z.string().nullable().optional(),
    /** On OpenOrc Cloud, which of the person's accounts the next turns run on; null, their default. */
    cloudAccountId: z.string().min(1).max(200).nullable().optional(),
  }),
});
