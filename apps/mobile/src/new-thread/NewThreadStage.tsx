import { useState, type ReactNode } from "react";
import { ScrollView, View } from "react-native";
import { useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import Animated, { useAnimatedStyle } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useSplit } from "../layout";
import { cn } from "../ui/cn";
import { NewThreadPainting } from "./NewThreadPainting";

/** The card's inset from the screen's edges: the desktop's 14, at the 12 the phone sets its rows in from the edge. */
const INSET = 12;

/**
 * New thread's stage: the mark and the question centred in the room over the keyboard, scrolling from their top once
 * they are taller than that room, at the desktop's width at most. Where the window shows the list beside it, as an
 * iPad does, the composer is the end of that centred column, as the desktop lays it out. On a phone it sits at the
 * stage's foot, over the home indicator, and rises only with the keyboard. `painted`, the room is the Mac's picture as
 * one rounded card set in from every edge, with all of it inside.
 */
export function NewThreadStage({ painted, composer, children }: { painted: boolean; composer: ReactNode; children: ReactNode }) {
  const insets = useSafeAreaInsets();
  const split = useSplit();
  const keyboard = useReanimatedKeyboardAnimation();
  const [room, setRoom] = useState<{ width: number; height: number } | null>(null);
  const edge = painted ? INSET : 0;
  // Where the stage ends while the keyboard is away: over the home indicator, a card no nearer the edge than its inset.
  const rest = Math.max(insets.bottom, edge);
  const side = painted ? "px-1.5" : "px-3";
  const floor = useAnimatedStyle(() => ({ paddingBottom: Math.max(-keyboard.height.value + edge, rest) }));
  return (
    <View className="flex-1 bg-bg" onLayout={(event) => setRoom(event.nativeEvent.layout)}>
      <Animated.View className={cn("flex-1", painted && "px-3 pt-3")} style={floor}>
        <View className="flex-1">
          {painted && room ? <NewThreadPainting card={{ width: room.width - INSET * 2, height: room.height - INSET - rest }} /> : null}
          <ScrollView alwaysBounceVertical={false} keyboardShouldPersistTaps="handled" contentContainerClassName={cn("grow justify-center py-6", side)}>
            <View className="w-full max-w-160 gap-4.5 self-center">
              {children}
              {split ? composer : null}
            </View>
          </ScrollView>
          {split ? null : (
            <View className={cn(side, painted ? "pb-1.5" : "pb-2")}>
              <View className="w-full max-w-160 self-center">{composer}</View>
            </View>
          )}
        </View>
      </Animated.View>
    </View>
  );
}
