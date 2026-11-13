import { Button, Host, Image, Menu, RNHostView } from "@expo/ui/swift-ui";
import { accessibilityAddTraits, accessibilityLabel, frame, glassEffect, onTapGesture } from "@expo/ui/swift-ui/modifiers";
import { useEffect, type ComponentType, type ReactNode } from "react";
import { Pressable, StyleSheet, useWindowDimensions, View } from "react-native";
import { GestureDetector, usePanGesture } from "react-native-gesture-handler";
import Animated, { useAnimatedStyle, useSharedValue, withSpring, type SharedValue } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { ListChecks, MessageSquare, Orclings, Plus } from "../generated/icons";
import { motion } from "../generated/tokens";
import { GlassCapsule, liquidGlass } from "../ui/Glass";
import { haptic } from "../ui/haptics";
import type { IconProps } from "../ui/icon";
import { useColors, useMode } from "../ui/mode";
import { useReducedMotion } from "../ui/reduced-motion";
import { Text } from "../ui/Text";
import type { NewAction } from "./new-action";

export type HomeTab = "threads" | "orclings" | "tasks";

/** The bar's height: the tabs' capsule and New, side by side. */
export const BAR_HEIGHT = 62;
/** The bar and the 8 under it, which a list keeps clear at its end. */
export const BOTTOM_BAR_ROOM = BAR_HEIGHT + 8;

const TABS: { tab: HomeTab; label: string; icon: ComponentType<IconProps> }[] = [
  { tab: "threads", label: "Threads", icon: MessageSquare },
  { tab: "orclings", label: "Orclings", icon: Orclings },
  { tab: "tasks", label: "Tasks", icon: ListChecks },
];

/** The capsule's inset around its tabs, New's distance from the trailing edge, and the least room between the two. */
const INSET = 4;
const SIDE = 16;
const GAP = 24;
const TAB_MIN = 52;
const TAB_MAX = 74;
const GLYPH = 26;
/** How much the lens grows past the platter while held, rising over the bar's edges as iOS's tab bar lens does. */
const LIFT = 0.3;
/** How much the glyph under the lens grows with it. */
const MAGNIFY = 0.16;

/** How the platter settles: a spring that starts from rest and settles with a touch of give, as iOS moves a selection. */
const GLIDE = { duration: motion.duration.swap, dampingRatio: 0.82 };
/** Quicker and livelier, for the lens rising under the finger. */
const RISE = { duration: motion.duration.arrive, dampingRatio: 0.62 };

/** Threads always, then Orclings and Tasks where the Mac has them; one tab alone is no bar. */
export const homeTabs = ({ orclings, tasks }: { orclings: boolean; tasks: boolean }): HomeTab[] => ["threads", ...(orclings ? (["orclings"] as const) : []), ...(tasks ? (["tasks"] as const) : [])];

/** Each tab's width: as wide as fits with the tabs centered on the screen and New clear of them at the trailing edge. */
export function tabWidth(screen: number, count: number): number {
  const room = screen - 2 * (SIDE + BAR_HEIGHT + GAP) - 2 * INSET;
  return Math.max(TAB_MIN, Math.min(TAB_MAX, Math.floor(room / Math.max(1, count))));
}

/** Where the lens sits for a touch `px` across the capsule: centered under the finger, kept over the tabs. */
export function lensAt(px: number, width: number, count: number): number {
  "worklet";
  return Math.min(Math.max(px - INSET - width / 2, 0), (count - 1) * width);
}

/** The tab under a touch `px` across the capsule. */
export function tabAt(px: number, width: number, count: number): number {
  "worklet";
  return Math.min(Math.max(Math.floor((px - INSET) / width), 0), count - 1);
}

/** How near the lens at `x` is to tab `at`: 1 right over it, 0 a tab or more away. */
function nearness(x: number, at: number, width: number): number {
  "worklet";
  return Math.max(0, 1 - Math.abs(x - at * width) / width);
}

/** The lens: where it is across the tabs, how far it has risen, and whether it shows at all. */
interface Lens {
  x: SharedValue<number>;
  held: SharedValue<number>;
  lifted: SharedValue<number>;
}

/** A tab's glyph, in ink where the lens is over it and growing with it while held; muted elsewhere. */
function Glyph({ at, width, lens, icon: Icon, badge }: { at: number; width: number; lens: Lens; icon: ComponentType<IconProps>; badge: number }) {
  const grow = useAnimatedStyle(() => ({ transform: [{ scale: 1 + MAGNIFY * lens.held.value * nearness(lens.x.value, at, width) }] }));
  const ink = useAnimatedStyle(() => ({ opacity: nearness(lens.x.value, at, width) }));
  return (
    <Animated.View style={grow}>
      <Icon size={GLYPH} className="text-ink-3" />
      <Animated.View style={[StyleSheet.absoluteFill, ink]}>
        <Icon size={GLYPH} className="text-ink" />
      </Animated.View>
      {badge ? (
        <View className="absolute -right-3 -top-1.5 h-4.5 min-w-4.5 items-center justify-center rounded-full bg-ink px-1">
          <Text className="text-xs tabular-nums text-bg">{badge}</Text>
        </View>
      ) : null}
    </Animated.View>
  );
}

