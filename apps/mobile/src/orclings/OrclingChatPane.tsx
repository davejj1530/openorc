import type { LegendListRef } from "@legendapp/list/react-native";
import { conversationActivity } from "@openorc/client";
import type { OrclingChatSummary, Run, ThreadSummary } from "@openorc/protocol";
import { useEffect, type RefObject } from "react";
import { View } from "react-native";
import type { SharedValue } from "react-native-reanimated";
import { useHostClient } from "../client";
import { Spinner } from "../ui/Spinner";
import { Text } from "../ui/Text";
import { OrclingChatList } from "./OrclingChatList";
import { OrclingFace } from "./OrclingFace";

type Activity = ReturnType<typeof conversationActivity>;

/**
 * An Orcling's own conversation in its chat layout, in place of the work transcript, reading the same pages and live
 * frames. It hears every streamed frame, so the header and composer around it hear only when it starts or stops working.
 */
export function OrclingChatPane({
  chat,
  thread,
  runs,
  loading,
  onActivity,
  composerInset,
  listRef,
  followKey,
}: {
  chat: OrclingChatSummary;
  thread: ThreadSummary;
  runs: Run[];
  loading: boolean;
  onActivity: (activity: Activity) => void;
  composerInset: SharedValue<number>;
  listRef: RefObject<LegendListRef | null>;
  followKey: number;
}) {
  const { merged, liveTranscript, hasOlder, loadOlder } = useHostClient().useConversationTranscript({ runs, threadId: thread.id });
  const { live, working, generatingImage } = conversationActivity({ thread, activeRun: runs.at(-1), liveTranscript, compacting: false });
  useEffect(() => onActivity({ live, working, generatingImage }), [live, working, generatingImage, onActivity]);
  const blocks = merged?.blocks;
  if (!merged || !blocks?.length)
    return (
      <View className="flex-1 items-center justify-center gap-3">
        {loading ? (
          <Spinner />
        ) : (
          <>
            <OrclingFace look={chat.look} size={96} />
            <Text className="text-ink-3">Say hi to {chat.name}</Text>
          </>
        )}
      </View>
    );
  return (
    <OrclingChatList
      chat={chat}
      blocks={blocks}
      typing={Boolean(working || merged.turnOpen)}
      runId={merged.runId}
      hasOlder={hasOlder}
      loadOlder={loadOlder}
      composerInset={composerInset}
      listRef={listRef}
      followKey={followKey}
    />
  );
}
