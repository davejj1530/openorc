import { useState, type ReactNode } from "react";
import { ScrollView, View, type StyleProp, type ViewStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

/**
 * A full-height sheet whose top stays put over a list that scrolls, with its action floating over the list's end.
 * react-native-screens stretches a scroll view it finds among a form sheet's top-level views over the whole sheet,
 * covering the top; held in a view of its own, the list keeps its place under the top.
 */
export function PinnedSheet({
  top,
  footer,
  contentContainerStyle,
  onAccessibilityEscape,
  children,
}: {
  top: ReactNode;
  footer: ReactNode;
  contentContainerStyle?: StyleProp<ViewStyle>;
  onAccessibilityEscape: () => void;
  children: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  const [footerHeight, setFooterHeight] = useState(0);
  return (
    <View className="flex-1 bg-bg" onAccessibilityEscape={onAccessibilityEscape}>
      <View collapsable={false} className="bg-bg">
        {top}
      </View>
      <View collapsable={false} className="flex-1">
        <ScrollView className="flex-1" keyboardShouldPersistTaps="handled" contentContainerStyle={[contentContainerStyle, { paddingBottom: footerHeight + 24 }]}>
          {children}
        </ScrollView>
      </View>
      <View onLayout={(event) => setFooterHeight(event.nativeEvent.layout.height)} className="absolute inset-x-0 bottom-0 gap-2 bg-bg px-5 pt-3" style={{ paddingBottom: insets.bottom + 8 }}>
        {footer}
      </View>
    </View>
  );
}
