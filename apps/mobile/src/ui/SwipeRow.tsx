import { useEffect, useRef, useState, type ReactNode } from "react";
import { Pressable, View } from "react-native";
import ReanimatedSwipeable, { SwipeDirection, type SwipeableMethods } from "react-native-gesture-handler/ReanimatedSwipeable";
import Animated, { useAnimatedReaction, useAnimatedStyle, type SharedValue } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { cn } from "./cn";
import { useColors } from "./mode";
import { ACTION_WIDTH, actionLook, fullSwipe, swipes, useFullSwipe, type SwipeAction, type SwipeSide } from "./swipe";
import { Text } from "./Text";

const tones: Record<SwipeAction["tone"], { fill: string; ink: string }> = {
  accent: { fill: "bg-accent", ink: "text-accent-fg" },
  review: { fill: "bg-review", ink: "text-bg" },
  bad: { fill: "bg-bad", ink: "text-bg" },
};

function Action({
  action,
  side,
  translation,
  width,
  onCross,
  close,
}: {
  action: SwipeAction;
  side: SwipeSide;
  translation: SharedValue<number>;
  width: number;
  onCross: (side: SwipeSide | null) => void;
  close: () => void;
}) {
  useAnimatedReaction(
    () => fullSwipe(translation.value, width),
    (now, before) => {
      if (now !== before) scheduleOnRN(onCross, now);
    },
  );
  const grow = useAnimatedStyle(() => actionLook(side, translation.value));
  return (
    <Animated.View style={grow} className={cn("justify-center", tones[action.tone].fill, side === "leading" ? "items-start" : "items-end")}>
      <Pressable
        accessibilityElementsHidden
        importantForAccessibility="no"
        onPress={() => {
          close();
          action.run();
        }}
        className="h-full justify-center px-3.5"
      >
        <Text numberOfLines={1} className={cn("text-md", tones[action.tone].ink)}>
          {action.label}
        </Text>
      </Pressable>
    </Animated.View>
  );
}

/**
 * A list row that swipes like Mail's: a leading and a trailing action, revealed by a short swipe for a tap and done by
 * a full one. One row is open at a time, and a row the list hands to another item closes. `id` names the item shown.
 * The screen around the rows passes its touches to `swipes.touched`, so a touch elsewhere closes the open row.
 */
export function SwipeRow({ id, leading, trailing, children }: { id: string; leading?: SwipeAction; trailing?: SwipeAction; children: ReactNode }) {
  const row = useRef<SwipeableMethods>(null);
  const colors = useColors();
  const [width, setWidth] = useState(0);
  const swipe = useFullSwipe({ leading, trailing });
  useEffect(() => () => row.current?.reset(), [id]);
  const close = () => row.current?.close();
  return (
    <View onLayout={(event) => setWidth(event.nativeEvent.layout.width)} onTouchStart={() => row.current && swipes.touchedRow(row.current)}>
      <ReanimatedSwipeable
        ref={row}
        friction={1}
        // The row's own margins are the ground, not the actions behind it.
        childrenContainerStyle={{ backgroundColor: colors.bg }}
        overshootLeft={Boolean(leading)}
        overshootRight={Boolean(trailing)}
        leftThreshold={ACTION_WIDTH / 2}
        rightThreshold={ACTION_WIDTH / 2}
        renderLeftActions={leading ? (_progress, translation) => <Action action={leading} side="leading" translation={translation} width={width} onCross={swipe.cross} close={close} /> : undefined}
        renderRightActions={trailing ? (_progress, translation) => <Action action={trailing} side="trailing" translation={translation} width={width} onCross={swipe.cross} close={close} /> : undefined}
        onSwipeableWillOpen={(direction) => {
          if (row.current) swipes.opened(row.current);
          if (swipe.release(direction === SwipeDirection.RIGHT ? "leading" : "trailing")) close();
        }}
        onSwipeableClose={() => row.current && swipes.closed(row.current)}
      >
        {children}
      </ReanimatedSwipeable>
    </View>
  );
}
