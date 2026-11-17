import { handoffCard, handoffLabel, type HandoffAction } from "@openorc/client";
import type { ThreadSummary } from "@openorc/protocol";
import { Pressable, View } from "react-native";
import { useRpcMutation } from "../client";
import { Text } from "../ui/Text";

/** The actions a phone takes on a handoff: a tag goes with a note, which the phone does not write yet. */
const ACTIONABLE = new Set<HandoffAction["kind"]>(["retry-save", "stop-work", "stop-commands"]);

/**
 * Above a cloud thread's composer, in a thread others are in, what holds the next turn and the move that releases it,
 * in the shared words: retry the save that failed, stop the work or the commands the last turn left running. Nothing
 * for any other thread.
 */
export function HandoffCard({ thread }: { thread: ThreadSummary }) {
  const retry = useRpcMutation("threads.retrySave");
  const stopWork = useRpcMutation("threads.stopWork");
  const stopCommand = useRpcMutation("threads.stopCommand");
  const card = handoffCard(thread);
  if (!card) return null;
  const { words, action } = card;
  const pending = retry.isPending || stopWork.isPending || stopCommand.isPending;
  const failure = (retry.error ?? stopWork.error ?? stopCommand.error)?.message;
  const release = async () => {
    if (action?.kind === "retry-save") return retry.mutate({ threadId: thread.id });
    if (action?.kind === "stop-work") return stopWork.mutate({ threadId: thread.id });
    if (action?.kind !== "stop-commands") return;
    for (const commandId of action.commandIds) await stopCommand.mutateAsync({ id: thread.id, commandId }).catch(() => undefined);
  };
  return (
    <View className="gap-1">
      <View className="min-h-touch flex-row items-center gap-3 rounded-xl bg-surface py-2 pl-3.5 pr-2">
        <Text className="min-w-0 flex-1 text-sm text-ink-2">{words}</Text>
        {action && ACTIONABLE.has(action.kind) ? (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: pending }}
            disabled={pending}
            onPress={() => void release()}
            hitSlop={6}
            className="h-control-md justify-center rounded-full bg-surface-2 px-3 active:bg-surface-3"
          >
            <Text className="text-sm">{handoffLabel(action)}</Text>
          </Pressable>
        ) : null}
      </View>
      {failure ? (
        <Text accessibilityRole="alert" className="px-1 text-sm text-bad">
          {failure}
        </Text>
      ) : null}
    </View>
  );
}
