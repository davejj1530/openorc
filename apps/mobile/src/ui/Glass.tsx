import { Capsule, Host } from "@expo/ui/swift-ui";
import { foregroundStyle, glassEffect } from "@expo/ui/swift-ui/modifiers";
import { Platform, View } from "react-native";
import { cn } from "./cn";
import { useMode } from "./mode";

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
