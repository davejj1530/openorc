import type { ApprovalDecision } from "@openorc/protocol";
import type { Clock } from "../connection/route-race";
import type { Draft } from "./drafts";

/** One beat of a scripted turn, played `after` ms after the beat before it. */
export type Beat =
  | { kind: "events"; after: number; events: Draft[] }
  /** The agent's words arriving a few at a time, then whole. */
  | { kind: "say"; after: number; messageId: string; text: string }
  /** A command whose output arrives line by line before it finishes. */
  | { kind: "output"; after: number; toolCallId: string; name: string; input: unknown; lines: string[] }
  /** Something the turn does to the demo Mac's world, such as a file it changed or a page it opened. */
  | { kind: "do"; after: number; run: () => void }
  /** The agent asks first; the turn goes on with what was decided. */
  | { kind: "ask"; after: number; approvalId: string; request: Draft; allowed: Beat[]; denied: Beat[] };

/** A turn to play: what the person said to start it, if anything, with the images they attached, and its beats. */
export interface Turn {
  ask: string | null;
  attachments?: string[];
  beats: Beat[];
}

/** What a player tells the demo Mac as its run moves. */
export interface PlayerHost {
  clock: Clock;
  emit(runId: string, events: Draft[]): void;
  /** The run started or finished a turn, or began or stopped waiting on the person. */
  moved(runId: string, state: "working" | "waiting" | "idle"): void;
}

type Tick = { after: number; events: Draft[]; run?: () => void; gate?: Extract<Beat, { kind: "ask" }>; streams?: { messageId: string; text: string } };

const WORDS_PER_DELTA = 3;
const DELTA_MS = 110;
const LINE_MS = 260;

/** The beats as ticks: words and output lines each their own, every tick naming its events. */
function ticks(beats: Beat[]): Tick[] {
  return beats.flatMap((beat): Tick[] => {
    switch (beat.kind) {
      case "events":
        return [{ after: beat.after, events: beat.events }];
      case "do":
        return [{ after: beat.after, events: [], run: beat.run }];
      case "ask":
        return [{ after: beat.after, events: [beat.request], gate: beat }];
      case "say":
        return sayTicks(beat);
      case "output":
        return outputTicks(beat);
    }
  });
}

function sayTicks({ after, messageId, text }: Extract<Beat, { kind: "say" }>): Tick[] {
  const words = text.split(/(?<=\s)/);
  const parts: string[] = [];
  for (let i = 0; i < words.length; i += WORDS_PER_DELTA) parts.push(words.slice(i, i + WORDS_PER_DELTA).join(""));
  let sent = "";
  const deltas = parts.map((part, index): Tick => {
    sent += part;
    return { after: index === 0 ? after : DELTA_MS, events: [{ type: "message.delta", messageId, role: "assistant", text: part }], streams: { messageId, text: sent } };
  });
  return [...deltas, { after: DELTA_MS, events: [{ type: "message.completed", messageId, role: "assistant", text }] }];
}

function outputTicks({ after, toolCallId, name, input, lines }: Extract<Beat, { kind: "output" }>): Tick[] {
  const output = lines.map((line) => `${line}\n`);
  return [
    { after, events: [{ type: "tool.started", toolCallId, name, input, parentToolCallId: null }] },
    ...output.map((text): Tick => ({ after: LINE_MS, events: [{ type: "tool.output.delta", toolCallId, text }] })),
    { after: LINE_MS, events: [{ type: "tool.completed", toolCallId, name, output: output.join(""), isError: false }] },
  ];
}

interface Playing {
  turnId: string;
  startedAt: number;
  ticks: Tick[];
  timer: unknown;
  gate: Extract<Beat, { kind: "ask" }> | null;
  /** The message whose words are still arriving, so a Stop can finish it with what came. */
  streaming: { messageId: string; text: string } | null;
}

/**
 * Plays a run's scripted turns, one at a time, as an agent's stream would arrive: work, words a few at a time, and an
 * approval the turn waits on. A turn asked for while one plays waits its turn; Stop ends the one playing.
 */
export class RunPlayer {
  private playing: Playing | null = null;
  private readonly waiting: Turn[] = [];
  private turns = 0;

  constructor(
    private readonly host: PlayerHost,
    readonly runId: string,
    /** Turns the run already finished, so new ones number after them. */
    finished: number,
  ) {
    this.turns = finished;
  }

  get busy(): boolean {
    return this.playing !== null;
  }

  play(turn: Turn): void {
    this.waiting.push(turn);
    if (!this.playing) this.startNext();
  }

  /** The person answered the approval the turn waits on; false when it waits on no such approval. */
  resolve(approvalId: string, decision: ApprovalDecision): boolean {
    const playing = this.playing;
    if (!playing?.gate || playing.gate.approvalId !== approvalId) return false;
    const gate = playing.gate;
    playing.gate = null;
    this.host.emit(this.runId, [{ type: "approval.resolved", approvalId, decision }]);
    this.host.moved(this.runId, "working");
    playing.ticks.unshift(...ticks(decision === "deny" ? gate.denied : gate.allowed));
    this.schedule(playing);
    return true;
  }

  /** Stop: the turn ends now with what it said so far, and the next one waiting starts. */
  interrupt(): void {
    const playing = this.playing;
    if (!playing) return;
    this.host.clock.clearTimeout(playing.timer);
    const events: Draft[] = [];
    if (playing.gate) events.push({ type: "approval.resolved", approvalId: playing.gate.approvalId, decision: "deny" });
    if (playing.streaming) events.push({ type: "message.completed", messageId: playing.streaming.messageId, role: "assistant", text: playing.streaming.text });
    this.end(playing, events, "cancelled");
  }

  /** Stops every timer, for a demo Mac going away. */
  stop(): void {
    if (this.playing) this.host.clock.clearTimeout(this.playing.timer);
    this.playing = null;
    this.waiting.length = 0;
  }

  private startNext(): void {
    const turn = this.waiting.shift();
    if (!turn) return this.host.moved(this.runId, "idle");
    const turnId = `turn-${++this.turns}`;
    const playing: Playing = { turnId, startedAt: this.host.clock.now(), ticks: ticks(turn.beats), timer: null, gate: null, streaming: null };
    this.playing = playing;
    const asked: Draft[] = turn.ask
      ? [{ type: "message.completed", messageId: `${this.runId}-${turnId}-ask`, role: "user", text: turn.ask, ...(turn.attachments?.length ? { attachments: turn.attachments } : {}) }]
      : [];
    this.host.emit(this.runId, [{ type: "turn.started", turnId }, ...asked]);
    this.host.moved(this.runId, "working");
    this.schedule(playing);
  }

  private schedule(playing: Playing): void {
    const tick = playing.ticks.shift();
    if (!tick) return this.end(playing, [], "success");
    playing.timer = this.host.clock.setTimeout(() => {
      if (this.playing !== playing) return;
      playing.streaming = tick.streams ?? null;
      if (tick.events.length) this.host.emit(this.runId, tick.events);
      tick.run?.();
      if (tick.gate) {
        playing.gate = tick.gate;
        this.host.moved(this.runId, "waiting");
        return;
      }
      this.schedule(playing);
    }, tick.after);
  }

  private end(playing: Playing, events: Draft[], status: "success" | "cancelled"): void {
    this.playing = null;
    const durationMs = this.host.clock.now() - playing.startedAt;
    this.host.emit(this.runId, [...events, { type: "turn.completed", turnId: playing.turnId, status, durationMs }]);
    this.startNext();
  }
}
