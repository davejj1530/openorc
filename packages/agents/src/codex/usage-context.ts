import type { AgentEvent } from "@openorc/protocol";

/** Freeze pricing settings on each report so later model and speed changes do not reprice earlier tokens. */
export function codexUsageContext(event: AgentEvent, model: string | undefined, fastMode: boolean): AgentEvent {
  if (event.type !== "usage.updated" || event.subagentId) return event;
  return { ...event, usage: { ...event.usage, ...(model ? { model } : {}), fastMode } };
}