/** The chosen tab's quiet platter at rest, hidden while the lens is up. */
function Platter({ width, lens }: { width: number; lens: Lens }) {
  const ink = useColors().ink;
  const style = useAnimatedStyle(() => ({ opacity: 1 - lens.lifted.value, transform: [{ translateX: lens.x.value }] }));
  // The ink at 8%, so the platter reads on glass in either appearance and with any Mac's palette.
  return <Animated.View pointerEvents="none" className="absolute rounded-full" style={[{ top: INSET, left: INSET, width, height: BAR_HEIGHT - 2 * INSET, backgroundColor: `${ink}14` }, style]} />;
}

/**
 * The glass lens that rises from the platter under a finger and follows it across the tabs. It sits under the glyphs:
 * glass over glass frosts what it covers, so the glyph under it is drawn on top, grown and in ink, as iOS's lens shows it.
 */
function LensView({ width, lens }: { width: number; lens: Lens }) {
  const style = useAnimatedStyle(() => ({ opacity: lens.lifted.value, transform: [{ translateX: lens.x.value }, { scale: 1 + LIFT * lens.held.value }] }));
  return (
    <Animated.View pointerEvents="none" className="absolute" style={[{ top: INSET, left: INSET, width, height: BAR_HEIGHT - 2 * INSET }, style]}>
      <GlassCapsule variant="clear" fallback="bg-surface-3" />
    </Animated.View>
  );
}

/**
 * The lens as a finger moves it: it rises under the touch, follows a drag tab to tab with a tick at each, and on release
 * settles on the tab under it, which is then chosen. A touch the system takes away settles back on the tab it was on.
 */
function useLens({ index, width, count, onPick }: { index: number; width: number; count: number; onPick: (at: number) => void }) {
  const still = useReducedMotion();
  const lens: Lens = { x: useSharedValue(index * width), held: useSharedValue(0), lifted: useSharedValue(0) };
  const chosen = useSharedValue(index);
  const hovered = useSharedValue(index);
  const cancelled = useSharedValue(false);
  const { x, held, lifted } = lens;
  useEffect(() => {
    chosen.value = index;
    if (lifted.value) return;
    x.value = still ? index * width : withSpring(index * width, GLIDE);
  }, [index, width, still, chosen, lifted, x]);
  const tick = () => haptic.select();
  const hover = (px: number) => {
    "worklet";
    const at = tabAt(px, width, count);
    if (at === hovered.value) return;
    hovered.value = at;
    scheduleOnRN(tick);
  };
  const settle = (at: number) => {
    "worklet";
    x.value = still ? at * width : withSpring(at * width, GLIDE);
    if (still) {
      held.value = 0;
      lifted.value = 0;
      return;
    }
    held.value = withSpring(0, GLIDE, (done) => {
      // A new touch before it settles keeps the lens up.
      if (done) lifted.value = 0;
    });
  };
  const gesture = usePanGesture({
    minDistance: 0,
    onBegin: (event) => {
      "worklet";
      cancelled.value = false;
      hovered.value = chosen.value;
      lifted.value = 1;
      held.value = still ? 1 : withSpring(1, RISE);
      x.value = still ? lensAt(event.x, width, count) : withSpring(lensAt(event.x, width, count), RISE);
      hover(event.x);
    },
    onUpdate: (event) => {
      "worklet";
      x.value = lensAt(event.x, width, count);
      hover(event.x);
    },
    onTouchesCancel: () => {
      "worklet";
      cancelled.value = true;
    },
    onFinalize: () => {
      "worklet";
      const at = cancelled.value ? chosen.value : hovered.value;
      settle(at);
      if (!cancelled.value) scheduleOnRN(onPick, at);
    },
  });
  return { lens, gesture };
}

/** A tab's place on the capsule, named for VoiceOver, which chooses it with a double tap; fingers go to the lens. */
function Tab({ label, selected, badge, width, onVoice, children }: { label: string; selected: boolean; badge: number; width: number; onVoice: () => void; children: ReactNode }) {
  return (
    <View
      accessible
      accessibilityRole="tab"
      accessibilityLabel={badge ? `${label}, ${badge} need you` : label}
      accessibilityState={{ selected }}
      onAccessibilityTap={onVoice}
      style={{ width, height: BAR_HEIGHT - 2 * INSET }}
      className="items-center justify-center"
    >
      {children}
    </View>
  );
}

