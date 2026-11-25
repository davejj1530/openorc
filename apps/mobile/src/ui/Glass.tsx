import { Capsule, Host, RoundedRectangle } from "@expo/ui/swift-ui";
import { foregroundStyle, glassEffect } from "@expo/ui/swift-ui/modifiers";
import { Platform, View } from "react-native";
import { cn } from "./cn";
import { useColors, useMode } from "./mode";

/** A palette color at an opacity, as `#rrggbbaa`. */
const withAlpha = (hex: string, alpha: number) =>
  `${hex.slice(0, 7)}${Math.round(alpha * 255)
    .toString(16)
    .padStart(2, "0")}`;

/** iOS draws Liquid Glass from iOS 26. */
export const liquidGlass = Platform.OS === "ios" && Number.parseInt(String(Platform.Version), 10) >= 26;

/**
 * A Liquid Glass capsule filling its parent, behind the parent's own content, refracting what scrolls under it as iOS's
 * own bars do; the `clear` variant lets more through, as a lens over content. Without Liquid Glass, `fallback`'s fill
 * stands in.
 */
export function GlassCapsule({ fallback, variant = "regular" }: { fallback: string; variant?: "regular" | "clear" }) {
  const mode = useMode();
  return (
    <View pointerEvents="none" className={cn("absolute inset-0 overflow-hidden rounded-full", !liquidGlass && fallback)}>
      {liquidGlass ? (
        <Host style={{ flex: 1 }} colorScheme={mode}>
          <Capsule modifiers={[foregroundStyle("transparent"), glassEffect({ glass: { variant }, shape: "capsule" })]} />
        </Host>
      ) : null}
    </View>
  );
}

/**
 * A pane of glass filling its parent, behind the parent's own content, for a plane that stands over a picture: Liquid
 * Glass where iOS draws it, and before that the system's own frosted material, which blurs what is behind it too.
 * `radius` is the parent's corner. The glass takes the ground's own colour as its tint, the desktop's weight of it, so
 * words on it read over any picture: the tile in dark, the plane in light.
 */
export function GlassPane({ radius }: { radius: number }) {
  const mode = useMode();
  const colors = useColors();
  const tint = mode === "dark" ? withAlpha(colors.bg, 0.72) : withAlpha(colors.surface, 0.78);
  return (
    <View pointerEvents="none" className="absolute inset-0">
      <Host style={{ flex: 1 }} colorScheme={mode}>
        <RoundedRectangle
          cornerRadius={radius}
          modifiers={
            liquidGlass
              ? [foregroundStyle("transparent"), glassEffect({ glass: { variant: "regular", tint }, shape: "roundedRectangle", cornerRadius: radius })]
              : [foregroundStyle({ type: "material", material: "regular" })]
          }
        />
      </Host>
    </View>
  );
}
