import { fileCount } from "@openorc/client";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, TextInput, View } from "react-native";
import { haptic } from "../ui/haptics";
import { SheetHeader } from "../ui/SheetHeader";
import { useSheetBottom } from "../ui/sheet-bottom";
import { Text } from "../ui/Text";
import { countsText, lineCounts } from "./change-words";
import { LineCountsText } from "./ChangeRows";
import { NoticeText } from "./PublishBar";
import { commitThread } from "./publish-actions";
import { changeDrafts } from "./publishing";
import { Field, SheetPill } from "./SheetParts";
import { useChangesReads, type ChangesReads } from "./use-changes";
import { usePublish } from "./use-publish";

/** The field grows with what is written up to six of its 20 pt lines, then scrolls. */
const MESSAGE_MAX = 20 * 6;
const back = () => router.back();

/** "3 files +42 −7": what Commit takes, always the uncommitted counts. */
function CommitSummary({ reads }: { reads: ChangesReads }) {
  const totals = reads.uncommitted.data?.totals;
  if (reads.uncommitted.error && !totals)
    return (
      <Pressable accessibilityRole="button" onPress={() => void reads.uncommitted.refetch()} className="self-start px-4 active:opacity-60">
        <Text className="text-sm text-bad">Could not refresh uncommitted changes. Retry</Text>
      </Pressable>
    );
  if (!totals) return null;
  const counts = lineCounts(totals.insertions, totals.deletions);
  return (
    <View accessible accessibilityLabel={[fileCount(totals.files), counts && countsText(counts)].filter(Boolean).join(", ")} className="flex-row gap-1.5 px-4">
      <Text className="text-sm text-ink-3">{fileCount(totals.files)}</Text>
      {counts ? <LineCountsText counts={counts} /> : null}
    </View>
  );
}

/**
 * The message for a commit of everything uncommitted, kept as a draft while it is written. While the commit runs the
 * field, the close button and swiping down all hold; a commit made closes the sheet and the screen says so.
 */
export function CommitSheet() {
  const { threadId } = useLocalSearchParams<{ threadId: string }>();
  const bottom = useSheetBottom(16);
  const reads = useChangesReads(threadId, "head");
  const { publishing, view, mac } = usePublish(threadId, reads);
  const [message, setMessage] = useState(() => changeDrafts.message(threadId));
  const [asked, setAsked] = useState<string | null>(null);
  const started = useRef(false);
  const locked = publishing.kind === "running" || (publishing.kind === "lost" && publishing.lost.action === "commit");
  const step = view?.commit ?? null;
  const reason = step?.reason ?? null;
  useEffect(() => setAsked(null), [reason]);
  useEffect(() => {
    if (started.current && publishing.kind === "notice" && publishing.action === "commit" && publishing.tone === "muted") router.back();
  }, [publishing]);
  const write = (text: string) => {
    setMessage(text);
    changeDrafts.setMessage(threadId, text);
  };
  const commit = () => {
    if (locked || !message.trim()) return;
    if (reason) {
      haptic.warn();
      return setAsked(reason);
    }
    started.current = true;
    void commitThread(threadId, message.trim(), reads.log.data?.[0]?.sha ?? null);
  };
  const failure = publishing.kind === "notice" && publishing.action === "commit" && publishing.tone === "bad" ? publishing : null;
  return (
    <>
      <Stack.Screen options={{ gestureEnabled: !locked }} />
      <ScrollView keyboardShouldPersistTaps="handled" scrollEnabled={false} className="bg-bg" contentContainerStyle={{ paddingBottom: bottom }} onAccessibilityEscape={() => !locked && back()}>
        <SheetHeader title="Commit changes" onClose={back} locked={locked} />
        <View className="gap-3 px-5 pt-1">
          <CommitSummary reads={reads} />
          <Field>
            <TextInput
              multiline
              autoFocus
              editable={!locked}
              value={message}
              onChangeText={write}
              placeholder="What changed and why"
              accessibilityLabel="Commit message"
              className="px-4 py-3 font-sans text-md leading-5 text-ink"
              placeholderTextColorClassName="accent-ink-4"
              style={{ maxHeight: MESSAGE_MAX + 24 }}
            />
          </Field>
          {publishing.kind === "lost" ? <Text className="px-4 text-sm text-ink-3">Lost {mac} before it answered.</Text> : null}
          {asked ? <Text className="px-4 text-sm text-ink-3">{asked}</Text> : null}
          {failure ? (
            <View className="px-4">
              <NoticeText notice={failure} threadId={threadId} />
            </View>
          ) : null}
          <SheetPill label={step?.label ?? "Commit"} dim={!message.trim() || Boolean(reason)} running={locked} onPress={commit} />
        </View>
      </ScrollView>
    </>
  );
}
