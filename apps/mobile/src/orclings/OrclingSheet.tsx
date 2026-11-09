import type { OrclingProfile } from "@openorc/protocol";
import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { Pressable, View } from "react-native";
import Animated, { useAnimatedRef, useScrollOffset } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRpc } from "../client";
import { Card, Divider, Section } from "../settings/parts";
import { Markdown } from "../thread/Markdown";
import { HarnessLogo } from "../ui/HarnessLogo";
import { SheetHeader } from "../ui/SheetHeader";
import { Spinner } from "../ui/Spinner";
import { Text } from "../ui/Text";
import { CheckIns } from "./CheckIns";
import { OrclingFace } from "./OrclingFace";

const close = () => router.back();
/** Instructions taller than this fold to it until asked for the rest. */
const FOLDED_HEIGHT = 240;

/** What it runs on and how freely, as the Mac's profile says it: the model's name, then Allow or Approve. */
function useRunsOn(profile: OrclingProfile): string {
  const models = useRpc("agents.models", {}, { staleTime: 5 * 60_000 });
  const model = models.data?.find((each) => each.agent === profile.settings.agent && each.id === profile.settings.model)?.label ?? profile.settings.model;
  return `${model} · ${profile.permission === "allow" ? "Allow" : "Approve"}`;
}

function Hero({ profile }: { profile: OrclingProfile }) {
  return (
    <View className="items-center gap-2 pb-1">
      <OrclingFace look={profile.look} size={96} />
      <View className="flex-row items-center gap-1.5">
        <HarnessLogo agent={profile.settings.agent} size={13} />
        <Text className="text-sm text-ink-4">{useRunsOn(profile)}</Text>
      </View>
    </View>
  );
}

/** Its current instructions as the Markdown they are, folded when long with the rest one tap away. */
function Instructions({ text }: { text: string | null }) {
  const [open, setOpen] = useState(false);
  const [height, setHeight] = useState(0);
  const folds = height > FOLDED_HEIGHT;
  return (
    <Section title="Instructions">
      <Card>
        <View className="gap-2 px-4 py-3.5">
          {text ? (
            <View style={open ? undefined : { maxHeight: FOLDED_HEIGHT, overflow: "hidden" }}>
              {/* A heading's room above it is for one under a paragraph; at the card's top, as in a chat bubble, it goes. */}
              <View onLayout={(event) => setHeight(event.nativeEvent.layout.height)} className={/^\s*#/.test(text) ? "-mt-5" : undefined}>
                <Markdown text={text} streaming={false} />
              </View>
            </View>
          ) : (
            <Text className="text-md text-ink-4">None yet</Text>
          )}
          {text && folds ? (
            <Pressable accessibilityRole="button" onPress={() => setOpen((shown) => !shown)} hitSlop={8} className="self-start active:opacity-60">
              <Text className="text-sm text-ink-3">{open ? "Show less" : "Show all"}</Text>
            </Pressable>
          ) : null}
        </View>
      </Card>
    </Section>
  );
}

function Memories({ memories }: { memories: OrclingProfile["memories"] }) {
  return (
    <Section title="Memory">
      <Card>
        {memories.length ? (
          memories.map((memory, index) => (
            <View key={memory.id}>
              {index ? <Divider /> : null}
              <View className="gap-0.5 px-4 py-3">
                <Text className="text-md">{memory.title}</Text>
                <Text numberOfLines={3} className="text-sm text-ink-4">
                  {memory.body}
                </Text>
              </View>
            </View>
          ))
        ) : (
          <View className="px-4 py-3.5">
            <Text className="text-md text-ink-4">Nothing remembered yet</Text>
          </View>
        )}
      </Card>
    </Section>
  );
}

/**
 * An Orcling, opened from the pill in its chat: its face, what it runs on, when it checks in, its instructions and what
 * it remembers, as the Mac's profile shows them. Check-ins change here; the rest changes on the Mac.
 */
export function OrclingSheet() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const profile = useRpc("orclings.profile", { id });
  const insets = useSafeAreaInsets();
  const scroller = useAnimatedRef<Animated.ScrollView>();
  const scrollY = useScrollOffset(scroller);
  const data = profile.data;
  return (
    <Animated.ScrollView ref={scroller} className="flex-1 bg-bg" stickyHeaderIndices={[0]} contentContainerStyle={{ paddingBottom: insets.bottom + 24 }} onAccessibilityEscape={close}>
      <SheetHeader title={data?.name ?? ""} scrollY={scrollY} onClose={close} />
      {data ? (
        <View className="gap-7 px-5 pt-2">
          <Hero profile={data} />
          <CheckIns id={data.id} wakes={data.wakes} />
          <Instructions text={data.instructions} />
          <Memories memories={data.memories} />
        </View>
      ) : (
        <View className="items-center pt-16">{profile.error ? <Text className="px-8 text-center text-ink-3">{profile.error.message}</Text> : <Spinner />}</View>
      )}
    </Animated.ScrollView>
  );
}
