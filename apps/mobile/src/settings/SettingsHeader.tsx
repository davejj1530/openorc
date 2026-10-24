import { Button, Host } from "@expo/ui/swift-ui";
import { buttonBorderShape, buttonStyle, controlSize, dynamicTypeSize, labelStyle } from "@expo/ui/swift-ui/modifiers";
import { View } from "react-native";
import type { SharedValue } from "react-native-reanimated";
import { useMode } from "../ui/mode";
import { ScrollEdge } from "../ui/ScrollEdge";
import { Text } from "../ui/Text";

/**
 * The sheet's pinned top, as an iOS sheet's bar: the title inline and centered, iOS's own close button (at one size,
 * as bar buttons stay), and a hairline once the content scrolls under it. It is opaque and starts below the grabber,
 * so content never meets the grabber.
 */
export function SettingsHeader({ scrollY, onClose }: { scrollY: SharedValue<number>; onClose: () => void }) {
  return (
    <View className="z-10 bg-bg pb-2 pt-4">
      <View className="h-touch items-center justify-center">
        {/* The row's full height, as the close button's, so VoiceOver reads the title first. */}
        <View accessible accessibilityRole="header" accessibilityLabel="Settings" className="h-touch justify-center">
          <Text className="text-lg">Settings</Text>
        </View>
        <View className="absolute inset-y-0 right-4 justify-center">
          <Host matchContents colorScheme={useMode()}>
            <Button role="close" onPress={onClose} modifiers={[buttonStyle("glass"), buttonBorderShape("circle"), controlSize("large"), labelStyle("iconOnly"), dynamicTypeSize("large")]} />
          </Host>
        </View>
      </View>
      <ScrollEdge scrollY={scrollY} />
    </View>
  );
}
