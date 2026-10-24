import { useWindowDimensions, View } from "react-native";
import { cn } from "./cn";
import { OpenOrcMark } from "./OpenOrcMark";
import { useColors } from "./mode";
import { Text } from "./Text";

/**
 * The website's proportions (a 22 px cube 9 px from 17 px type) at the `text-wordmark` step: the cube 1.3 times the
 * type, the gap about half of it. `LIFT` raises the cube's center onto the middle of the capitals, which sits above
 * the middle of the line box; measured at 3x.
 */
const MARK = 26;
const GAP = 10;
const LIFT = 1;
/** As far as the wordmark grows with the reader's text size: past it rows outgrow it, so it keeps its rank only to here. */
export const WORDMARK_MAX_SCALE = 1.2;

/**
 * OpenOrc's wordmark: the cube and the name in Immaculate Gothic, in ink. It grows with the reader's text size as one
 * drawn unit, cube, gap and name together, up to 1.2 times; VoiceOver reads it as the screen's heading.
 */
export function Wordmark({ className }: { className?: string }) {
  const scale = Math.min(useWindowDimensions().fontScale, WORDMARK_MAX_SCALE);
  const ink = useColors().ink;
  return (
    <View accessible accessibilityRole="header" accessibilityLabel="OpenOrc" className={cn("flex-row items-center", className)} style={{ gap: GAP * scale }}>
      <View style={{ width: MARK * scale, height: MARK * scale, transform: [{ translateY: -LIFT * scale }] }}>
        <OpenOrcMark size={MARK * scale} color={ink} working={false} />
      </View>
      <Text maxFontSizeMultiplier={WORDMARK_MAX_SCALE} className="text-wordmark">
        OpenOrc
      </Text>
    </View>
  );
}
