import Svg, { Circle, Path } from "react-native-svg";
import { useColors } from "./mode";

const RADIUS = 6.5;

/**
 * A share left at glyph size, as the desktop draws one: filled on a faint disc of its own ink, from the top, clockwise.
 * A filled share cannot be read as a turning mark. `low` draws it in the warning ink.
 */
export function ShareDisc({ left, size = 14, low = false }: { left: number; size?: number; low?: boolean }) {
  const colors = useColors();
  const ink = low ? colors.warn : colors["ink-3"];
  const share = Math.min(1, Math.max(0, left / 100));
  const angle = share * 2 * Math.PI;
  const x = 8 + RADIUS * Math.sin(angle);
  const y = 8 - RADIUS * Math.cos(angle);
  return (
    <Svg width={size} height={size} viewBox="0 0 16 16">
      <Circle cx={8} cy={8} r={RADIUS} fill={ink} fillOpacity={0.2} />
      {share >= 1 ? <Circle cx={8} cy={8} r={RADIUS} fill={ink} /> : null}
      {share > 0 && share < 1 ? <Path d={`M8 8V${8 - RADIUS}A${RADIUS} ${RADIUS} 0 ${share > 0.5 ? 1 : 0} 1 ${x.toFixed(3)} ${y.toFixed(3)}Z`} fill={ink} /> : null}
    </Svg>
  );
}
