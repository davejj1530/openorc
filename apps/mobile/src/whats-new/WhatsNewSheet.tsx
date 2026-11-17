import { router } from "expo-router";
import { useEffect, useState } from "react";
import { Image, Pressable, useWindowDimensions, View } from "react-native";
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
/** The room either side of a page. */
const SIDE = 20;

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

/** The steps on what the update brought, one at a time, stepped with Next or the dots; however the sheet goes, they are settled. */
export function WhatsNewSheet() {
  const { width } = useWindowDimensions();
  const bottom = useSheetBottom(16);
  const mode = useMode();
  const [page, setPage] = useState(0);
  useEffect(() => () => whatsNew.close(), []);
  const step = steps[page]!;
  const last = page === steps.length - 1;
  // A sheet sizes to its content, so the picture takes a size of its own, not a share of a width still unknown.
  const picture = { width: width - 2 * SIDE, height: (width - 2 * SIDE) / PICTURE_RATIO };
  return (
    <View className="gap-5 bg-bg pt-8" style={{ paddingHorizontal: SIDE, paddingBottom: bottom }} onAccessibilityEscape={close}>
      <View className="overflow-hidden rounded-3xl border border-line">
        <Image source={mode === "dark" ? step.dark : step.light} accessibilityLabel={step.alt} style={picture} />
      </View>
      <View className="gap-1.5 px-1">
        <Text accessibilityRole="header" className="text-xl">
          {step.title}
        </Text>
        {/* Two lines kept for every step's line, so the sheet stays one height from step to step. */}
        <Text className="min-h-11 text-md text-ink-3">{step.line}</Text>
      </View>
      <View className="mt-1 flex-row items-center justify-between pl-1">
        <View className="flex-row items-center">
          {steps.map((each, index) => (
            <Pressable
              key={each.id}
              accessibilityRole="button"
              accessibilityLabel={each.title}
              accessibilityState={{ selected: index === page }}
              onPress={() => setPage(index)}
              hitSlop={6}
              className="p-1"
            >
              <View className={cn("h-1.5 w-1.5 rounded-full bg-ink-4", index === page && "w-4 bg-ink")} />
            </Pressable>
          ))}
        </View>
        <Pressable accessibilityRole="button" onPress={() => (last ? close() : setPage(page + 1))} className="h-touch items-center justify-center rounded-full bg-accent px-6 active:opacity-80">
          <Text className="text-md text-accent-fg">{last ? "Done" : "Next"}</Text>
        </Pressable>
      </View>
    </View>
  );
}
