import { composerActivity, conversationPlaceholder, type ClientState } from "@openorc/client";
import type { QueuedMessage, ThreadSummary } from "@openorc/protocol";
import { useImperativeHandle, useState, type Ref } from "react";
import { Pressable, View, type LayoutChangeEvent } from "react-native";
import { KeyboardStickyView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Square } from "../generated/icons";
import { SessionRecovery } from "../thread/SessionRecovery";
import { cn } from "../ui/cn";
import { Text } from "../ui/Text";
import { ComposerPlane } from "./ComposerPlane";
import { SendButton } from "./SendButton";
import { useComposerNotes } from "./composer-notes";
import { HandoffCard } from "./HandoffCard";
import type { DraftReply, DraftTag } from "./note-draft";
import { ThreadQueue } from "./ThreadQueue";
import { useComposer, type ComposerInput } from "./use-composer";

type Settings = ReturnType<ClientState["useConversationSettings"]>;

/** What the thread around the composer asks of it: Reply on a note tags its author, and answers that note. */
export interface ComposerHandle {
  tag: (person: DraftTag, reply?: DraftReply) => void;
}

export interface ComposerProps extends Omit<ComposerInput, "threadId" | "notes"> {
  thread: ThreadSummary;
  /** The messages waiting above the composer. */
  queued: QueuedMessage[];
  settings: Settings;
  generatingImage: boolean;
  onLayout: (event: LayoutChangeEvent) => void;
  /**
   * The Orcling whose own conversation this is, texted as a person is: its name in the field whether or not it works, one
   * send that joins its turn (or waits for it where the agent cannot take a message mid-turn), and its model and mode
   * left to it.
   */
  to?: string;
  handle?: Ref<ComposerHandle>;
}

/** What holds the composer back, in words: a failure in red, else why its send is dimmed. */
function ComposerNotice({ failure, dim }: { failure: string | null | undefined; dim: string | null | undefined }) {
  if (failure) {
    return (
      <Text accessibilityRole="alert" className="px-1 text-sm text-bad">
        {failure}
      </Text>
    );
  }
  return dim ? (
    <Text accessibilityRole="alert" className="px-1 text-sm text-ink-4">
      {dim}
    </Text>
  ) : null;
}

/**
 * The thread's composer, pinned above the keyboard: queued messages above it, then one r20 plane with the prompt and a
 * bar of attach, model and mode on the left, and activity, Queue, Stop and the send pill on the right. What a send does
 * (into the turn, after it, the warm process or a new one) is the desktop's send tree.
 */
export function Composer({ thread, queued, settings, generatingImage, onLayout, to, handle, ...input }: ComposerProps) {
  const insets = useSafeAreaInsets();
  const notes = useComposerNotes(thread);
  const composer = useComposer({ ...input, threadId: thread.id, notes });
  useImperativeHandle(handle, () => ({ tag: composer.tag }), [composer.tag]);
  const [typing, setTyping] = useState(false);
  const { controls } = composer;
  const activity = composerActivity({ stopping: composer.stopping, submitting: composer.sending, generatingImage });
  const failure = composer.error ?? settings.error?.message ?? settings.permissionError;
  return (
    <KeyboardStickyView offset={{ closed: 0, opened: insets.bottom }}>
      <View onLayout={onLayout} className="gap-2 bg-bg px-3 pt-2" style={{ paddingBottom: insets.bottom + 8 }}>
        <ThreadQueue thread={thread} queued={queued} canSteer={input.canSteer} typing={typing} onSent={input.onSent} />
        {typing || input.working ? null : <SessionRecovery thread={thread} request={input.request} disabled={input.disabledReason !== null} onSent={input.onSent} />}
        <HandoffCard thread={thread} draft={composer.draft.text} onTag={composer.stage} />
        <ComposerNotice failure={failure} dim={composer.dimReason} />
        <ComposerPlane
          composerId={thread.id}
          skillScope={{ kind: "thread", id: thread.id }}
          settings={settings}
          draft={composer.draft}
          uploading={composer.uploading}
          onFocusChange={setTyping}
          placeholder={to ? `Message ${to}…` : conversationPlaceholder({ firstTaskRun: false, working: input.working, canSteer: input.canSteer, agent: settings.choice?.agent ?? thread.agent })}
          onText={composer.setText}
          onRemoveImage={composer.removeImage}
          onAttach={composer.chooseImages}
          attachDimmed={composer.attachDimmed}
          chips={!to}
          tagging={notes && { threadId: notes.threadId, viewerId: notes.viewerId, onPick: composer.pickTag }}
        >
          {activity ? <Text className="text-sm text-ink-4">{activity}</Text> : null}
          {controls.stop ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Stop"
              disabled={composer.stopping}
              onPress={composer.stop}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 4 }}
              className="h-control-sm w-7 items-center justify-center rounded-full active:bg-surface-2"
            >
              <Square size={14} className="text-ink-4" />
            </Pressable>
          ) : null}
          {controls.queue && !to ? (
            <Pressable
              accessibilityRole="button"
              disabled={!controls.canSend}
              onPress={composer.queue}
              hitSlop={{ top: 8, bottom: 8 }}
              className="h-control-sm justify-center rounded-full px-2.5 active:bg-surface-2"
            >
              <Text className={cn("text-sm text-ink-2", !controls.canSend && "text-ink-4")}>Queue</Text>
            </Pressable>
          ) : null}
          <SendButton state={controls.primary} disabled={!controls.primaryEnabled} onPress={composer.primary} onDimPress={composer.explainDim} />
        </ComposerPlane>
      </View>
    </KeyboardStickyView>
  );
}
