import { NOTE_FILES_HELD, quotedMessage, type Quote, type SubmitRequest } from "@openorc/client";
import type { HostedFileScope } from "@openorc/protocol";
import { useRef, useState } from "react";
import { client, newId, useRpcMutation } from "../client";
import { failureMessage } from "../failure";
import { haptic } from "../ui/haptics";
import { composerControls, unsent } from "./composer-state";
import { useDimReason } from "./dim-reason";
import { useDraft, type Draft } from "./drafts";
import { useEmptiedPrompt } from "./keyboard-leftover";
import { phoneNote, type DraftReply, type DraftTag, type PhoneNote } from "./note-draft";
import { useImageAttach } from "./use-image-attach";

/** Where a cloud thread's notes go from its composer, while the server lets the reader post them. */
export interface ComposerNotes {
  threadId: string;
  /** The reader, whom `@` never offers. */
  viewerId: string | null;
  /** Posts the note; fails in the server's words, which the composer shows over the draft it puts back. */
  post: (note: PhoneNote) => Promise<void>;
}

export interface ComposerInput {
  threadId: string;
  request: Omit<SubmitRequest, "now">;
  live: { runId: string } | null;
  working: boolean;
  canSteer: boolean;
  disabledReason: string | null;
  onSent: () => void;
  /** In an OpenOrc Cloud thread: the running turn this screen saw, which a Stop names. */
  turnSeen?: { expectedTurnId: string } | Record<string, never>;
  /**
   * Why images cannot be sent here, said when the attach button is tapped; null where they can, and empty while that is
   * not known yet, when the button is dimmed and says nothing.
   */
  attachRefusal?: string | null;
  /** Where in OpenOrc Cloud images go, in a cloud thread; null: to the Mac. */
  attachTo?: HostedFileScope | null;
  /** In a cloud thread where the reader may post notes: a draft that tags someone posts as a note to them. */
  notes?: ComposerNotes | null;
  /** Where the thread's place compacts it: a draft that is `/compact` alone folds the conversation so far instead of sending. */
  compact?: (() => Promise<unknown>) | null;
}

/** The one command the composer runs itself rather than send. */
const COMPACT = "/compact";

/** The draft's tags as Reply, the handoff's Tag and a pick from `@` write them. */
function draftTagWriters(setDraft: (update: (draft: Draft) => Draft) => void) {
  return {
    /** Tags a person at the draft's start, as Reply on their note does, which the note then answers. */
    tag: (person: DraftTag, reply?: DraftReply) =>
      setDraft((current) => ({ ...current, text: `@${person.name} ${current.text.trimStart()}`, tags: [...(current.tags ?? []), person], ...(reply && { reply }) })),
    /** Puts a note the server wrote in place of the words, tagging its person, as the handoff's Tag does. */
    stage: (text: string, person: DraftTag) => setDraft((current) => ({ ...current, text, tags: [person] })),
    /** Tags a person picked from `@` in place of the `@` word, and where the caret goes after. */
    pickTag: (person: DraftTag, word: { start: number }, caret: number): number => {
      const written = `@${person.name} `;
      setDraft((current) => ({ ...current, text: `${current.text.slice(0, word.start)}${written}${current.text.slice(caret)}`, tags: [...(current.tags ?? []), person] }));
      return word.start + written.length;
    },
  };
}

/** The draft's quotes as Quote on selected words, a note written on one and its remove pill change them. */
function draftQuoteWriters(setDraft: (update: (draft: Draft) => Draft) => void) {
  const change = (update: (quotes: Quote[]) => Quote[]) => setDraft((current) => ({ ...current, quotes: update(current.quotes ?? []) }));
  return {
    quote: (text: string) => change((quotes) => [...quotes, { id: newId(), text, note: "" }]),
    noteQuote: (id: string, note: string) => change((quotes) => quotes.map((quote) => (quote.id === id ? { ...quote, note } : quote))),
    removeQuote: (id: string) => change((quotes) => quotes.filter((quote) => quote.id !== id)),
  };
}

