import { meteredWindows } from "@openorc/client";
import { percentLeft, sessionWindow, weeklyWindow, type AllowanceWindow } from "@openorc/protocol";
import { StyleSheet, View } from "react-native";
import { limitStale, resetWords } from "../settings/usage-words";
import { cn } from "../ui/cn";
import { ShareDisc } from "../ui/ShareDisc";
import { Text } from "../ui/Text";
import type { ComposerUsage } from "./composer-usage";

/** One limit: its name, the share left on its disc, and when it resets. Amber when nearly used up, used up or out of date. */
function Limit({ name, window, usage }: { name: string; window: AllowanceWindow; usage: ComposerUsage }) {
  const outdated = usage.limits.status === "error" || usage.limits.status === "disconnected";
  const stale = limitStale(window, usage.now, { outdated, turnRead: usage.turnRead });
  const left = percentLeft(window)!;
  const shown = Math.round(left);
  const warns = window.exhausted || stale || shown <= 10;
  const reset = resetWords(window, usage.now, stale, usage.turnRead);
  return (
    <View accessible accessibilityLabel={`${name}, ${shown}% left, ${reset}`} className="flex-1 gap-0.5 px-4 py-3">
      <Text className="text-xs text-ink-4">{name}</Text>
      <View className="flex-row items-center gap-2">
        <ShareDisc left={left} size={16} low={warns} />
        <Text className={cn("text-md tabular-nums text-ink", warns && "text-warn")}>{shown}% left</Text>
      </View>
      <Text numberOfLines={1} className="text-xs text-ink-4">
        {reset}
      </Text>
    </View>
  );
}

/**
 * The model sheet's usage: the 5-hour and weekly share left on the account the shown agent runs on, as the desktop's
 * usage table heads them, side by side on one card. Nothing for an account that reports neither; Settings has the rest.
 */
export function ModelUsage({ usage }: { usage: ComposerUsage }) {
  const windows = meteredWindows(usage.limits.provider, usage.limits.windows);
  const cells = [
    { name: "5 hours", window: sessionWindow(windows) },
    { name: "Week", window: weeklyWindow(windows) },
  ].flatMap(({ name, window }) => (window ? [{ name, window }] : []));
  if (!cells.length) return null;
  return (
    <View accessibilityLabel={`${usage.limits.name} usage`} className="flex-row overflow-hidden rounded-3xl bg-surface">
      {cells.map(({ name, window }, index) => (
        <View key={window.id} className="flex-1 flex-row">
          {index ? <View className="my-3 bg-line" style={{ width: StyleSheet.hairlineWidth }} /> : null}
          <Limit name={name} window={window} usage={usage} />
        </View>
      ))}
    </View>
  );
}
