import type { AgentEvent } from "./events.js";

/** Declared per session, before interests/RPCs. An absent declaration means an installed legacy phone. */
export const PHONE_CAPABILITIES = ["subagent-threads", "reply-images"] as const;
export const supportsSubagents = (capabilities: readonly string[] = []): boolean => capabilities.includes("subagent-threads");
/** The Mac answers `session.negotiate` with the capabilities it shares; an older Mac's link refuses a reply image. */
export const supportsReplyImages = (capabilities: readonly string[] = []): boolean => capabilities.includes("reply-images");

/**
 * Frozen at phone build 202610270003 (aa4d5cfa). Its transcript dispatch throws for any other event type.
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
