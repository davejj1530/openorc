import { Host, Menu, Picker, RNHostView, Text as MenuText } from "@expo/ui/swift-ui";
import { accessibilityLabel, accessibilityValue, pickerStyle, tag } from "@expo/ui/swift-ui/modifiers";
import { Switch, View } from "react-native";
import { APPEARANCES, chooseAppearance, useAppearance, type AppearanceChoice } from "../appearance";
import { ChevronsUpDown, Orclings, SunMoon } from "../generated/icons";
import { setOrclingFaces, useOrclingFaces } from "../orclings/face-row";
import { useOrclingChats } from "../orclings/orcling-chats";
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

/** Whether Threads shows the Orclings' faces at its top; off, the Orclings tab counts the ones that need you instead. */
function OrclingFacesRow() {
  const shown = useOrclingFaces();
  return (
    <View className={rowClass}>
      <RowLines
        lead={<Orclings size={16} className="text-ink-4" />}
        label="Orclings on Threads"
        trailing={
          <Switch
            accessibilityLabel="Orclings on Threads"
            value={shown}
            onValueChange={(next) => {
              haptic.select();
              setOrclingFaces(next);
            }}
          />
        }
      />
    </View>
  );
}

/** What this phone keeps for itself. */
export function PhoneSection({ notifications }: { notifications: boolean }) {
  const orclings = useOrclingChats().supported;
  return (
    <Section title="This iPhone">
      <Card>
        <AppearanceRow />
        {orclings ? (
          <>
            <Divider />
            <OrclingFacesRow />
          </>
        ) : null}
        {notifications ? (
          <>
            <Divider />
            <NotificationsRow />
          </>
        ) : null}
      </Card>
    </Section>
  );
}
