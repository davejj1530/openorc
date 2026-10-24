import { Link } from "expo-router";
import { useState } from "react";
import { Pressable, View, type TextProps } from "react-native";
import { useAnimatedReaction, type SharedValue } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { lostWords, type LinkTone } from "../../connection/link-words";
import type { LinkState, LostMac } from "../../connection/manager";
import { useLinkWords } from "../../connection/use-link-words";
import { cn } from "../../ui/cn";
import { LinkDot } from "../../ui/LinkDot";
import { Text } from "../../ui/Text";

type Paired = Exclude<LinkState, { kind: "unpaired" }>;

export interface HomeScroll {
  /** How far the list has scrolled, in points from its top. */
  scrollY: SharedValue<number>;
  /** Where the Mac line's words end in the list, so the bar knows when they have gone under it. */
  lineBottom: SharedValue<number>;
}

/** What Home says about the Mac it shows: how the phone stands with it. */
export interface MacLineWords {
  tone: LinkTone;
  /** The Mac's name; truncates first. */
  name: string;
  /** How the phone reaches it or what is in the way; never truncated. */
  status: string | null;
  /** The link is not healthy, so the status speaks up. */
  trouble: boolean;
  label: string;
}

export function useMacLine(state: Paired): MacLineWords {
  const words = useLinkWords(state);
  const { name } = state.mac;
  return { tone: words.tone, name, status: words.status, trouble: words.tone !== "ok", label: `${name}, ${words.spoken}` };
}

/** Whether the Mac line has scrolled under the bar, told once per crossing rather than on every frame. */
export function useLineUnder({ scrollY, lineBottom }: HomeScroll): boolean {
  const [under, setUnder] = useState(false);
  useAnimatedReaction(
    () => scrollY.value >= lineBottom.value,
    (now, before) => {
      if (now !== before) scheduleOnRN(setUnder, now);
    },
  );
  return under;
}

/** The status after the Mac's name, in ink-4 while healthy and a step stronger while not. */
export function StatusWords({ status, trouble, className, ...text }: TextProps & { status: string; trouble: boolean }) {
  return (
    <Text numberOfLines={1} className={cn("text-sm text-ink-4", trouble && "text-ink-2", className)} {...text}>
      {status}
    </Text>
  );
}

/** List headers draw over the rows, so the line's touch can run on through the first row's top margin. */
export const lineOverRows = { zIndex: 1 };

/**
 * The Mac Home shows, on the line under the wordmark, scrolling with the rows. It always holds text, so its words
 * changing never moves a row. It reads as a list row: the dot in the 16 pt glyph column, the words where row titles
 * start. A tap opens Settings, where the Mac's row says more. The touch is as wide as the words and runs from the bar
 * down to the first row, over that row's top margin (`lineOverRows`), so rows stay where they are; at the default text
 * size that is 32 pt. Once the line has gone under the bar, the bar says the same, so VoiceOver skips this one.
 */
export function MacLine({ state, scrollY, lineBottom }: HomeScroll & { state: Paired }) {
  const line = useMacLine(state);
  const under = useLineUnder({ scrollY, lineBottom });
  return (
    <View accessibilityElementsHidden={under} importantForAccessibility={under ? "no-hide-descendants" : "auto"} className="-mb-3 px-5">
      <Link href="/settings" asChild>
        <Pressable accessibilityRole="button" accessibilityLabel={line.label} className="self-start pb-4 active:opacity-60">
          <View
            className="flex-row items-center gap-2"
            onLayout={(event) => {
              const { y, height } = event.nativeEvent.layout;
              lineBottom.value = y + height;
            }}
          >
            <View className="w-4 items-center">
              <LinkDot tone={line.tone} />
            </View>
            <View className="shrink flex-row">
              <Text numberOfLines={1} className="shrink text-sm text-ink-4">
                {line.name}
              </Text>
              {line.status ? (
                <Text className="text-sm text-ink-4">
                  {" · "}
                  <StatusWords status={line.status} trouble={line.trouble} />
                </Text>
              ) : null}
            </View>
          </View>
        </Pressable>
      </Link>
    </View>
  );
}

/** With no Mac: why the last one went, when the person did not forget it, with no dot, as there is no link to show. */
export function LostLine({ lost }: { lost: LostMac }) {
  return (
    <View className="px-5 pb-1">
      <Text className="text-sm text-ink-2">{lostWords[lost.why](lost.macName)}</Text>
    </View>
  );
}
