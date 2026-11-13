import MaskedViewClass, { type MaskedViewProps } from "@react-native-masked-view/masked-view";
import { useState, type ComponentType } from "react";
import { StyleSheet, View } from "react-native";
import Animated, { useAnimatedStyle, useFrameCallback, useSharedValue } from "react-native-reanimated";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { useColors } from "./mode";
import { useReducedMotion } from "./reduced-motion";
import { Text } from "./Text";

// The package's class types predate React 19's; it renders as any component does.
const MaskedView = MaskedViewClass as unknown as ComponentType<MaskedViewProps>;

/** One sweep, as the desktop's: every sweeping text keeps time with the same frame clock, so they move together. */
const SWEEP_MS = 2000;
/** The gradient spans this many text widths, so its band can start before the words and leave past them. */
const SPAN = 2.5;

/**
 * One line of text that shimmers left to right while something works, as the desktop's working titles do: a faint
 * band sweeps across words in full ink, the ink the phone's list titles are in. The words are a mask over a moving
 * gradient, so they keep their own shape and truncation. Without `sweeping`, or under reduced motion, it is plain text
 * in its classes.
 */
export function SweepText({ text, className, sweeping }: { text: string; className: string; sweeping: boolean }) {
  const still = useReducedMotion();
  if (!sweeping || still)
    return (
      <Text numberOfLines={1} className={className}>
        {text}
      </Text>
    );
  return <Sweep text={text} className={className} />;
}

function Sweep({ text, className }: { text: string; className: string }) {
  const colors = useColors();
  const [width, setWidth] = useState(0);
  const span = useSharedValue(0);
  const phase = useSharedValue(0);
  useFrameCallback((frame) => {
    phase.value = (frame.timestamp % SWEEP_MS) / SWEEP_MS;
  });
  // The band's middle, half the gradient in, travels from a quarter width before the words to a quarter past them.
  const band = useAnimatedStyle(() => ({ transform: [{ translateX: span.value * (1.5 * phase.value - 1.5) }] }));
  const words = (
    <Text numberOfLines={1} className={className}>
      {text}
    </Text>
  );
  return (
    <MaskedView style={styles.fill} maskElement={words}>
      {/* Lays the mask's words out, unseen, so the view takes their size. */}
      <View
        style={styles.hidden}
        onLayout={(event) => {
          setWidth(event.nativeEvent.layout.width);
          span.value = event.nativeEvent.layout.width;
        }}
      >
        {words}
      </View>
      <Animated.View style={[StyleSheet.absoluteFill, { width: width * SPAN }, band]}>
        <Svg width="100%" height="100%">
          <Defs>
            <LinearGradient id="sweep" x1="0" y1="0" x2="1" y2="0">
              <Stop offset="0" stopColor={colors.ink} stopOpacity={1} />
              <Stop offset="0.36" stopColor={colors.ink} stopOpacity={1} />
              <Stop offset="0.5" stopColor={colors["ink-4"]} stopOpacity={1} />
              <Stop offset="0.64" stopColor={colors.ink} stopOpacity={1} />
              <Stop offset="1" stopColor={colors.ink} stopOpacity={1} />
            </LinearGradient>
          </Defs>
          <Rect width="100%" height="100%" fill="url(#sweep)" />
        </Svg>
      </Animated.View>
    </MaskedView>
  );
}

const styles = StyleSheet.create({ fill: { flex: 1, minWidth: 0 }, hidden: { opacity: 0 } });