/**
 * What the composer does: the draft (kept per thread) with the passages it quotes, the images on their way to the Mac, the controls the state
 * machine decides, and the send, stop and attach actions. As in Messages, a send empties the prompt at once and the
 * keyboard stays up, so whatever is written next is the next message. A send that fails puts what it took back, ahead
 * of anything written since, and says why.
 */
export function useComposer({ threadId, request, live, working, canSteer, disabledReason, onSent, turnSeen = {}, attachRefusal = null, attachTo = null, notes = null, compact = null }: ComposerInput) {
  const [draft, setDraft] = useDraft(threadId);
  const [sending, setSending] = useState(false);
  // A second tap can land before the first send renders, so the send in flight is held here as well.
  const inFlight = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const field = useEmptiedPrompt();
  const { uploading, chooseImages } = useImageAttach({
    onImage: (image) => setDraft((current) => ({ ...current, images: [...current.images, image] })),
    onError: setError,
    cloud: attachTo,
  });
  const submitter = client.useSubmit();
  const interrupt = useRpcMutation("runs.interrupt");
  // A note goes to the people it tags whatever the turn is doing; files ride only with messages.
  const note = notes ? phoneNote(draft.text, draft.tags ?? [], draft.reply) : null;
  const quotes = draft.quotes ?? [];
  const noteHeld = draft.images.length || quotes.length ? NOTE_FILES_HELD : null;
  const reason = note ? noteHeld : disabledReason;
  const busy = !note && working;
  const controls = composerControls({
    text: draft.text,
    attachments: draft.images.length,
    quotes: quotes.length,
    uploading,
    sending,
    disabledReason: reason,
    working: busy,
    steerable: canSteer,
    stoppable: Boolean(live && busy),
    stopping: interrupt.isPending,
  });
  const dim = useDimReason(controls.primaryEnabled ? null : reason);

  /** Empties the draft at once and delivers what it held; a delivery that fails puts it back and says why. */
  const deliver = async (work: (taken: Draft) => Promise<unknown>) => {
    if (!controls.canSend || inFlight.current) return;
    inFlight.current = true;
    const taken = draft;
    setDraft(() => ({ text: "", images: [] }));
    field.emptied();
    setSending(true);
    setError(null);
    try {
      await work(taken);
      haptic.confirm();
      onSent();
    } catch (failure) {
      haptic.fail();
      setDraft((current) => unsent(taken, current));
      setError(failureMessage(failure));
    } finally {
      inFlight.current = false;
      setSending(false);
    }
  };
  const send = (now: boolean) =>
    deliver((taken) => submitter.submit({ ...request, now }, { text: quotedMessage(taken.quotes ?? [], taken.text.trim()), attachments: taken.images.map((image) => image.path) }));
  const post = (posting: PhoneNote) => deliver(() => notes!.post(posting));
  const stop = () => {
    if (!live || interrupt.isPending) return;
    haptic.tap();
    interrupt.mutate({ runId: live.runId, ...turnSeen });
  };

  return {
    draft,
    setText: (text: string) => {
      if (!field.leftover(text)) setDraft((current) => ({ ...current, text }));
    },
    removeImage: (path: string) => setDraft((current) => ({ ...current, images: current.images.filter((image) => image.path !== path) })),
    uploading,
    sending,
    controls,
    stopping: interrupt.isPending,
    error: error ?? (interrupt.error ? `Couldn’t stop the agent. ${interrupt.error.message}` : null),
    /** Why Send is dim, after a tap on it asked. */
    dimReason: dim.shown,
    /** The main pill: a note to the people it tags; else Stop, or a send into the running turn or the next one. */
    primary: () => {
      if (note) return void post(note);
      if (compact && !working && draft.text.trim() === COMPACT && !draft.images.length && !quotes.length) return void deliver(() => compact());
      return controls.primary === "stop" ? stop() : void send(controls.sendsNow);
    },
    ...draftTagWriters(setDraft),
    ...draftQuoteWriters(setDraft),
    isNote: note !== null,
    /** A tap on the dim pill: says why it is dim, and does nothing else. */
    explainDim: dim.ask,
    queue: () => void send(false),
    stop,
    chooseImages: attachRefusal === null ? chooseImages : () => void (attachRefusal && setError(attachRefusal)),
    attachDimmed: attachRefusal !== null,
  };
}
