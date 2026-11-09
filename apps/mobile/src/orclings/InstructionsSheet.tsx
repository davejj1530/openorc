import type { OrclingProfile } from "@openorc/protocol";
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
import { profileKey } from "./orcling-edit";

const back = () => router.back();
/** The Mac's limit on one version of an Orcling's instructions. */
const INSTRUCTIONS_MAX = 20_000;

/**
 * An Orcling's instructions as the Markdown they are stored as, in a field that fills the sheet above the keyboard.
 * Saving adds a version, as on the Mac; saving over instructions that changed meanwhile, on the Mac or by the Orcling
 * itself, asks first, and leaving with changes asks too.
 */
function InstructionsEditor({ profile }: { profile: OrclingProfile }) {
  const { id, name } = profile;
  // The instructions the edit starts from: the ones shown when the sheet opened.
  const [base] = useState(profile.instructions ?? "");
  const [text, setText] = useState(base);
  const queryClient = useQueryClient();
  const save = useRpcMutation("orclings.instructions.save");
  const latest = useRpc("orclings.profile", { id }).data?.instructions ?? "";
  const insets = useSafeAreaInsets();
  const keyboard = useKeyboardState((state) => (state.isVisible ? state.height : 0));
  const saving = save.isPending;
  const changed = text !== base;
  const close = () =>
    changed
      ? Alert.alert("Discard your changes?", undefined, [
          { text: "Keep editing", style: "cancel" },
          { text: "Discard", style: "destructive", onPress: back },
        ])
      : back();
  const send = () =>
    save.mutate(
      { id, body: text },
      {
        onSuccess: (saved) => {
          queryClient.setQueryData<OrclingProfile>(profileKey(id), (shown) => shown && { ...shown, instructions: saved.body });
          haptic.confirm();
          back();
        },
        onError: () => haptic.warn(),
      },
    );
  const submit = () => {
    if (saving || !changed) return;
    if (latest === base) return send();
    Alert.alert(`${name}’s instructions changed`, "Saving replaces the newer instructions with yours.", [
      { text: "Cancel", style: "cancel" },
      { text: "Replace", style: "destructive", onPress: send },
    ]);
  };
  return (
    <View className="flex-1 bg-bg" onAccessibilityEscape={close}>
      <Stack.Screen options={{ gestureEnabled: !changed && !saving }} />
      <SheetHeader title="Instructions" onClose={close} locked={saving} />
      <View className="flex-1 gap-3 px-5 pt-1" style={{ paddingBottom: 16 + (keyboard || insets.bottom) }}>
        <View className="flex-1 overflow-hidden rounded-2xl bg-surface">
          <TextInput
            multiline
            autoFocus={!base}
            editable={!saving}
            value={text}
            onChangeText={(typed) => setText(typed.replace(/\r\n?/g, "\n"))}
            maxLength={INSTRUCTIONS_MAX}
            placeholder={`Who ${name} is and how it works with you`}
            placeholderTextColorClassName="accent-ink-4"
            accessibilityLabel={`${name}’s instructions`}
            textAlignVertical="top"
            className="flex-1 px-4 py-3 font-sans text-lg text-ink"
          />
        </View>
        {save.error ? (
          <Text accessibilityRole="alert" className="px-4 text-sm text-bad">
            {save.error.message}
          </Text>
        ) : null}
        <SheetPill label={saving ? "Saving…" : "Save"} dim={!changed} running={saving} onPress={submit} />
      </View>
    </View>
  );
}

/** Rewriting an Orcling's instructions, over its profile. */
export function InstructionsSheet() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const profile = useRpc("orclings.profile", { id });
  if (profile.data) return <InstructionsEditor profile={profile.data} />;
  return (
    <View className="flex-1 bg-bg">
      <SheetHeader title="Instructions" onClose={back} />
      <View className="flex-1 items-center justify-center px-8">{profile.error ? <Text className="text-center text-ink-3">{profile.error.message}</Text> : <Spinner />}</View>
    </View>
  );
}
