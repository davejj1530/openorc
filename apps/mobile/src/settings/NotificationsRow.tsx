import { Host, Menu, Picker, RNHostView, Text as MenuText, Toggle } from "@expo/ui/swift-ui";
import { accessibilityLabel, accessibilityValue, disabled, pickerStyle, tag } from "@expo/ui/swift-ui/modifiers";
import { useSyncExternalStore } from "react";
import { Linking, View } from "react-native";
import { alerts, useLinkState } from "../client";
import { Bell, ChevronsUpDown } from "../generated/icons";
import { detailFor, shownChoice, type AlertChoice } from "../notifications/registration";
import { cn } from "../ui/cn";
import { haptic } from "../ui/haptics";
import { ListPressable } from "../ui/ListPressable";
import { useMode } from "../ui/mode";
import { Text } from "../ui/Text";
import { RowLines, rowClass } from "./parts";

const CHOICES: readonly { choice: AlertChoice; label: string }[] = [
  { choice: "all", label: "All" },
  { choice: "needs-you", label: "Needs you" },
  { choice: "off", label: "Off" },
];

const lead = <Bell size={16} className="text-ink-4" />;

function Lines({ shown, detail, menu }: { shown: string; detail: string | null; menu: boolean }) {
  return (
    <RowLines
      lead={lead}
      label="Notifications"
      detail={detail}
      trailing={
        <View className="flex-row items-center gap-1">
          <Text className="text-md text-ink-4">{shown}</Text>
          {menu ? <ChevronsUpDown size={14} className="text-ink-4" /> : null}
        </View>
      }
    />
  );
}

/**
 * Which alerts reach this iPhone and whether they sound, from iOS's own pull-down menu, built like Appearance. Alerts
 * iOS turned off read Off, and the row then opens this app's page in iOS Settings, the one place to turn them on.
 */
export function NotificationsRow() {
  const { permission, prefs, senders } = useSyncExternalStore(alerts.subscribe, alerts.getState);
  const link = useLinkState();
  const shown = shownChoice(permission, prefs.choice);
  const label = CHOICES.find((item) => item.choice === shown)!.label;
  const detail = detailFor(permission, prefs.choice, link.kind === "unpaired" ? null : (senders.get(link.mac.id) ?? null));
  // The row's own views are hidden from VoiceOver behind the menu, so the line under it is spoken with the value.
  const spoken = detail ? `${label}, ${detail}` : label;
  const mode = useMode();
  if (permission === "denied")
    return (
      <ListPressable accessibilityRole="button" accessibilityLabel={`Notifications, ${spoken}`} onPress={() => void Linking.openSettings()} className={cn(rowClass, "active:bg-surface-2")}>
        <Lines shown={label} detail={detail} menu={false} />
      </ListPressable>
    );
  const choose = (choice: AlertChoice) => {
    if (choice === shown) return;
    haptic.select();
    void alerts.choose(choice);
  };
  const setSound = (sound: boolean) => {
    haptic.select();
    void alerts.setSound(sound);
  };
  return (
    <Host matchContents={{ vertical: true }} colorScheme={mode}>
      <Menu
        modifiers={[accessibilityLabel("Notifications"), accessibilityValue(spoken)]}
        label={
          <RNHostView matchContents={{ vertical: true }}>
            <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" className={rowClass}>
              <Lines shown={label} detail={detail} menu />
            </View>
          </RNHostView>
        }
      >
        <Picker selection={shown} onSelectionChange={choose} modifiers={[pickerStyle("inline")]}>
          {CHOICES.map(({ choice, label: text }) => (
            <MenuText key={choice} modifiers={[tag(choice)]}>
              {text}
            </MenuText>
          ))}
        </Picker>
        <Toggle label="Sound" isOn={prefs.sound} onIsOnChange={setSound} modifiers={[disabled(shown === "off")]} />
      </Menu>
    </Host>
  );
}
