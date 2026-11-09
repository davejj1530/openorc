import { useQueryClient } from "@tanstack/react-query";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { Alert, TextInput, View } from "react-native";
import { useKeyboardState } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRpc, useRpcMutation } from "../client";
import { SheetPill } from "../changes/SheetParts";
import { haptic } from "../ui/haptics";
import { SheetHeader } from "../ui/SheetHeader";
import { Spinner } from "../ui/Spinner";
import { Text } from "../ui/Text";
import { descriptionDrafts, taskKey } from "./task-edit";

const back = () => router.back();

/**
 * A task's description as the text it is stored as, Markdown and all, in a field that fills the sheet above the
 * keyboard. What is written stays as a draft until it is saved; saving over a description the Mac changed meanwhile
 * asks first.
 */
function DescriptionEditor({ id, spec }: { id: string; spec: string | null }) {
  // The description the edit starts from: the one shown when the sheet opened.
  const [base] = useState(spec ?? "");
  const queryClient = useQueryClient();
  const update = useRpcMutation("tasks.update");
  const latest = useRpc("tasks.get", { id }).data?.spec ?? "";
  const [text, setText] = useState(() => descriptionDrafts.get(id, base) ?? base);
  const insets = useSafeAreaInsets();
  const keyboard = useKeyboardState((state) => (state.isVisible ? state.height : 0));
  const saving = update.isPending;
  const write = (typed: string) => {
    setText(typed);
    descriptionDrafts.set(id, base, typed);
  };
  const send = () =>
    update.mutate(
      { id, patch: { spec: text.trim() ? text : null } },
      {
        onSuccess: (saved) => {
          queryClient.setQueryData(taskKey(id), saved);
          descriptionDrafts.clear(id);
          haptic.confirm();
          back();
        },
        onError: () => haptic.warn(),
      },
    );
  const save = () => {
    if (saving || text === base) return;
    if (latest === base) return send();
    Alert.alert("This description changed on your Mac", "Saving replaces the newer description with yours.", [
      { text: "Cancel", style: "cancel" },
      { text: "Replace", style: "destructive", onPress: send },
    ]);
  };
  return (
    <View className="flex-1 gap-3 px-5 pt-1" style={{ paddingBottom: 16 + (keyboard || insets.bottom) }}>
      <Stack.Screen options={{ gestureEnabled: !saving }} />
      <View className="flex-1 overflow-hidden rounded-2xl bg-surface">
        <TextInput
          multiline
          autoFocus={!base}
          editable={!saving}
          value={text}
          onChangeText={write}
          placeholder="What this task is, and how to know it is done"
          placeholderTextColorClassName="accent-ink-4"
          accessibilityLabel="Task description"
          textAlignVertical="top"
          className="flex-1 px-4 py-3 font-sans text-lg text-ink"
        />
      </View>
      {update.error ? (
        <Text accessibilityRole="alert" className="px-4 text-sm text-bad">
          {update.error.message}
        </Text>
      ) : null}
      <SheetPill label={saving ? "Saving…" : "Save"} dim={text === base} running={saving} onPress={save} />
    </View>
  );
}

/** Editing one task's description, over its screen. */
export function TaskDescriptionSheet() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const task = useRpc("tasks.get", { id });
  return (
    <View className="flex-1 bg-bg">
      <SheetHeader title="Description" onClose={back} />
      {task.data ? (
        <DescriptionEditor id={id} spec={task.data.spec} />
      ) : (
        <View className="flex-1 items-center justify-center">
          {task.isLoading ? <Spinner /> : <Text className="text-lg text-ink-3">{task.error?.message ?? "This task is no longer available."}</Text>}
        </View>
      )}
    </View>
  );
}
