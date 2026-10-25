import type { ReactNode } from "react";
import { Pressable, View } from "react-native";
import { cn } from "../ui/cn";
import { Text } from "../ui/Text";

/** A field of a sheet: its plain label over a filled plane, aligned with the plane's text. */
export function Field({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <View className="gap-2">
      {label ? <Text className="px-4 text-sm text-ink-4">{label}</Text> : null}
      <View className="overflow-hidden rounded-2xl bg-surface">{children}</View>
    </View>
  );
}

/** A sheet's one ink pill, full width. A dim one still takes a tap, which asks why; a running one takes none. */
export function SheetPill({ label, dim, running, onPress }: { label: string; dim: boolean; running: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: dim || running }}
      disabled={running}
      onPress={onPress}
      className={cn("h-touch items-center justify-center rounded-full bg-accent px-5 active:opacity-80", (dim || running) && "bg-surface-3")}
    >
      <Text className={cn("text-md text-accent-fg", (dim || running) && "text-ink-3")}>{label}</Text>
    </Pressable>
  );
}
