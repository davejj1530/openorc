import { handoffCard, handoffLabel } from "@openorc/client";
import type { ThreadSummary } from "@openorc/protocol";
import { Pressable, View } from "react-native";
import { useRpcMutation } from "../client";
import { Text } from "../ui/Text";
import type { DraftTag } from "./note-draft";

/**
 * Above a cloud thread's composer, in a thread others are in, what holds the next turn and the move that releases it,
 * in the shared words: retry the save that failed, stop the work or the commands the last turn left running, or, with
 * nothing else to press, tag the person who can, which puts the server's note in the composer to post. Nothing for any
 * other thread.
 */
export function HandoffCard({ thread, draft, onTag }: { thread: ThreadSummary; draft: string; onTag: (text: string, person: DraftTag) => void }) {
  const retry = useRpcMutation("threads.retrySave");
  const stopWork = useRpcMutation("threads.stopWork");
  const stopCommand = useRpcMutation("threads.stopCommand");
  const card = handoffCard(thread);
  if (!card) return null;
  const { words } = card;
  // A note already staged in the composer is posted from there; the card offers it no second time.
  const action = card.action?.kind === "note" && draft.includes(card.action.note.text) ? null : card.action;
  const pending = retry.isPending || stopWork.isPending || stopCommand.isPending;
  const failure = (retry.error ?? stopWork.error ?? stopCommand.error)?.message;
  const release = async () => {
    // A tag stages the server's note to the person who can release the block, for the reader to post.
    if (action?.kind === "note") return onTag(action.note.text, { id: action.note.to.id, name: action.note.text.slice(action.note.mention.start + 1, action.note.mention.end) });
    if (action?.kind === "retry-save") return retry.mutate({ threadId: thread.id });
    if (action?.kind === "stop-work") return stopWork.mutate({ threadId: thread.id });
    if (action?.kind !== "stop-commands") return;
    for (const commandId of action.commandIds) await stopCommand.mutateAsync({ id: thread.id, commandId }).catch(() => undefined);
  };
  return (
    <View className="gap-1">
      <View className="min-h-touch flex-row items-center gap-3 rounded-xl bg-surface py-2 pl-3.5 pr-2">
        <Text className="min-w-0 flex-1 text-sm text-ink-2">{words}</Text>
        {action ? (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: pending }}
            disabled={pending}
            onPress={() => void release()}
            hitSlop={6}
            className="h-control-md justify-center rounded-full bg-key px-3 active:bg-surface-3"
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
