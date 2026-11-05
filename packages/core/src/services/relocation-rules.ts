import { orclings, retiredTeams, tasks, type Db } from "@openorc/db";
import { isDetachedCopy, isSubagentThread, WORKSPACE_ID, type Thread } from "@openorc/protocol";

/** Why a thread cannot move between the Mac and the cloud brain now, or null. Shown on demand on the disabled choice. */
export function relocationRefusal(db: Db, thread: Thread): string | null {
  if (thread.projectId === WORKSPACE_ID) return "Only a project's conversations can move.";
  if (isSubagentThread(thread)) return "Move the conversation that started this subagent.";
  if (thread.agent !== "claude") return "Only Claude conversations can move between your Mac and the cloud so far.";
  if (retiredTeams.isHidden(db, thread.id)) return "This conversation is no longer available.";
  if (thread.orclingId || orclings.forThread(db, thread.id)) return "An Orcling's conversation stays where it is.";
  if (tasks.list(db, { threadId: thread.id }).some((task) => task.status !== "archived")) return "Conversations with tasks can't move yet.";
  if (isDetachedCopy(thread)) return "A pull request's review copy stays on this Mac.";
  return null;
}

export const AT_WORK = "Its agent is at work. Stop the turn, then move it.";
