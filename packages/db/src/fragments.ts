import type { AgentEvent } from "@openorc/protocol";

/** What the rules below need to know about one stored row. */
export interface RowFacts {
  kind: string;
  /** The message, tool call or activity the row belongs to. */
  item: string | undefined;
  /** Whether a finishing row carries the content replay takes from it: thinking text, tool output, activity text. */
  content: boolean;
  /** Whether an activity update carries nothing but its label, status and text, so a later update loses nothing by replacing it. */
  plain: boolean;
}

/** The kinds the rules below read; every other row is left alone. */
export const STREAMED_KINDS = [
  "message.delta",
  "message.completed",
  "thinking.delta",
  "thinking.completed",
  "tool.output.delta",
  "tool.completed",
  "activity.delta",
  "activity.updated",
] as const satisfies readonly AgentEvent["type"][];

export function factsOf(ev: AgentEvent): RowFacts {
  switch (ev.type) {
    case "message.delta":
    case "message.completed":
    case "thinking.delta":
      return { kind: ev.type, item: ev.messageId, content: true, plain: true };
    case "thinking.completed":
      return { kind: ev.type, item: ev.messageId, content: Boolean(ev.text), plain: true };
    case "tool.output.delta":
      return { kind: ev.type, item: ev.toolCallId, content: true, plain: true };
    case "tool.completed":
      return { kind: ev.type, item: ev.toolCallId, content: ev.output !== undefined && ev.output !== null, plain: true };
    case "activity.delta":
      return { kind: ev.type, item: ev.activityId, content: true, plain: true };
    case "activity.updated":
      return {
        kind: ev.type,
        item: ev.activityId,
        content: ev.text !== undefined,
        plain: ev.detail === undefined && ev.activityKind === undefined && ev.recovery === undefined && ev.imagePath === undefined,
      };
    default:
      return { kind: ev.type, item: undefined, content: false, plain: false };
  }
}

/**
 * Where each streamed item's rows go. Replay builds a message, thinking block, tool output or activity from its
 * streamed rows only until a row arrives whose content replaces theirs; the rows before it are then redundant.
 */
function stream(facts: RowFacts): { key: string; replaceable: boolean; replaces: boolean; final: boolean } | null {
  const row = (item: string, replaceable: boolean, replaces: boolean, final = false) => ({ key: `${item}\0${facts.item}`, replaceable, replaces, final });
  switch (facts.kind) {
    case "message.delta":
      return row("message", true, false);
    case "message.completed":
      return row("message", false, true, true);
    case "thinking.delta":
      return row("thinking", true, false);
    case "thinking.completed":
      return row("thinking", false, facts.content, true);
    case "tool.output.delta":
      return row("tool", true, false);
    case "tool.completed":
      return row("tool", false, facts.content, true);
    case "activity.delta":
      return row("activity", true, false);
    case "activity.updated":
      // Each update of a running activity, such as a turn's diff, can carry its full text again.
      return row("activity", facts.plain, facts.content);
    default:
      return null;
  }
}

/**
 * Tracks one ledger's streamed rows and names the ones a later row makes redundant. An item's first row always
 * stays: a transcript places each item where its first row is, and an item's time is that row's.
 */
export class FragmentTracker {
  private readonly items = new Map<string, { later: number[] }>();

  /** Records a row and returns the seqs of rows in the same run it makes redundant. */
  add(runId: string, seq: number, facts: RowFacts): number[] {
    const flow = facts.item === undefined ? null : stream(facts);
    if (!flow) return [];
    const key = `${runId}\0${flow.key}`;
    const item = this.items.get(key);
    const redundant = item && flow.replaces ? item.later.splice(0) : [];
    if (flow.final) this.items.delete(key);
    else if (!item) this.items.set(key, { later: [] });
    else if (flow.replaceable) item.later.push(seq);
    return redundant;
  }

  /** Forgets a run's open items once its session ends; finished messages, thinking and tools are forgotten as they finish. */
  endRun(runId: string): void {
    for (const key of this.items.keys()) if (key.startsWith(`${runId}\0`)) this.items.delete(key);
  }
}
