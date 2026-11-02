import { fileMarks } from "@openorc/client";
import type { FileChange } from "@openorc/protocol";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { ScrollView, View } from "react-native";
import { useRpc, useRpcMutation } from "../client";
import { markTones } from "../changes/ChangeRows";
import { Field, SheetPill } from "../changes/SheetParts";
import { failureMessage } from "../failure";
import { cn } from "../ui/cn";
import { haptic } from "../ui/haptics";
import { SheetHeader } from "../ui/SheetHeader";
import { useSheetBottom } from "../ui/sheet-bottom";
import { Text } from "../ui/Text";

/** As many files as the sheet lists before it counts the rest. */
const LISTED = 6;
const back = () => router.back();

/** The files a checkout conversation takes with it, the first few by name. */
function MovingFiles({ files }: { files: FileChange[] }) {
  if (!files.length) return null;
  const rest = files.length - LISTED;
  return (
    <Field>
      {files.slice(0, LISTED).map((file) => {
        const mark = fileMarks[file.status];
        return (
          <View key={file.path} className="h-touch flex-row items-center gap-3 px-4">
            <Text className={cn("w-2.5 font-mono text-xs", markTones[mark.tone])}>{mark.letter}</Text>
            <Text numberOfLines={1} ellipsizeMode="head" className="min-w-0 flex-1 font-mono text-xs text-ink-2">
              {file.path}
            </Text>
          </View>
        );
      })}
      {rest > 0 ? (
        <View className="h-touch justify-center px-4">
          <Text className="text-sm text-ink-4">and {rest} more</Text>
        </View>
      ) : null}
    </Field>
  );
}

/**
 * The confirm for moving a conversation from the Mac to a sandbox of its own, as the Mac's thread menu asks it. A
 * conversation in the checkout lists the files that leave the checkout with it. While the move runs the sheet holds;
 * a refusal stays in the sheet.
 */
export function CloudMoveSheet() {
  const { threadId } = useLocalSearchParams<{ threadId: string }>();
  const bottom = useSheetBottom(16);
  const thread = useRpc("threads.get", { id: threadId });
  const fromCheckout = thread.data?.workspaceMode === "current";
  const preview = useRpc("threads.movePreview", { id: threadId, to: "worktree" }, { enabled: fromCheckout, staleTime: 0 });
  const move = useRpcMutation("cloud.move");
  const [error, setError] = useState<string | null>(null);
  const blocked = fromCheckout ? (preview.data?.blocked ?? (preview.error ? failureMessage(preview.error) : null)) : null;
  const checking = fromCheckout && preview.isPending;
  const locked = move.isPending;
  const submit = async () => {
    if (locked || blocked || checking || !thread.data) return;
    setError(null);
    try {
      await move.mutateAsync({ threadId });
      haptic.confirm();
      back();
    } catch (failure) {
      haptic.fail();
      setError(failureMessage(failure));
    }
  };
  const problem = error ?? blocked;
  return (
    <>
      <Stack.Screen options={{ gestureEnabled: !locked }} />
      <ScrollView scrollEnabled={false} className="bg-bg" contentContainerStyle={{ paddingBottom: bottom }} onAccessibilityEscape={() => !locked && back()}>
        <SheetHeader title="Move to Cloud" onClose={back} locked={locked} />
        <View className="gap-3 px-5 pt-1">
          {thread.data ? (
            <Text numberOfLines={2} className="px-4 text-sm text-ink-3">
              {thread.data.title}
            </Text>
          ) : null}
          <Text className="px-4 text-md text-ink-2">
            {fromCheckout
              ? "Every uncommitted change in the checkout first moves into a new worktree on its own branch, including changes you or other conversations made. That worktree and the conversation’s session then go to a sandbox of its own, where its next message runs."
              : "Its worktree, uncommitted changes and session go to a sandbox of its own, where its next message runs. The worktree stays on the Mac and follows the sandbox."}
          </Text>
          {checking ? <Text className="px-4 text-sm text-ink-4">Checking what will move…</Text> : null}
          {fromCheckout && preview.data ? <MovingFiles files={preview.data.files} /> : null}
          {problem ? (
            <Text accessibilityRole="alert" className="px-4 text-sm text-bad">
              {problem}
            </Text>
          ) : null}
          <SheetPill label={locked ? "Moving…" : "Move"} dim={Boolean(blocked) || checking || !thread.data} running={locked} onPress={() => void submit()} />
        </View>
      </ScrollView>
    </>
  );
}
