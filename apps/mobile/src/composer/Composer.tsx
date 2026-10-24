import { composerActivity, conversationPlaceholder, type ClientState } from "@openorc/client";
import { harnessShortName, isHarnessId, type ThreadSummary } from "@openorc/protocol";
import { Pressable, TextInput, View, type LayoutChangeEvent } from "react-native";
import { KeyboardStickyView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRpcMutation } from "../client";
import { Plus, Square } from "../generated/icons";
import { text } from "../generated/tokens";
import { cn } from "../ui/cn";
import { Text } from "../ui/Text";
import { ComposerChips } from "./ComposerChips";
import { ComposerImages } from "./ComposerImages";
import { MessageQueue } from "./MessageQueue";
import { SendButton } from "./SendButton";
import { useComposer, type ComposerInput } from "./use-composer";

type Settings = ReturnType<ClientState["useConversationSettings"]>;

/** The prompt grows with what is written up to six lines, then scrolls. */
const PROMPT_MAX = text.md.lineHeight * 6;

export interface ComposerProps extends Omit<ComposerInput, "threadId"> {
  thread: ThreadSummary;
  settings: Settings;
  generatingImage: boolean;
  onLayout: (event: LayoutChangeEvent) => void;
}

/** Messages waiting for the running turn, each able to go now or leave the queue. */
function Queue({ thread, canSteer, onSent }: { thread: ThreadSummary; canSteer: boolean; onSent: () => void }) {
  const unqueue = useRpcMutation("threads.unqueue");
  const sendQueued = useRpcMutation("threads.sendQueued");
  const failure = (unqueue.error ?? sendQueued.error)?.message;
  return (
    <>
      <MessageQueue
        messages={thread.queued}
        canSend={canSteer}
        pending={unqueue.isPending || sendQueued.isPending}
        agentName={harnessShortName(isHarnessId(thread.agent) ? thread.agent : "codex")}
        onSend={(messageId) => {
          sendQueued.mutate({ id: thread.id, messageId });
          onSent();
        }}
        onRemove={(messageId) => unqueue.mutate({ id: thread.id, messageId })}
      />
      {failure ? <Text className="px-1 text-sm text-bad">{failure}</Text> : null}
    </>
  );
}

/**
 * The thread's composer, pinned above the keyboard: queued messages above it, then one r20 plane with the prompt and a
 * bar of attach, model and mode on the left, and activity, Queue, Stop and the send pill on the right. What a send does
 * (into the turn, after it, the warm process or a new one) is the desktop's send tree.
 */
export function Composer({ thread, settings, generatingImage, onLayout, ...input }: ComposerProps) {
  const insets = useSafeAreaInsets();
  const composer = useComposer({ ...input, threadId: thread.id });
  const { controls } = composer;
  const activity = composerActivity({ stopping: composer.stopping, submitting: composer.sending, generatingImage });
  const failure = composer.error ?? settings.error?.message ?? settings.permissionError;
  return (
    <KeyboardStickyView offset={{ closed: 0, opened: insets.bottom }}>
      <View onLayout={onLayout} className="gap-2 bg-bg px-3 pt-2" style={{ paddingBottom: insets.bottom + 8 }}>
        <Queue thread={thread} canSteer={input.canSteer} onSent={input.onSent} />
        {failure ? (
          <Text accessibilityRole="alert" className="px-1 text-sm text-bad">
            {failure}
          </Text>
        ) : null}
        <View className="gap-3.5 rounded-3xl bg-composer-input pb-3 pl-4 pr-3 pt-3.5">
          <ComposerImages images={composer.draft.images} uploading={composer.uploading} onRemove={composer.removeImage} />
          <TextInput
            multiline
            value={composer.draft.text}
            onChangeText={composer.setText}
            editable={!composer.sending}
            placeholder={conversationPlaceholder({ firstTaskRun: false, working: input.working, canSteer: input.canSteer, agent: settings.choice?.agent })}
            accessibilityLabel="Message"
            className="p-0 font-sans text-md leading-5 text-ink"
            placeholderTextColorClassName="accent-ink-4"
            style={{ maxHeight: PROMPT_MAX }}
          />
          <View className="flex-row items-center justify-between gap-2">
            <View className="min-w-0 flex-1 flex-row items-center gap-1.5">
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Attach image"
                onPress={composer.chooseImages}
                hitSlop={8}
                className="h-control-sm w-7 items-center justify-center rounded-full active:bg-surface-2"
              >
                <Plus size={16} className="text-ink-4" />
              </Pressable>
              <ComposerChips threadId={thread.id} settings={settings} />
            </View>
            <View className="flex-row items-center gap-2.5">
              {activity ? <Text className="text-sm text-ink-4">{activity}</Text> : null}
              {controls.stop ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Stop"
                  disabled={composer.stopping}
                  onPress={composer.stop}
                  hitSlop={8}
                  className="h-control-sm w-7 items-center justify-center rounded-full active:bg-surface-2"
                >
                  <Square size={14} className="text-ink-4" />
                </Pressable>
              ) : null}
              {controls.queue ? (
                <Pressable accessibilityRole="button" disabled={!controls.canSend} onPress={composer.queue} className="h-control-sm justify-center rounded-full px-2.5 active:bg-surface-2">
                  <Text className={cn("text-sm text-ink-2", !controls.canSend && "text-ink-4")}>Queue</Text>
                </Pressable>
              ) : null}
              <SendButton state={controls.primary} disabled={!controls.primaryEnabled} onPress={composer.primary} />
            </View>
          </View>
        </View>
      </View>
    </KeyboardStickyView>
  );
}
