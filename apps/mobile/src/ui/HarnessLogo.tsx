import { isHarnessId } from "@openorc/protocol";
import Svg, { Path } from "react-native-svg";
import { harnessMarks } from "../generated/harness-marks";
import { useMode } from "./mode";

/** CSS `invert(1)`, which the desktop applies to dark marks in dark themes. */
function inverted(fill: string): string {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(fill)?.[1];
  if (!hex) return fill;
  const full = hex.length === 3 ? [...hex].map((digit) => digit + digit).join("") : hex;
  return `#${(0xffffff - parseInt(full, 16)).toString(16).padStart(6, "0")}`;
}

/** The harness's own mark at icon size, or nothing for an agent that has none. */
export function HarnessLogo({ agent, size = 14 }: { agent: string; size?: number }) {
  const dark = useMode() === "dark";
  if (!isHarnessId(agent)) return null;
  const mark = harnessMarks[agent];
  const invert = dark && mark.invertsInDark;
  return (
    <Svg width={size} height={size} viewBox={mark.viewBox} fill="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {mark.paths.map((path, index) => {
        const fill = "fill" in path ? path.fill : undefined;
        return <Path key={index} {...path} fill={fill && invert ? inverted(fill) : fill} />;
      })}
    </Svg>
  );
}
