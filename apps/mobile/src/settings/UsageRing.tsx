import Svg, { Circle } from "react-native-svg";
import { useColors } from "../ui/mode";

const SIZE = 16;
const STROKE = 2;
const RADIUS = (SIZE - STROKE) / 2;
const AROUND = 2 * Math.PI * RADIUS;

/**
 * The share of a limit left, as the desktop's usage ring at glyph size: the whole track drawn faint, so it reads as a
 * meter and never as a spinner, and the share left in ink over it, in warn when the report is out of date.
 */
export function UsageRing({ left, stale }: { left: number | null; stale: boolean }) {
  const colors = useColors();
  const filled = left === null ? 0 : Math.max(0, Math.min(100, left)) / 100;
  return (
    <Svg width={SIZE} height={SIZE} style={{ transform: [{ rotate: "-90deg" }] }}>
      <Circle cx={SIZE / 2} cy={SIZE / 2} r={RADIUS} stroke={colors["line-strong"]} strokeWidth={STROKE} fill="none" />
      {filled > 0 ? (
        <Circle
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={RADIUS}
          stroke={stale ? colors.warn : colors.ink}
          strokeWidth={STROKE}
          strokeLinecap="round"
          strokeDasharray={`${filled * AROUND} ${AROUND}`}
          fill="none"
        />
      ) : null}
    </Svg>
  );
}
