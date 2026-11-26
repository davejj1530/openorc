import type { AgentEvent } from "./events.js";

/** Declared per session, before interests/RPCs. An absent declaration means an installed legacy phone. */
export const PHONE_CAPABILITIES = [
  "subagent-threads",
  "reply-images",
  "skill-lists",
  "orclings",
  "task-details",
  "subthread-starts",
  "orcling-edits",
  "cloud-threads",
  "cloud-session",
  "thread-files",
  "commit-reads",
  "task-work",
  "look-backdrop",
  "board-columns",
] as const;
export const supportsSubagents = (capabilities: readonly string[] = []): boolean => capabilities.includes("subagent-threads");
/** The Mac answers `session.negotiate` with the capabilities it shares; an older Mac's link refuses a reply image. */
export const supportsReplyImages = (capabilities: readonly string[] = []): boolean => capabilities.includes("reply-images");
/** A Mac that shares it answers `skills.list` for a phone; an older Mac refuses the method. */
export const supportsSkillLists = (capabilities: readonly string[] = []): boolean => capabilities.includes("skill-lists");
/** A Mac that shares it lists Orclings for a phone and takes its tapbacks; an older Mac refuses `orclings.*`. */
export const supportsOrclings = (capabilities: readonly string[] = []): boolean => capabilities.includes("orclings");
/** A Mac that shares it opens, saves and edits a phone's tasks; an older Mac refuses `tasks.get`, `tasks.create` and `tasks.update`. */
export const supportsTaskDetails = (capabilities: readonly string[] = []): boolean => capabilities.includes("task-details");
/** A Mac that shares it starts a phone's thread under another; an older one refuses `threads.start` with `parentThreadId`. */
export const supportsSubthreadStarts = (capabilities: readonly string[] = []): boolean => capabilities.includes("subthread-starts");
/** A Mac that shares it makes, changes and deletes Orclings for a phone; an older Mac refuses `orclings.create`, `orclings.update`, `orclings.delete` and `orclings.instructions.save`. */
export const supportsOrclingEdits = (capabilities: readonly string[] = []): boolean => capabilities.includes("orcling-edits");
/** A phone that declares it reads what the desktop draws behind New thread from the look; an older phone's look comes without it. */
export const supportsLookBackdrop = (capabilities: readonly string[] = []): boolean => capabilities.includes("look-backdrop");
/** A Mac that shares it lists a task's threads, runs its buttons and refines it for a phone; an older Mac refuses `tasks.threads`, `tasks.runButton` and `tasks.refine.*`. */
export const TASK_WORK = "task-work";
export const supportsTaskWork = (capabilities: readonly string[] = []): boolean => capabilities.includes(TASK_WORK);
/** A Mac that shares it lists a project's board columns for a phone and puts a phone's task in one; an older Mac refuses `board.columns`, and `tasks.update` with `columnId`. */
export const BOARD_COLUMNS = "board-columns";
export const supportsBoardColumns = (capabilities: readonly string[] = []): boolean => capabilities.includes(BOARD_COLUMNS);
/** A Mac that shares it finds the commit an id names and reads one commit's changes for a phone; an older Mac refuses `git.threadCommit`, `review.threadCommitChanges` and `review.threadCommitFileDiff`. */
export const COMMIT_READS = "commit-reads";
export const supportsCommitReads = (capabilities: readonly string[] = []): boolean => capabilities.includes(COMMIT_READS);

/**
 * Frozen at the installed builds, App Store 1.0.0 (202610270002, 85bf1c5e) and TestFlight 202610270003, whose
 * transcripts dispatch these same handlers. Their dispatch throws for any other event type.
 * Never derive this from AgentEvent or extend it when adding events: installed binaries cannot learn new handlers.
 */
export const LEGACY_PHONE_EVENT_TYPES = [
  "plan.updated",
  "session.started",
  "message.delta",
  "message.completed",
  "thinking.started",
  "thinking.completed",
  "activity.updated",
  "activity.delta",
  "tool.output.delta",
  "tool.updated",
  "thinking.delta",
  "tool.started",
  "tool.completed",
  "file.changed",
  "approval.requested",
  "approval.resolved",
  "usage.updated",
  "context.updated",
  "turn.started",
  "turn.completed",
  "background.updated",
  "session.completed",
  "error",
  "raw",
] as const;
const legacyEvents: ReadonlySet<string> = new Set(LEGACY_PHONE_EVENT_TYPES);
const isLegacyEvent = (event: AgentEvent): event is Extract<AgentEvent, { type: (typeof LEGACY_PHONE_EVENT_TYPES)[number] }> => legacyEvents.has(event.type);

/** The same gate for live frames and saved history. Routing tags are not part of the legacy event contract. */
export function phoneEvents(events: AgentEvent[], capabilities: readonly string[] = []): AgentEvent[] {
  if (supportsSubagents(capabilities)) return events;
  return events.flatMap((event) => {
    if (!isLegacyEvent(event)) return [];
    const { subagentId: _subagentId, ...legacy } = event;
    return [legacy];
  });
}
