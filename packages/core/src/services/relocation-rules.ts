import { orclings, retiredTeams, taskTies, threadTaskIds, type Db } from "@openorc/db";
import { slotFor } from "@openorc/agents";
import { isDetachedCopy, isSubagentThread, WORKSPACE_ID, type Thread } from "@openorc/protocol";

/** Why a thread's tasks keep it where it is. Its tasks move with it otherwise. */
const TASK_TIES = {
  runs: "One of its tasks was worked on outside this conversation, so it can't move.",
  folder: "One of its tasks has a folder of its own, so it can't move.",
} as const;

/** Why a thread cannot move between the Mac and the cloud brain now, or null. Shown on demand on the disabled choice. */
export function relocationRefusal(db: Db, thread: Thread): string | null {
  if (thread.projectId === WORKSPACE_ID) return "Only a project's conversations can move.";
  if (isSubagentThread(thread)) return "Move the conversation that started this subagent.";
  const slot = slotFor(thread.agent);
  if (!slot || slot.stays) return slot?.stays ?? "This agent's conversations stay where they started.";
  if (retiredTeams.isHidden(db, thread.id)) return "This conversation is no longer available.";
  if (thread.orclingId || orclings.forThread(db, thread.id)) return "An Orcling's conversation stays where it is.";
  if (threadTaskIds(db, thread.id).some((id) => retiredTeams.hasTask(db, id))) return "This conversation is no longer available.";
  const tied = taskTies(db, thread.id);
  if (tied) return TASK_TIES[tied];
  if (isDetachedCopy(thread)) return "A pull request's review copy stays on this Mac.";
  return null;
}

export const AT_WORK = "Its agent is at work. Stop the turn, then move it.";
