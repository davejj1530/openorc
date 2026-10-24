import type { ReactNode } from "react";
import Svg from "react-native-svg";
import { useResolveClassNames } from "uniwind";
import type { ColorToken } from "../generated/tokens";
import { cn } from "./cn";
import { useColors } from "./mode";

/** A Precision Outline icon. Color comes from a text color class, as on the desktop: `className="text-ink-4"`. */
export type IconProps = { size?: number; className?: string };

function useIconColor(className: string | undefined): string | undefined {
  const { color } = useResolveClassNames(cn("text-ink", className));
  return typeof color === "string" ? color : undefined;
}

/** The desktop's icon root (components/icons.tsx); design-sync fails if the desktop changes it. */
function Outline({ size, color, children }: { size: number; color: string | undefined; children: ReactNode }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" color={color} fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
      {children}
    </Svg>
  );
}

export function icon(name: string, geometry: ReactNode) {
  function Icon({ size = 24, className }: IconProps) {
    const color = useIconColor(className);
    return (
      <Outline size={size} color={color}>
        {geometry}
      </Outline>
    );
  }
  Icon.displayName = name;
  return Icon;
}

/** An icon that also paints a palette role of its own, such as WorkAgent's accent half. */
export function tonedIcon(name: string, geometry: (tone: (token: ColorToken) => string) => ReactNode) {
  function Icon({ size = 24, className }: IconProps) {
    const color = useIconColor(className);
    const palette = useColors();
    return (
      <Outline size={size} color={color}>
        {geometry((token) => palette[token])}
      </Outline>
    );
  }
  Icon.displayName = name;
  return Icon;
}
