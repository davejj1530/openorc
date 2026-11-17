import { router } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Image, Pressable, ScrollView, useWindowDimensions, View, type ScrollViewInstance } from "react-native";
import { whatsNew } from "../client";
import { cn } from "../ui/cn";
import { useMode } from "../ui/mode";
import { useSheetBottom } from "../ui/sheet-bottom";
import { Text } from "../ui/Text";
import chatDark from "./pictures/chat-dark.webp";
import chatLight from "./pictures/chat-light.webp";
import cloudDark from "./pictures/cloud-dark.webp";
import cloudLight from "./pictures/cloud-light.webp";
import teamDark from "./pictures/team-dark.webp";
import teamLight from "./pictures/team-light.webp";

/** The pictures' own shape, as cut from the phone's screens. */
const PICTURE_RATIO = 990 / 855;

/** What the update brought, one thing a person can now do per step, each shown as the phone draws it. */
const steps = [
  {
    id: "cloud",
    title: "Threads that keep working with your Mac asleep",
    line: "Start a thread on OpenOrc Cloud from your phone and follow it while your Mac sleeps.",
    light: cloudLight,
    dark: cloudDark,
    alt: "An organization's cloud threads on Home, one of them working",
  },
  {
    id: "team",
    title: "Work with your team",
    line: "Read your organization's threads, write notes and tag the people in them.",
    light: teamLight,
    dark: teamDark,
    alt: "A note from Mara Okafor in a cloud thread, tagging Riley",
  },
  {
    id: "chat",
    title: "Chat with your team",
    line: "Talk with your organization in its conversations.",
    light: chatLight,
    dark: chatDark,
    alt: "A team conversation with messages from Mara Okafor",
  },
] as const;

const close = () => router.back();

/** The steps on what the update brought, a page each, swiped or stepped with Next; however the sheet goes, they are settled. */
export function WhatsNewSheet() {
  const { width } = useWindowDimensions();
  const bottom = useSheetBottom(16);
  const mode = useMode();
  const pager = useRef<ScrollViewInstance>(null);
  const [page, setPage] = useState(0);
  useEffect(() => () => whatsNew.close(), []);
  const last = page === steps.length - 1;
  const next = () => {
    if (last) return close();
    pager.current?.scrollTo({ x: (page + 1) * width, animated: true });
    setPage(page + 1);
  };
  return (
    <View className="bg-bg pt-8" style={{ paddingBottom: bottom }} onAccessibilityEscape={close}>
      <ScrollView ref={pager} horizontal pagingEnabled showsHorizontalScrollIndicator={false} onMomentumScrollEnd={(event) => setPage(Math.round(event.nativeEvent.contentOffset.x / width))}>
        {steps.map((step) => (
          <View key={step.id} style={{ width }} className="gap-5 px-5">
            <View className="overflow-hidden rounded-3xl border border-line">
              <Image source={mode === "dark" ? step.dark : step.light} accessibilityLabel={step.alt} style={{ width: "100%", aspectRatio: PICTURE_RATIO }} />
            </View>
            <View className="gap-1.5 px-1">
              <Text accessibilityRole="header" className="text-xl">
                {step.title}
              </Text>
              <Text className="text-md text-ink-3">{step.line}</Text>
            </View>
          </View>
        ))}
      </ScrollView>
      <View className="mt-6 flex-row items-center justify-between px-6">
        <View accessibilityLabel={`Step ${page + 1} of ${steps.length}`} className="flex-row items-center gap-1.5">
          {steps.map((step, index) => (
            <View key={step.id} className={cn("h-1.5 w-1.5 rounded-full bg-ink-4", index === page && "w-4 bg-ink")} />
          ))}
        </View>
        <Pressable accessibilityRole="button" onPress={next} className="h-touch items-center justify-center rounded-full bg-accent px-6 active:opacity-80">
          <Text className="text-md text-accent-fg">{last ? "Done" : "Next"}</Text>
        </Pressable>
      </View>
    </View>
  );
}
