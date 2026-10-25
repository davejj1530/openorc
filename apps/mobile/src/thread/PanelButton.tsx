import { Button, Host, HStack, Image, Text } from "@expo/ui/swift-ui";
import { accessibilityLabel, buttonStyle, contentShape, font, foregroundStyle, frame, monospacedDigit, padding, shapes } from "@expo/ui/swift-ui/modifiers";
import { fileCount } from "@openorc/client";
import { fonts } from "../generated/tokens";
import type { Mode } from "../ui/mode";

/** The side panel's button: the tools it holds by name, and the uncommitted file count beside its icon, none at 0. */
export interface PanelButton {
  label: string;
  count: number;
  colors: { icon: string; count: string };
  mode: Mode;
  onPress: () => void;
}

/** "Changes, 3 files" for VoiceOver; the tools alone when nothing is uncommitted. */
export const panelButtonLabel = ({ label, count }: Pick<PanelButton, "label" | "count">): string => (count ? `${label}, ${fileCount(count)}` : label);

/**
 * The button drawn inside the header's glass group, as iOS's own bar button would be: its symbol at the bar's size,
 * then the count in neutral ink. A system badge would hang off the group's top edge.
 */
export function PanelButtonView(button: PanelButton) {
  return (
    <Host matchContents colorScheme={button.mode}>
      <Button onPress={button.onPress} modifiers={[buttonStyle("plain"), accessibilityLabel(panelButtonLabel(button))]}>
        {/* A bar item's own height to tap, and its inset from the group's edge. */}
        <HStack spacing={5} modifiers={[padding({ leading: 6 }), frame({ minHeight: 44 }), contentShape(shapes.rectangle())]}>
          <Image systemName="sidebar.trailing" size={19} color={button.colors.icon} />
          {button.count ? <Text modifiers={[font({ family: fonts.text, size: 15 }), monospacedDigit(), foregroundStyle(button.colors.count)]}>{String(button.count)}</Text> : null}
        </HStack>
      </Button>
    </Host>
  );
}
