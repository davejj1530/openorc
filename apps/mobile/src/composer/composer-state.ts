import { composerActions } from "@openorc/client";

/** Everything the composer's controls are decided from. */
export interface ComposerState {
  text: string;
  attachments: number;
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
  const hasDraft = Boolean(state.text.trim()) || state.attachments > 0 || state.uploading > 0;
  const actions = composerActions({ queueing: state.working, liveByDefault: true, steerable: state.steerable, canStop: state.stoppable, hasDraft });
  const canSend = Boolean(state.text.trim() || state.attachments > 0) && !state.sending && !state.disabledReason && state.uploading === 0;
  return {
    ...actions,
    canSend,
    /** The main pill can be pressed: a send that can go, or a stop not already under way. */
    primaryEnabled: actions.primary === "stop" ? !state.stopping : canSend,
  };
}

export type ComposerControls = ReturnType<typeof composerControls>;