/**
 * New's face: a circle of the tabs' own glass at the bar's height, with the plus in ink, so the bar reads as one set of
 * glass; it springs under a press. Without Liquid Glass, the capsule's plane fill.
 */
function NewFace({ press }: { press?: { label: string; onPress: () => void } }) {
  const colors = useColors();
  if (!liquidGlass)
    return (
      <View pointerEvents="none" style={{ width: BAR_HEIGHT, height: BAR_HEIGHT }} className="items-center justify-center rounded-full bg-surface">
        <Plus size={GLYPH} className="text-ink" />
      </View>
    );
  return (
    <Image
      systemName="plus"
      size={24}
      color={colors.ink}
      modifiers={[
        frame({ width: BAR_HEIGHT, height: BAR_HEIGHT }),
        glassEffect({ glass: { variant: "regular", interactive: true }, shape: "circle" }),
        ...(press ? [onTapGesture(press.onPress), accessibilityLabel(press.label), accessibilityAddTraits(["isButton"])] : []),
      ]}
    />
  );
}

/**
 * New at the trailing edge, doing what the tab in front starts: one thing at a tap, or a menu that opens from it, as
 * iOS opens a glass button's menu.
 */
function NewButton({ action }: { action: NewAction }) {
  const mode = useMode();
  if (action.kind === "menu")
    return (
      <Host matchContents colorScheme={mode}>
        <Menu
          modifiers={[accessibilityLabel(action.label)]}
          label={
            liquidGlass ? (
              <NewFace />
            ) : (
              <RNHostView matchContents>
                <NewFace />
              </RNHostView>
            )
          }
        >
          {action.items.map((item) => (
            <Button key={item.label} label={item.label} systemImage={item.icon} onPress={item.onPress} />
          ))}
        </Menu>
      </Host>
    );
  if (!liquidGlass)
    return (
      <Pressable accessibilityRole="button" accessibilityLabel={action.label} onPress={action.onPress} className="rounded-full active:opacity-80">
        <NewFace />
      </Pressable>
    );
  return (
    <Host matchContents colorScheme={mode}>
      <NewFace press={action} />
    </Host>
  );
}

/**
 * Home's floating bar: the tabs as glyphs on one Liquid Glass capsule centered on the screen, and New at the trailing
 * edge as a round glass button that starts what the tab in front makes (`action`). The chosen tab sits on a quiet platter; a touch
 * raises a glass lens from it that can be held and slid across the tabs, choosing the one it is let go over. `badge`
 * counts the Orclings that need the person, for when their faces are not on Threads. Without Liquid Glass the capsule
 * takes the plane's fill.
 */
export function BottomBar({ tab, tabs, onTab, badge, action }: { tab: HomeTab; tabs: readonly HomeTab[]; onTab: (tab: HomeTab) => void; badge: number; action: NewAction }) {
  const shown = TABS.filter((each) => tabs.includes(each.tab));
  const width = tabWidth(useWindowDimensions().width, shown.length);
  const index = Math.max(
    0,
    shown.findIndex((each) => each.tab === tab),
  );
  // The lens ticked on its way, so a choice by touch makes no second tick; VoiceOver's does.
  const pick = (at: number) => {
    const next = shown[at]?.tab;
    if (next && next !== tab) onTab(next);
  };
  const { lens, gesture } = useLens({ index, width, count: shown.length, onPick: pick });
  return (
    <View className="mb-2 justify-center self-stretch" style={{ height: BAR_HEIGHT }}>
      <GestureDetector gesture={gesture}>
        <View accessibilityRole="tablist" style={{ width: shown.length * width + INSET * 2, height: BAR_HEIGHT, padding: INSET }} className="flex-row items-center self-center">
          <GlassCapsule fallback="bg-surface" />
          <Platter width={width} lens={lens} />
          <LensView width={width} lens={lens} />
          {shown.map((each, at) => (
            <Tab
              key={each.tab}
              label={each.label}
              selected={tab === each.tab}
              badge={each.tab === "orclings" ? badge : 0}
              width={width}
              onVoice={() => {
                if (each.tab === tab) return;
                haptic.select();
                onTab(each.tab);
              }}
            >
              <Glyph at={at} width={width} lens={lens} icon={each.icon} badge={each.tab === "orclings" ? badge : 0} />
            </Tab>
          ))}
        </View>
      </GestureDetector>
      <View className="absolute" style={{ right: SIDE }}>
        <NewButton action={action} />
      </View>
    </View>
  );
}
