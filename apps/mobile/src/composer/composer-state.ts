import { composerActions } from "@openorc/client";
import type { Draft } from "./drafts";

/** Everything the composer's controls are decided from. */
export interface ComposerState {
  text: string;
  attachments: number;
  /** Passages quoted from the conversation; a new thread quotes none. */
  quotes?: number;
  /** Images still resizing or saving on the Mac. */
  uploading: number;
  /** A send is on its way to the Mac. */
  sending: boolean;
  /** Why nothing can be sent yet: history or saved permissions still loading, no model. */
  disabledReason: string | null;
  /** The conversation is busy, so a message either goes into the running turn or waits for the next. */
  working: boolean;
  /** The running turn can take a message now. */
  steerable: boolean;
  /** A live process is working: Stop would end its turn. */
  stoppable: boolean;
  /** A stop is on its way. */
  stopping: boolean;
}

/**
 * The composer's controls, so what shows and what it does never disagree. On the phone a message sent during a turn
 * goes into it, as in a desktop conversation: the main button sends now when the turn can take it and queues when it
 * cannot; beside it, Queue holds the message for after the turn. With nothing written, the main button stops.
 */
export function composerControls(state: ComposerState) {
  const held = state.attachments > 0 || Boolean(state.quotes);
  const hasDraft = Boolean(state.text.trim()) || held || state.uploading > 0;
  const actions = composerActions({ queueing: state.working, liveByDefault: true, steerable: state.steerable, canStop: state.stoppable, hasDraft });
  const canSend = Boolean(state.text.trim() || held) && !state.sending && !state.disabledReason && state.uploading === 0;
  return {
    ...actions,
    canSend,
    /** The main pill can be pressed: a send that can go, or a stop not already under way. */
    primaryEnabled: actions.primary === "stop" ? !state.stopping : canSend,
  };
}

export type ComposerControls = ReturnType<typeof composerControls>;

/** What a send that failed puts back: the text, images, quotes and tags it took, ahead of anything written, attached or quoted since. */
export function unsent(taken: Draft, since: Draft): Draft {
  const tags = [...(taken.tags ?? []), ...(since.tags ?? [])];
  const reply = taken.reply ?? since.reply;
  const quotes = [...(taken.quotes ?? []), ...(since.quotes ?? [])];
  return {
    text: [taken.text, since.text].filter((text) => text.trim()).join("\n"),
    images: [...taken.images, ...since.images],
    ...(tags.length && { tags }),
    ...(reply && { reply }),
    ...(quotes.length && { quotes }),
  };
}
