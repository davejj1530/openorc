import { Host, Menu, Picker, RNHostView, Text as MenuText } from "@expo/ui/swift-ui";
import { accessibilityLabel, accessibilityValue, pickerStyle, tag } from "@expo/ui/swift-ui/modifiers";
import { View } from "react-native";
import { APPEARANCES, chooseAppearance, useAppearance, type AppearanceChoice } from "../appearance";
import { ChevronsUpDown, SunMoon } from "../generated/icons";
import { haptic } from "../ui/haptics";
import { useMode } from "../ui/mode";
import { Text } from "../ui/Text";
import { NotificationsRow } from "./NotificationsRow";
import { Card, Divider, RowLines, rowClass, Section } from "./parts";

function choose(choice: AppearanceChoice, current: AppearanceChoice): void {
  if (choice === current) return;
  haptic.select();
  chooseAppearance(choice);
}

/**
 * Appearance as one row with the current choice trailing; a tap opens iOS's own pull-down menu with a check on that
 * choice. The row is drawn by the app and handed to the menu as its label, so it lines up with every other row.
 */
function AppearanceRow() {
  const current = useAppearance();
  const shown = APPEARANCES.find((item) => item.choice === current)!.label;
  return (
    <Host matchContents={{ vertical: true }} colorScheme={useMode()}>
      <Menu
        modifiers={[accessibilityLabel("Appearance"), accessibilityValue(shown)]}
        label={
          <RNHostView matchContents={{ vertical: true }}>
            <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" className={rowClass}>
              <RowLines
                lead={<SunMoon size={16} className="text-ink-4" />}
                label="Appearance"
                trailing={
                  <View className="flex-row items-center gap-1">
                    <Text className="text-md text-ink-4">{shown}</Text>
                    <ChevronsUpDown size={14} className="text-ink-4" />
                  </View>
                }
              />
            </View>
          </RNHostView>
        }
      >
        <Picker selection={current} onSelectionChange={(choice: AppearanceChoice) => choose(choice, current)} modifiers={[pickerStyle("inline")]}>
          {APPEARANCES.map(({ choice, label }) => (
            <MenuText key={choice} modifiers={[tag(choice)]}>
              {label}
            </MenuText>
          ))}
        </Picker>
      </Menu>
    </Host>
  );
}

/** What this phone keeps for itself. */
export function PhoneSection() {
  return (
    <Section title="This iPhone">
      <Card>
        <AppearanceRow />
        <Divider />
        <NotificationsRow />
      </Card>
    </Section>
  );
}
