import { router, Stack, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { ScrollView, TextInput, View } from "react-native";
import { newId, useRpc } from "../client";
import { startCloudReview, useCloudReview } from "../cloud/cloud-review";
import { SheetHeader } from "../ui/SheetHeader";
import { useSheetBottom } from "../ui/sheet-bottom";
import { Text } from "../ui/Text";
import { Field, SheetPill } from "./SheetParts";

/** A field grows with what is written up to six of its 20 pt lines, then scrolls. */
const FIELD_MAX = 20 * 6 + 24;
const back = () => router.back();
const fieldClass = "px-4 py-3 font-sans text-md leading-5 text-ink";

/** While an action of the thread is on its way, the sheet holds: its fields, its close button and swiping down. */
function useHeld(threadId: string): boolean {
  const thread = useRpc("threads.get", { id: threadId });
  return useCloudReview(threadId, thread.data?.owner?.reach === "live").pending;
}

/** The message for a commit of a cloud thread's work, which OpenOrc Cloud makes on its machine; the sheet closes once asked. */
export function CloudCommitSheet() {
  const { threadId } = useLocalSearchParams<{ threadId: string }>();
  const bottom = useSheetBottom(16);
  const held = useHeld(threadId);
  const [message, setMessage] = useState("");
  const commit = () => {
    if (held || !message.trim()) return;
    startCloudReview(threadId, { kind: "commit", id: newId(), message: message.trim() });
    back();
  };
  return (
    <>
      <Stack.Screen options={{ gestureEnabled: !held }} />
      <ScrollView keyboardShouldPersistTaps="handled" scrollEnabled={false} className="bg-bg" contentContainerStyle={{ paddingBottom: bottom }} onAccessibilityEscape={() => !held && back()}>
        <SheetHeader title="Commit changes" onClose={back} locked={held} />
        <View className="gap-3 px-5 pt-1">
          <Field>
            <TextInput
              multiline
              autoFocus
              editable={!held}
              value={message}
              onChangeText={setMessage}
              placeholder="What changed and why"
              accessibilityLabel="Commit message"
              className={fieldClass}
              placeholderTextColorClassName="accent-ink-4"
              style={{ maxHeight: FIELD_MAX }}
            />
          </Field>
          <SheetPill label="Commit" dim={!message.trim()} running={held} onPress={commit} />
        </View>
      </ScrollView>
    </>
  );
}

/** A pull request for a cloud thread's branch, which OpenOrc Cloud opens on GitHub; the sheet closes once asked. */
export function CloudPullRequestSheet() {
  const { threadId } = useLocalSearchParams<{ threadId: string }>();
  const bottom = useSheetBottom(16);
  const held = useHeld(threadId);
  const thread = useRpc("threads.get", { id: threadId });
  const state = useRpc("hosted.review.state", { threadId });
  const [title, setTitle] = useState<string | null>(null);
  const [body, setBody] = useState("");
  const shownTitle = title ?? thread.data?.title ?? "";
  const open = () => {
    if (held || !shownTitle.trim()) return;
    startCloudReview(threadId, { kind: "pull_request", id: newId(), title: shownTitle.trim(), body });
    back();
  };
  return (
    <>
      <Stack.Screen options={{ gestureEnabled: !held }} />
      <ScrollView keyboardShouldPersistTaps="handled" className="bg-bg" contentContainerStyle={{ paddingBottom: bottom }} onAccessibilityEscape={() => !held && back()}>
        <SheetHeader title="Open a pull request" onClose={back} locked={held} />
        <View className="gap-3 px-5 pt-1">
          {state.data ? <Text className="px-4 text-sm text-ink-3">Into {state.data.baseBranch}</Text> : null}
          <Field label="Title">
            <TextInput editable={!held} value={shownTitle} onChangeText={setTitle} accessibilityLabel="Title" className={fieldClass} />
          </Field>
          <Field label="Body">
            <TextInput
              multiline
              editable={!held}
              value={body}
              onChangeText={setBody}
              placeholder="What this changes and how to check it"
              accessibilityLabel="Body"
              className={fieldClass}
              placeholderTextColorClassName="accent-ink-4"
              style={{ maxHeight: FIELD_MAX }}
            />
          </Field>
          <SheetPill label="Open PR" dim={!shownTitle.trim()} running={held} onPress={open} />
        </View>
      </ScrollView>
    </>
  );
}
