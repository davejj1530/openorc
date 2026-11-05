import { Link } from "expo-router";
import { useState } from "react";
import { Pressable, View, type TextProps } from "react-native";
import { useAnimatedReaction, type SharedValue } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { lostWords, type LinkTone } from "../../connection/link-words";
import type { LinkState, LostMac } from "../../connection/manager";
import { useLinkWords } from "../../connection/use-link-words";
import { Cloud, Laptop } from "../../generated/icons";
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
    <Text numberOfLines={1} className={cn("text-detail text-ink-4", trouble && "text-ink-2", className)} {...text}>
      {status}
    </Text>
  );
}

/** List headers draw over the rows, so the line's touch can run on through the first row's top margin. */
export const lineOverRows = { zIndex: 1 };

/** A Mac, or a Mac's cloud brain. */
export type HostKind = "mac" | "brain";

/** How a host's heading says the phone stands with it: spelled out, as the name is on a line of its own. */
export interface HostLink {
  tone: LinkTone;
  /** Empty while a quick connect holds its words back, so the line keeps its height. */
  status: string;
  trouble: boolean;
  label: string;
}

export function useHostLink(state: LinkState, name: string): HostLink {
  const words = useLinkWords(state);
  const quiet = state.kind === "connecting" && words.status === null;
  const status = state.kind === "connected" ? words.spoken : (words.status ?? (quiet ? "" : words.spoken));
  return { tone: words.tone, status, trouble: words.tone !== "ok", label: `${name}, ${words.spoken}` };
}

/**
 * A host's threads open under its heading while Home lists a Mac and its cloud brain together, so which one this phone
 * is connected to reads at a glance: the mark and name on the lead and text columns, and under them the link's dot and
 * how the phone reaches it.
 */
export function HostHeading({ kind, name, link }: { kind: HostKind; name: string; link: HostLink }) {
  const Mark = kind === "brain" ? Cloud : Laptop;
  return (
    <View className="gap-0.5">
      <View className="flex-row items-center gap-3">
        <View className="w-7 items-center">
          <Mark size={22} className="text-ink-4" />
        </View>
        <Text numberOfLines={1} className="shrink text-title-sm">
          {name}
        </Text>
      </View>
      <View className="flex-row items-center gap-3">
        <View className="w-7 items-center">
          <LinkDot tone={link.tone} />
        </View>
        <StatusWords status={link.status} trouble={link.trouble} className="shrink" />
      </View>
    </View>
  );
}

/**
 * The Mac Home shows, on the line under the wordmark, scrolling with the rows; with its cloud brain or Mac listed
 * below, its heading in the same form as that one's (`host`). It always holds text, so its words changing never moves
 * a row. It sits on Home's grid: the dot in the lead column under the wordmark's cube, the words where the name and
 * row titles start. A tap opens Settings, where the Mac's row says more. The touch is as wide as the words and runs
 * from the bar down to the first row, over that row's top margin (`lineOverRows`), so rows stay where they are. Once
 * the line has gone under the bar, the bar says the same, so VoiceOver skips this one.
 */
export function MacLine({ state, host, scrollY, lineBottom }: HomeScroll & { state: Paired; host?: HostKind | null }) {
  const line = useMacLine(state);
  const link = useHostLink(state, line.name);
  const under = useLineUnder({ scrollY, lineBottom });
  return (
    <View accessibilityElementsHidden={under} importantForAccessibility={under ? "no-hide-descendants" : "auto"} className="-mb-3 px-5">
      <Link href="/settings" asChild>
        <Pressable accessibilityRole="button" accessibilityLabel={line.label} className={cn("self-start pb-4 active:opacity-60", host ? "pt-4" : "pt-2")}>
          <View
            className={host ? undefined : "flex-row items-center gap-3"}
            onLayout={(event) => {
              const { y, height } = event.nativeEvent.layout;
              lineBottom.value = y + height;
            }}
          >
            {host ? (
              <HostHeading kind={host} name={line.name} link={link} />
            ) : (
              <>
                <View className="w-7 items-center">
                  <LinkDot tone={line.tone} />
                </View>
                <View className="shrink flex-row">
                  <Text numberOfLines={1} className="shrink text-detail text-ink-4">
                    {line.name}
                  </Text>
                  {line.status ? (
                    <Text className="text-detail text-ink-4">
                      {" · "}
                      <StatusWords status={line.status} trouble={line.trouble} />
                    </Text>
                  ) : null}
                </View>
              </>
            )}
          </View>
        </Pressable>
      </Link>
    </View>
  );
}

/** With no Mac: why the last one went, when the person did not forget it, with no dot, as there is no link to show. */
export function LostLine({ lost }: { lost: LostMac }) {
  return (
    <View className="pb-1 pl-15 pr-5">
      <Text className="text-detail text-ink-2">{lostWords[lost.why](lost.macName)}</Text>
    </View>
  );
}
