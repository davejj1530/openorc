import { Button, Host, Menu, Picker, RNHostView, Text as MenuText } from "@expo/ui/swift-ui";
import { accessibilityLabel, accessibilityValue, disabled, pickerStyle, tag } from "@expo/ui/swift-ui/modifiers";
import { View } from "react-native";
import { ChevronsUpDown } from "../generated/icons";
import { cn } from "../ui/cn";
import { haptic } from "../ui/haptics";
import { useMode } from "../ui/mode";
import { Text } from "../ui/Text";
import type { AccountChoice } from "./settings-bridge";

/**
 * Which account a thread runs on, as a native menu with a check on the current one: the Mac's Claude accounts, or on
 * OpenOrc Cloud the person's accounts for the thread's agent. An account that cannot run follows, dimmed with why:
 * kept out of the picker, whose check would otherwise move to it. While the choice is held, as during an open
 * thread's turn, the menu stays shut and says why.
 */
export function AccountMenu({ choice }: { choice: AccountChoice }) {
  const mode = useMode();
  const name = choice.accounts.find((account) => account.id === choice.id)?.name ?? "";
  const unavailable = (account: AccountChoice["accounts"][number]) => (account.id === choice.id ? null : account.unavailable);
  return (
    <View className="gap-2">
      <Text className="text-sm text-ink-4">{choice.label}</Text>
      <Host matchContents={{ vertical: true }} colorScheme={mode}>
        <Menu
          modifiers={[accessibilityLabel(choice.label), accessibilityValue(name), disabled(Boolean(choice.held))]}
          label={
            <RNHostView matchContents={{ vertical: true }}>
              <View pointerEvents="none" className="min-h-touch flex-row items-center gap-2 rounded-full bg-surface-2 pl-4 pr-3.5">
                <Text numberOfLines={1} className={cn("min-w-0 flex-1 text-sm", choice.held && "text-ink-4")}>
                  {name}
                </Text>
                <ChevronsUpDown size={14} className="text-ink-4" />
              </View>
            </RNHostView>
          }
        >
          <Picker
            selection={choice.id}
            onSelectionChange={(id: string) => {
              if (id === choice.id) return;
              haptic.select();
              choice.select(id);
            }}
            modifiers={[pickerStyle("inline")]}
          >
            {choice.accounts
              .filter((account) => !unavailable(account))
              .map((account) => (
                <MenuText key={account.id} modifiers={[tag(account.id)]}>
                  {account.name}
                </MenuText>
              ))}
          </Picker>
          {choice.accounts.filter(unavailable).map((account) => (
            <Button key={account.id} label={`${account.name} · ${unavailable(account)}`} modifiers={[disabled(true)]} />
          ))}
        </Menu>
      </Host>
      {choice.held ? <Text className="text-sm text-ink-4">{choice.held}</Text> : null}
      {choice.failed ? (
        <Text accessibilityRole="alert" className="text-sm text-bad">
          {choice.failed}
        </Text>
      ) : null}
    </View>
  );
}
