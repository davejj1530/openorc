import type { OrclingChatSummary } from "@openorc/protocol";
import { router, Stack } from "expo-router";
import { useContext } from "react";
import { Pressable } from "react-native";
import { HostContext } from "../connection/host-context";
import { useHeaderScope } from "../connection/HostScope";
import { Text } from "../ui/Text";
import { OrclingFace } from "./OrclingFace";

/** The Orcling's face and name, sized to sit in the bar's glass beside the back button as one pill. */
function Pill({ chat, onPress }: { chat: OrclingChatSummary; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={chat.name}
      accessibilityHint={`Opens ${chat.name}`}
      onPress={onPress}
      hitSlop={4}
      className="h-11 flex-row items-center gap-2 pl-1 pr-3.5 active:opacity-60"
    >
      <OrclingFace look={chat.look} size={30} />
      <Text numberOfLines={1} className="max-w-48 text-lg">
        {chat.name}
      </Text>
    </Pressable>
  );
}

/**
 * An Orcling's chat names it as a texting app names a contact: its face and name in a pill beside the back button,
 * which opens the Orcling. No title in the middle and no More menu, since nothing in it organizes a chat with an Orcling.
 */
export function OrclingHeader({ chat }: { chat: OrclingChatSummary }) {
  const inScope = useHeaderScope();
  const host = useContext(HostContext);
  const open = () => router.push({ pathname: "/orcling", params: host ? { id: chat.id, host } : { id: chat.id } });
  return (
    <>
      {/* A custom item on the left replaces the back button unless the bar is told to keep it beside the item. */}
      <Stack.Screen options={{ headerTitle: "", headerBackVisible: true }} />
      <Stack.Toolbar placement="left">
        <Stack.Toolbar.View>{inScope(<Pill chat={chat} onPress={open} />)}</Stack.Toolbar.View>
      </Stack.Toolbar>
    </>
  );
}
