import { useState, type ReactNode } from "react";
import { ScrollView, View } from "react-native";
import { useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import Animated, { useAnimatedStyle } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { cn } from "../ui/cn";
import { NewThreadPainting } from "./NewThreadPainting";

/** The card's inset from the screen's edges: the desktop's 14, at the 12 the phone sets its rows in from the edge. */
const INSET = 12;

/**
 * New thread's stage, as the desktop lays it out: its column (the mark, the question, the composer) centred in the
 * room over the keyboard, at the desktop's width at most, and scrolling from its top once it is taller than that room.
 * `painted`, the room is the Mac's picture as one rounded card set in from every edge, with the column inside it. The
 * card ends over the home indicator, or over the keyboard while that is up.
 */
export function NewThreadStage({ painted, children }: { painted: boolean; children: ReactNode }) {
  const insets = useSafeAreaInsets();
  const keyboard = useReanimatedKeyboardAnimation();
  const [room, setRoom] = useState<{ width: number; height: number } | null>(null);
  const edge = painted ? INSET : 0;
  // Where the stage ends while the keyboard is away: over the home indicator, a card no nearer the edge than its inset.
  const rest = Math.max(insets.bottom, edge);
  const floor = useAnimatedStyle(() => ({ paddingBottom: Math.max(-keyboard.height.value + edge, rest) }));
  return (
    <View className="flex-1 bg-bg" onLayout={(event) => setRoom(event.nativeEvent.layout)}>
      <Animated.View className={cn("flex-1", painted && "px-3 pt-3")} style={floor}>
        <View className="flex-1">
          {painted && room ? <NewThreadPainting card={{ width: room.width - INSET * 2, height: room.height - INSET - rest }} /> : null}
          <ScrollView alwaysBounceVertical={false} keyboardShouldPersistTaps="handled" contentContainerClassName={cn("grow justify-center py-6", painted ? "px-1.5" : "px-3")}>
            <View className="w-full max-w-160 gap-4.5 self-center">{children}</View>
          </ScrollView>
        </View>
      </Animated.View>
    </View>
  );
}
