import { router, useLocalSearchParams } from "expo-router";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Mono } from "../ui/Mono";
import { SheetHeader } from "../ui/SheetHeader";
import { usePublishing } from "./publishing";

const back = () => router.back();

/** A refusal's full text, as Git, a hook or gh wrote it, to read and copy. */
export function DetailsSheet() {
  const { threadId } = useLocalSearchParams<{ threadId: string }>();
  const insets = useSafeAreaInsets();
  const publishing = usePublishing(threadId);
  const details = publishing.kind === "notice" ? publishing.details : null;
  return (
    <ScrollView className="flex-1 bg-bg" stickyHeaderIndices={[0]} contentContainerStyle={{ paddingBottom: insets.bottom + 24 }} onAccessibilityEscape={back}>
      <SheetHeader title="Details" onClose={back} />
      <View className="px-5 pt-1">{details ? <Mono text={details} tone="text-ink-2" /> : null}</View>
    </ScrollView>
  );
}
