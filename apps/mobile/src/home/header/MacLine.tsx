import { View, type TextProps } from "react-native";
import type { SharedValue } from "react-native-reanimated";
import { lostWords, type LinkTone } from "../../connection/link-words";
import type { LinkState, LostMac } from "../../connection/manager";
import { useLinkWords } from "../../connection/use-link-words";
import { cn } from "../../ui/cn";
import { Text } from "../../ui/Text";

type Paired = Exclude<LinkState, { kind: "unpaired" }>;

export interface HomeScroll {
  /** How far the list has scrolled, in points from its top. */
  scrollY: SharedValue<number>;
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

/** The status after the Mac's name, in ink-4 while healthy and a step stronger while not. */
export function StatusWords({ status, trouble, className, ...text }: TextProps & { status: string; trouble: boolean }) {
  return (
    <Text numberOfLines={1} className={cn("text-detail text-ink-4", trouble && "text-ink-2", className)} {...text}>
      {status}
    </Text>
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
