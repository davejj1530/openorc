import { Button, Host } from "@expo/ui/swift-ui";
import { buttonBorderShape, buttonStyle, controlSize, disabled, dynamicTypeSize, labelStyle } from "@expo/ui/swift-ui/modifiers";
import { View } from "react-native";
import type { SharedValue } from "react-native-reanimated";
import { useMode } from "./mode";
import { ScrollEdge } from "./ScrollEdge";
import { Text } from "./Text";

/**
 * A sheet's pinned top, as an iOS sheet's bar: the title inline and centered, iOS's own close button (at one size,
 * as bar buttons stay), and a hairline once the content scrolls under it. It is opaque and starts below the grabber,
 * so content never meets the grabber. `locked` holds the close button while the sheet's work runs.
 */
export function SheetHeader({ title, scrollY, onClose, locked = false }: { title: string; scrollY?: SharedValue<number>; onClose: () => void; locked?: boolean }) {
  const modifiers = [buttonStyle("glass"), buttonBorderShape("circle"), controlSize("large"), labelStyle("iconOnly"), dynamicTypeSize("large"), disabled(locked)];
  return (
    <View className="z-10 bg-bg pb-2 pt-4">
      <View className="h-touch items-center justify-center px-16">
        {/* The row's full height, as the close button's, so VoiceOver reads the title first. */}
        <View accessible accessibilityRole="header" accessibilityLabel={title} className="h-touch justify-center">
          <Text numberOfLines={1} className="text-lg">
            {title}
          </Text>
        </View>
        <View className="absolute inset-y-0 right-4 justify-center">
          <Host matchContents colorScheme={useMode()}>
            <Button role="close" onPress={() => !locked && onClose()} modifiers={modifiers} />
          </Host>
        </View>
      </View>
      {scrollY ? <ScrollEdge scrollY={scrollY} /> : null}
    </View>
  );
}
