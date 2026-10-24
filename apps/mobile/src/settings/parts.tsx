import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { cn } from "../ui/cn";
import { Text } from "../ui/Text";

/**
 * A group of Settings: a plain label in sentence case over its cards, aligned with the glyphs inside them, and a note
 * under the label that speaks for every card in the group. With no title, the cards stand alone.
 */
export function Section({ title, note, children }: { title?: string; note?: string | null; children: ReactNode }) {
  return (
    <View className="gap-2">
      {title ? (
        <View className="px-4">
          <Text accessibilityRole="header" className="text-sm text-ink-4">
            {title}
          </Text>
          {note ? <Text className="text-sm text-ink-4">{note}</Text> : null}
        </View>
      ) : null}
      {children}
    </View>
  );
}

/** A plane on the sheet's tile, fill only, its rows split by hairlines. */
export function Card({ children }: { children: ReactNode }) {
  return <View className="overflow-hidden rounded-3xl bg-surface">{children}</View>;
}

/** The hairline between two rows, starting where their text does: past the 16 pt padding, the glyph and its gap. */
export function Divider() {
  return <View className="ml-11 bg-line" style={{ height: StyleSheet.hairlineWidth }} />;
}

/** A row's box: 52 pt at least, its lines centered in it. Pressable rows add their pressed fill. */
export const rowClass = "min-h-touch-row justify-center bg-surface px-4 py-2.5";

/**
 * A row's lines. The first holds the 16 pt glyph column, the label and a trailing value, all on the label's line, so a
 * glyph sits with its label however many lines follow; the detail wraps under the label.
 */
export function RowLines({
  lead,
  label,
  labelClassName,
  detail,
  detailClassName,
  trailing,
}: {
  lead?: ReactNode;
  label: string;
  labelClassName?: string;
  detail?: string | null;
  detailClassName?: string;
  trailing?: ReactNode;
}) {
  return (
    <>
      <View className="flex-row items-center gap-3">
        <View className="size-4 items-center justify-center">{lead}</View>
        <Text numberOfLines={1} className={cn("flex-1 text-md", labelClassName)}>
          {label}
        </Text>
        {trailing}
      </View>
      {detail ? <Text className={cn("ml-7 text-sm text-ink-4", detailClassName)}>{detail}</Text> : null}
    </>
  );
}
