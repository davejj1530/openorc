import { Button, Host, Menu, Picker, RNHostView, Text as MenuText } from "@expo/ui/swift-ui";
import { accessibilityLabel, accessibilityValue, disabled, pickerStyle, tag } from "@expo/ui/swift-ui/modifiers";
import type { ClaudeAccountConnection } from "@openorc/protocol";
import { View } from "react-native";
import { ChevronsUpDown } from "../generated/icons";
import { haptic } from "../ui/haptics";
import { useMode } from "../ui/mode";
import { Text } from "../ui/Text";
import { claudeAccountUnavailable, type useClaudeAccountChoice } from "./claude-account";

type Choice = NonNullable<ReturnType<typeof useClaudeAccountChoice>>;

/**
 * Which of the Mac's Claude accounts a new thread runs on, as a native menu with a check on the current one. An account
 * the Mac cannot run follows, dimmed with why: kept out of the picker, whose check would otherwise move to it.
 */
export function ClaudeAccountMenu({ choice }: { choice: Choice }) {
  const mode = useMode();
  const name = choice.current?.name ?? "";
  const unavailable = (account: ClaudeAccountConnection) => (account.id === choice.id ? null : claudeAccountUnavailable(account));
  return (
    <View className="gap-2">
      <Text className="text-sm text-ink-4">Claude account</Text>
      <Host matchContents={{ vertical: true }} colorScheme={mode}>
        <Menu
          modifiers={[accessibilityLabel("Claude account"), accessibilityValue(name)]}
          label={
            <RNHostView matchContents={{ vertical: true }}>
              <View pointerEvents="none" className="min-h-touch flex-row items-center gap-2 rounded-full bg-surface-2 pl-4 pr-3.5">
                <Text numberOfLines={1} className="min-w-0 flex-1 text-sm">
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
    </View>
  );
}
