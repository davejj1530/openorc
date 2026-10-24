import type { SubmitRequest } from "@openorc/client";
import * as Haptics from "expo-haptics";
import { useState } from "react";
import { ActionSheetIOS } from "react-native";
import { client, useRpcMutation } from "../client";
import { attachImage, pickImages, type ImageSource } from "./attachments";
import { composerControls } from "./composer-state";
import { useDraft } from "./drafts";

const message = (failure: unknown) => (failure instanceof Error ? failure.message : String(failure));

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
 * machine decides, and the send, stop and attach actions. A send that fails keeps the draft and says why.
 */
export function useComposer({ threadId, request, live, working, canSteer, disabledReason, onSent }: ComposerInput) {
  const [draft, setDraft] = useDraft(threadId);
  const [uploading, setUploading] = useState(0);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
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

  const send = async (now: boolean) => {
    if (!controls.canSend) return;
    const outgoing = { text: draft.text.trim(), attachments: draft.images.map((image) => image.path) };
    setSending(true);
    setError(null);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    try {
      await submitter.submit({ ...request, now }, outgoing);
      setDraft(() => ({ text: "", images: [] }));
      onSent();
    } catch (failure) {
      setError(message(failure));
    } finally {
      setSending(false);
    }
  };
  const stop = () => {
    if (!live || interrupt.isPending) return;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    interrupt.mutate({ runId: live.runId });
  };
  const attach = async (source: ImageSource) => {
    const assets = await pickImages(source);
    if (!assets.length) return;
    setUploading((count) => count + assets.length);
    setError(null);
    await Promise.all(
      assets.map((asset) =>
        attachImage(asset)
          .then((image) => setDraft((current) => ({ ...current, images: [...current.images, image] })))
          .catch((failure: unknown) => setError(message(failure)))
          .finally(() => setUploading((count) => count - 1)),
      ),
    );
  };

  return {
    draft,
    setText: (text: string) => setDraft((current) => ({ ...current, text })),
    removeImage: (path: string) => setDraft((current) => ({ ...current, images: current.images.filter((image) => image.path !== path) })),
    uploading,
    sending,
    controls,
    stopping: interrupt.isPending,
    error: error ?? (interrupt.error ? `Couldn’t stop the agent. ${interrupt.error.message}` : null),
    /** The main pill: Stop, or a send into the running turn or the next one, as the controls say. */
    primary: () => (controls.primary === "stop" ? stop() : void send(controls.sendsNow)),
    queue: () => void send(false),
    stop,
    chooseImages: () =>
      ActionSheetIOS.showActionSheetWithOptions({ options: ["Photo Library", "Take Photo", "Cancel"], cancelButtonIndex: 2 }, (index) => {
        if (index === 0) void attach("library");
        if (index === 1) void attach("camera");
      }),
  };
}
