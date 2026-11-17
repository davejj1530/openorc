import { teamChatCallLine, type TeamChatLease } from "@openorc/client";
import type { TeamOrclingCall } from "@openorc/protocol";
import { useState } from "react";
import { Pressable, View } from "react-native";
import { teamChat } from "../client";
import { OrclingFace } from "../orclings/OrclingFace";
import { cn } from "../ui/cn";
import { Text } from "../ui/Text";

/**
 * How the Orcling a message called is doing, under that message, as the desktop says it: answering, or that it
 * couldn't. Its owner alone tries again, and reads why it failed by tapping the words; an answered call says nothing
 * here, since its answer follows.
 */
export function CallLine({ lease, call, mine, onRetry }: { lease: TeamChatLease; call: TeamOrclingCall | null; mine: boolean; onRetry: (call: TeamOrclingCall) => void }) {
  const line = teamChatCallLine(call, lease.accountId);
  const owned = teamChat.useOwnerCall(lease, call, lease.accountId);
  const [why, setWhy] = useState(false);
  if (!call || !line) return null;
  const reason = owned.data?.reason ?? null;
  const words = <Text className={cn("text-sm", line.failed ? "text-bad" : "text-ink-3")}>{line.words}</Text>;
  return (
    <View accessibilityLiveRegion="polite" className={cn("gap-1 px-1", mine && "items-end")}>
      <View className="flex-row items-center gap-1.5">
        <OrclingFace look={call.look} size={16} />
        {reason ? (
          <Pressable accessibilityRole="button" onPress={() => setWhy(!why)} hitSlop={6}>
            {words}
          </Pressable>
        ) : (
          words
        )}
        {line.canRetry ? (
          <Pressable accessibilityRole="button" onPress={() => onRetry(call)} hitSlop={8} className="active:opacity-60">
            <Text className="text-sm text-ink-2">Retry</Text>
          </Pressable>
        ) : null}
      </View>
      {why && reason ? <Text className="text-sm text-ink-3">{reason}</Text> : null}
    </View>
  );
}
