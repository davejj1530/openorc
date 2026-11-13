import type { OrclingLook, OrclingLookPart, OrclingProfile } from "@openorc/protocol";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { Alert, View } from "react-native";
import { useRpc } from "../client";
import { SheetPill } from "../changes/SheetParts";
import { haptic } from "../ui/haptics";
import { SheetHeader } from "../ui/SheetHeader";
import { Spinner } from "../ui/Spinner";
import { Text } from "../ui/Text";
import { LookColors, Options, PADDING, PartTabs } from "./LookPicker";
import { OrclingMotion, seedOf } from "./OrclingMotion";
import { PinnedSheet } from "./PinnedSheet";
import { useOrclingEdit } from "./orcling-edit";

const back = () => router.back();
const sameLook = (a: OrclingLook, b: OrclingLook) => (Object.keys(a) as (keyof OrclingLook)[]).every((key) => a[key] === b[key]);

/**
 * An Orcling's look, as its designer on the Mac changes it: the face at the top moves as it would on the Orclings
 * list, one part's choices at a time below it, then its colors. Nothing saves until Save, and leaving with changes asks.
 */
function LookEditor({ profile }: { profile: OrclingProfile }) {
  const { save } = useOrclingEdit(profile);
  const [look, setLook] = useState(profile.look);
  const [part, setPart] = useState<OrclingLookPart>("shape");
  const [saving, setSaving] = useState(false);
  const changed = !sameLook(look, profile.look);
  const close = () =>
    changed
      ? Alert.alert("Discard this look?", undefined, [
          { text: "Keep editing", style: "cancel" },
          { text: "Discard", style: "destructive", onPress: back },
        ])
      : back();
  const submit = () => {
    if (!changed || saving) return;
    setSaving(true);
    void save({ look }).then((saved) => {
      setSaving(false);
      if (!saved) return;
      haptic.confirm();
      back();
    });
  };
  return (
    <PinnedSheet
      onAccessibilityEscape={close}
      top={
        <>
          <Stack.Screen options={{ gestureEnabled: !changed && !saving }} />
          <SheetHeader title="Look" onClose={close} locked={saving} />
          <View className="items-center pb-4">
            <OrclingMotion look={look} size={148} seed={seedOf(profile.id)} mood="rest" paused={false} />
          </View>
          <PartTabs part={part} onPick={setPart} />
        </>
      }
      footer={<SheetPill label={saving ? "Saving…" : "Save"} dim={!changed} running={saving} onPress={submit} />}
      contentContainerStyle={{ padding: PADDING, gap: 24 }}
    >
      <Options look={look} part={part} onChange={setLook} />
      <LookColors look={look} part={part} onChange={setLook} />
    </PinnedSheet>
  );
}

/** Changing an Orcling's look, over its profile. */
export function LookSheet() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const profile = useRpc("orclings.profile", { id });
  if (profile.data) return <LookEditor profile={profile.data} />;
  return (
    <View className="flex-1 bg-bg">
      <SheetHeader title="Look" onClose={back} />
      <View className="flex-1 items-center justify-center px-8">{profile.error ? <Text className="text-center text-ink-3">{profile.error.message}</Text> : <Spinner />}</View>
    </View>
  );
}
