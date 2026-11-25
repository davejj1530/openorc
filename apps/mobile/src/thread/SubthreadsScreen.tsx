import { relativeTime, threadMark } from "@openorc/client";
import type { ThreadSummary } from "@openorc/protocol";
import { router } from "expo-router";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRpc } from "../client";
import { PanelHeader, usePanelParams } from "../panel/host";
import { ACTION_RESERVE, MARGIN, ROW_INSET } from "../home/grid";
import { ThreadStatusMark } from "../home/ThreadStatusMark";
import { ListPressable } from "../ui/ListPressable";
import { Measure } from "../ui/pane";
import { WorkingMark } from "../ui/StateMark";
import { Text } from "../ui/Text";
import { useSubthreads } from "./subthreads";

/** Threads' row: the muted title at reading size over a detail line, on Home's grid. */
const rowStyle = { paddingLeft: MARGIN - ROW_INSET, paddingRight: ACTION_RESERVE };

function SubthreadRow({ thread, open }: { thread: ThreadSummary; open: (id: string) => void }) {
  const mark = threadMark(thread);
  const when = relativeTime(thread.lastActivityAt);
  return (
    <ListPressable
      accessibilityRole="button"
      accessibilityLabel={[thread.title, mark?.label, when].filter(Boolean).join(", ")}
      onPress={() => open(thread.id)}
      className="mx-3 gap-1 rounded-lg px-2 py-2 active:bg-surface-2"
      style={rowStyle}
    >
      <Text numberOfLines={1} className="text-xl text-ink">
        {thread.title}
      </Text>
      <View className="flex-row items-center gap-1.5">
        <Text numberOfLines={1} className="flex-1 text-detail text-ink-4">
          {[mark?.kind === "pull" ? null : mark?.label, when].filter(Boolean).join(" · ")}
        </Text>
        <ThreadStatusMark mark={mark} />
      </View>
    </ListPressable>
  );
}

/** The threads started from one thread, by the person or its agent, newest first; each opens as its own thread. */
export function SubthreadsScreen() {
  const { threadId } = usePanelParams<{ threadId: string }>();
  const insets = useSafeAreaInsets();
  const parent = useRpc("threads.get", { id: threadId }).data ?? null;
  const { subthreads, loading } = useSubthreads(parent);
  const open = (id: string) => router.push({ pathname: "/thread/[id]", params: { id } });
  return (
    <Measure className="flex-1 bg-bg">
      <PanelHeader title="Subthreads" line={parent?.title ?? null} />
      {subthreads.length ? (
        <ScrollView contentContainerClassName="pt-2" contentContainerStyle={{ paddingBottom: insets.bottom + 16 }}>
          {subthreads.map((thread) => (
            <SubthreadRow key={thread.id} thread={thread} open={open} />
          ))}
        </ScrollView>
      ) : (
        <View className="flex-1 items-center justify-center">{loading || !parent ? <WorkingMark /> : <Text className="text-lg text-ink-3">No subthreads</Text>}</View>
      )}
    </Measure>
  );
}
