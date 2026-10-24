import { OMIT_OUTPUT_CHARS, pagedEvent, redactValue } from "@openorc/db";
import type { AgentEvent, Frame } from "@openorc/protocol";

type DeltaEvent = Extract<AgentEvent, { type: "message.delta" | "thinking.delta" | "activity.delta" | "tool.output.delta" }>;

/** The item each kind of delta adds to; adjacent deltas of one item merge into one event. */
const deltaItem: { [T in DeltaEvent["type"]]: (event: Extract<DeltaEvent, { type: T }>) => string } = {
  "message.delta": (event) => event.messageId,
  "thinking.delta": (event) => event.messageId,
  "activity.delta": (event) => event.activityId,
  "tool.output.delta": (event) => event.toolCallId,
};

const isDelta = (event: AgentEvent): event is DeltaEvent => Object.hasOwn(deltaItem, event.type);
const endsRun = (event: AgentEvent) => event.type === "session.completed" || (event.type === "error" && event.fatal);
const itemOf = (event: DeltaEvent) => (deltaItem[event.type] as (event: DeltaEvent) => string)(event);

/** The merged event keeps the last one's id and time, so a transcript page that ends there still lines up. */
function mergeDeltas(events: readonly AgentEvent[]): AgentEvent[] {
  const merged: AgentEvent[] = [];
  for (const event of events) {
    const last = merged.at(-1);
    if (last && isDelta(last) && isDelta(event) && last.type === event.type && itemOf(last) === itemOf(event)) merged[merged.length - 1] = { ...event, text: last.text + event.text };
    else merged.push(event);
  }
  return merged;
}

export interface ShapedFrame {
  frame: Frame;
  /** Its JSON length, for a session's backpressure. */
  bytes: number;
}

/**
 * Turns a live frame into what a transcript page would hold for the same events: deltas merged, secrets redacted
 * with the ledger's rules, a large tool result left out as `outputOmitted`. Live tool output stops at the same
 * limit; the phone loads the whole output when the row opens, as it does from history. One shaper serves every
 * phone, so a frame is shaped once however many are listening.
 */
export class RemoteFrameShaper {
  private readonly shaped = new WeakMap<Frame, ShapedFrame>();
  /** Characters of live output streamed so far, per run and tool call. */
  private readonly streamed = new Map<string, Map<string, number>>();

  shape(frame: Frame): ShapedFrame {
    const cached = this.shaped.get(frame);
    if (cached) return cached;
    const events = mergeDeltas(frame.events).flatMap((event) => this.limit(redactValue(event).value));
    const result = { frame: { ...frame, events }, bytes: 0 };
    result.bytes = JSON.stringify(result.frame).length;
    this.shaped.set(frame, result);
    return result;
  }

  private limit(event: AgentEvent): AgentEvent[] {
    if (event.type === "tool.output.delta") {
      const run = this.streamed.get(event.runId) ?? new Map<string, number>();
      this.streamed.set(event.runId, run);
      const sent = run.get(event.toolCallId) ?? 0;
      if (sent >= OMIT_OUTPUT_CHARS) return [];
      const text = event.text.slice(0, OMIT_OUTPUT_CHARS - sent);
      run.set(event.toolCallId, sent + text.length);
      return [text === event.text ? event : { ...event, text }];
    }
    if (event.type === "tool.completed") this.streamed.get(event.runId)?.delete(event.toolCallId);
    if (endsRun(event)) this.streamed.delete(event.runId);
    return [pagedEvent(event)];
  }
}
