import { DatePicker, Host } from "@expo/ui/swift-ui";
import { datePickerStyle, labelsHidden } from "@expo/ui/swift-ui/modifiers";
import { orclingWakeKey, type OrclingWake } from "@openorc/protocol";
import { Fragment, useState } from "react";
import { Pressable, Switch, View } from "react-native";
import { useRpcMutation } from "../client";
import { AlarmClock, Plus, Power, X } from "../generated/icons";
import { Card, Divider, RowLines, rowClass, Section } from "../settings/parts";
import { cn } from "../ui/cn";
import { haptic } from "../ui/haptics";
import { useMode } from "../ui/mode";
import { Text } from "../ui/Text";

type TimeWake = Extract<OrclingWake, { kind: "time" }>;

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
const SUGGESTED = ["09:00", "13:00", "18:00", "21:00"];
const sameWakes = (a: readonly OrclingWake[], b: readonly OrclingWake[]) => a.map(orclingWakeKey).join(" ") === b.map(orclingWakeKey).join(" ");

/** "09:30" as today's date at that time, for the clock picker, and back. */
const asDate = (at: string) => {
  const [hours, minutes] = at.split(":").map(Number);
  const date = new Date();
  date.setHours(hours ?? 9, minutes ?? 0, 0, 0);
  return date;
};
const asTime = (date: Date) => `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;

/** One time it checks in: iOS's clock picker, the days it applies to as round toggles, and a way to remove it. */
function TimeRow({ wake, onChange, onRemove }: { wake: TimeWake; onChange: (next: TimeWake) => void; onRemove: () => void }) {
  const mode = useMode();
  const toggle = (day: number) => {
    const days = wake.days.includes(day) ? wake.days.filter((other) => other !== day) : [...wake.days, day].sort();
    if (days.length) onChange({ ...wake, days });
  };
  return (
    <View className={cn(rowClass, "gap-2.5")}>
      <View className="flex-row items-center gap-3">
        <View className="size-4 items-center justify-center">
          <AlarmClock size={16} className="text-ink-4" />
        </View>
        <Host matchContents colorScheme={mode}>
          <DatePicker
            selection={asDate(wake.at)}
            displayedComponents={["hourAndMinute"]}
            onDateChange={(date) => onChange({ ...wake, at: asTime(date) })}
            modifiers={[datePickerStyle("compact"), labelsHidden()]}
          />
        </Host>
        <View className="flex-1" />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Remove the ${wake.at} check-in`}
          onPress={onRemove}
          hitSlop={8}
          className="size-8 items-center justify-center rounded-full active:bg-surface-2"
        >
          <X size={16} className="text-ink-4" />
        </Pressable>
      </View>
      <View accessibilityRole="radiogroup" accessibilityLabel="Days" className="ml-7 flex-row gap-1.5">
        {DAYS.map((name, day) => {
          const on = wake.days.includes(day);
          return (
            <Pressable
              key={name}
              accessibilityRole="button"
              accessibilityLabel={name}
              accessibilityState={{ selected: on }}
              onPress={() => toggle(day)}
              className={cn("size-8 items-center justify-center rounded-full", on ? "bg-ink" : "bg-surface-2 active:bg-surface-3")}
            >
              <Text className={cn("text-sm", on ? "text-bg" : "text-ink-3")}>{name[0]}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

/**
 * When the Orcling wakes up on its own to see whether anything is worth texting about, as on the Mac. Every change saves
 * at once and builds on the last one sent rather than on the saved list, so quick changes in a row never undo each other.
 */
export function CheckIns({ id, wakes }: { id: string; wakes: readonly OrclingWake[] }) {
  const save = useRpcMutation("orclings.wakes.save");
  const [sent, setSent] = useState<OrclingWake[] | null>(null);
  if (sent && sameWakes(sent, wakes)) setSent(null);
  const current = sent ?? wakes;
  const commit = (next: OrclingWake[]) => {
    haptic.select();
    setSent(next);
    save.mutate({ id, wakes: next }, { onError: () => setSent(null) });
  };
  const opening = current.some((wake) => wake.kind === "startup");
  const times = current.filter((wake): wake is TimeWake => wake.kind === "time");
  const withOpening = (next: TimeWake[]) => commit(opening ? [{ kind: "startup" }, ...next] : next);
  const free = SUGGESTED.find((at) => !times.some((wake) => wake.at === at)) ?? "09:00";
  return (
    <Section title="Check-ins">
      <Card>
        <View className={rowClass}>
          <RowLines
            lead={<Power size={16} className="text-ink-4" />}
            label="When OpenOrc opens"
            trailing={<Switch accessibilityLabel="When OpenOrc opens" value={opening} onValueChange={(on) => commit(on ? [{ kind: "startup" }, ...times] : times)} />}
          />
        </View>
        {times.map((wake, index) => (
          <Fragment key={index}>
            <Divider />
            <TimeRow wake={wake} onChange={(next) => withOpening(times.map((other, at) => (at === index ? next : other)))} onRemove={() => withOpening(times.filter((_, at) => at !== index))} />
          </Fragment>
        ))}
        <Divider />
        <Pressable accessibilityRole="button" onPress={() => withOpening([...times, { kind: "time", at: free, days: [1, 2, 3, 4, 5] }])} className={cn(rowClass, "active:bg-surface-2")}>
          <RowLines lead={<Plus size={16} className="text-ink-4" />} label="Add a time" labelClassName="text-ink-2" />
        </Pressable>
      </Card>
      {save.error ? (
        <Text accessibilityRole="alert" className="px-4 text-sm text-bad">
          {save.error.message}
        </Text>
      ) : null}
    </Section>
  );
}
