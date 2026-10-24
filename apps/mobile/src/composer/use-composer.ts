import type { SubmitRequest } from "@openorc/client";
import { useRef, useState } from "react";
import { client, useRpcMutation } from "../client";
import { failureMessage } from "../failure";
import { haptic } from "../ui/haptics";
import { composerControls, unsent } from "./composer-state";
import { useDimReason } from "./dim-reason";
import { useDraft } from "./drafts";
import { useEmptiedPrompt } from "./keyboard-leftover";
import { useImageAttach } from "./use-image-attach";

export interface ComposerInput {
  threadId: string;
  request: Omit<SubmitRequest, "now">;
  live: { runId: string } | null;
  working: boolean;
  canSteer: boolean;
  disabledReason: string | null;
  onSent: () => void;
}

/**
 * What the composer does: the draft (kept per thread), the images on their way to the Mac, the controls the state
 * machine decides, and the send, stop and attach actions. As in Messages, a send empties the prompt at once and the
 * keyboard stays up, so whatever is written next is the next message. A send that fails puts what it took back, ahead
 * of anything written since, and says why.
 */
export function useComposer({ threadId, request, live, working, canSteer, disabledReason, onSent }: ComposerInput) {
  const [draft, setDraft] = useDraft(threadId);
  const [sending, setSending] = useState(false);
  // A second tap can land before the first send renders, so the send in flight is held here as well.
  const inFlight = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const field = useEmptiedPrompt();
  const { uploading, chooseImages } = useImageAttach({
    onImage: (image) => setDraft((current) => ({ ...current, images: [...current.images, image] })),
    onError: setError,
  });
  const submitter = client.useSubmit();
  const interrupt = useRpcMutation("runs.interrupt");
  const controls = composerControls({
    text: draft.text,
    attachments: draft.images.length,
    uploading,
    sending,
    disabledReason,
    working,
    steerable: canSteer,
    stoppable: Boolean(live && working),
    stopping: interrupt.isPending,
  });
  const dim = useDimReason(controls.primaryEnabled ? null : disabledReason);

  const send = async (now: boolean) => {
    if (!controls.canSend || inFlight.current) return;
    inFlight.current = true;
    const taken = draft;
    const outgoing = { text: draft.text.trim(), attachments: draft.images.map((image) => image.path) };
    setDraft(() => ({ text: "", images: [] }));
    field.emptied();
    setSending(true);
    setError(null);
    try {
      await submitter.submit({ ...request, now }, outgoing);
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
  const stop = () => {
    if (!live || interrupt.isPending) return;
    haptic.tap();
    interrupt.mutate({ runId: live.runId });
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
    /** The main pill: Stop, or a send into the running turn or the next one, as the controls say. */
    primary: () => (controls.primary === "stop" ? stop() : void send(controls.sendsNow)),
    /** A tap on the dim pill: says why it is dim, and does nothing else. */
    explainDim: dim.ask,
    queue: () => void send(false),
    stop,
    chooseImages,
  };
}
