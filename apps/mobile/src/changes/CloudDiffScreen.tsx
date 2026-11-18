import { hostedFilePatch } from "@openorc/client";
import { Stack, useLocalSearchParams } from "expo-router";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRpc } from "../client";
import { Spinner } from "../ui/Spinner";
import { Text } from "../ui/Text";
import { fileName } from "./change-words";
import { FailedBlock } from "./ChangeRows";
import { DiffLines } from "./DiffLines";
import { PanelTitle } from "./PanelTitle";

/** One file of a cloud thread's changes, as OpenOrc Cloud read it: its diff, or the server's words for why none shows. */
export function CloudDiffScreen() {
  const { threadId, path } = useLocalSearchParams<{ threadId: string; path: string }>();
  const insets = useSafeAreaInsets();
  const read = useRpc("hosted.review.file", { threadId, path });
  const diff = read.data;
  return (
    <View className="flex-1 bg-bg">
      {/* The folder under the name, for a file in one; a file at the top is named once. */}
      <Stack.Screen options={{ headerTitle: () => <PanelTitle title={fileName(path)} line={fileName(path) === path ? null : path} fromCloud /> }} />
      {read.error ? <FailedBlock message={read.error.message} onRetry={() => void read.refetch()} /> : null}
      {!diff && !read.error ? (
        <View className="items-center py-10">
          <Spinner />
        </View>
      ) : null}
      {diff ? (
        <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 16 }}>
          {diff.note ? <Text className="px-5 py-3 text-sm text-ink-3">{diff.note}</Text> : null}
          <DiffLines patch={hostedFilePatch(diff)} />
        </ScrollView>
      ) : null}
    </View>
  );
}
