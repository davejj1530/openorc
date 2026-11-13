import { Host, Menu, Picker, RNHostView, Text as MenuText } from "@expo/ui/swift-ui";
import { accessibilityLabel, accessibilityValue, pickerStyle, tag } from "@expo/ui/swift-ui/modifiers";
import type { Task, TaskPriority, TaskStatus } from "@openorc/protocol";
import type { ReactNode } from "react";
import { Alert, Pressable, View } from "react-native";
import { Folder, Plus } from "../generated/icons";
import { cn } from "../ui/cn";
import { haptic } from "../ui/haptics";
import { useMode } from "../ui/mode";
import { Text } from "../ui/Text";
import { boardPriority, boardStatus } from "./board";
import { typedLabels, type TaskPatch } from "./task-edit";
import { PriorityMark, TaskStatusMark } from "./TaskMarks";

/** The desktop's menu orders (components/status.tsx). */
const STATUS_ORDER: readonly TaskStatus[] = ["proposed", "backlog", "in_progress", "review", "done", "archived"];
export const PRIORITY_ORDER: readonly TaskPriority[] = ["none", "low", "medium", "high", "urgent"];

/** One of a task's properties as the desktop's task document shows it: a pill with its mark; a mark alone is round. */
export function Pill({ icon, label }: { icon?: ReactNode; label: string | null }) {
  if (!label) return <View className="h-control-xl w-9 items-center justify-center rounded-full bg-surface-2">{icon}</View>;
  return (
    <View pointerEvents="none" className={cn("h-control-xl max-w-full flex-row items-center gap-1.5 rounded-full bg-surface-2 pr-3.5", icon ? "pl-2.5" : "pl-3.5")}>
      {icon}
      <Text numberOfLines={1} className="shrink text-md text-ink-2">
        {label}
      </Text>
    </View>
  );
}

/** A pill that opens a native menu of the property's values, a check on the current one, as the desktop's select does. */
export function PillMenu<T extends string>({
  name,
  value,
  values,
  words,
  icon,
  onChange,
}: {
  name: string;
  value: T;
  values: readonly T[];
  words: Record<T, string>;
  icon: ReactNode;
  onChange: (value: T) => void;
}) {
  return (
    <Host matchContents colorScheme={useMode()}>
      <Menu
        modifiers={[accessibilityLabel(name), accessibilityValue(words[value])]}
        label={
          <RNHostView matchContents>
            <Pill icon={icon} label={words[value]} />
          </RNHostView>
        }
      >
        <Picker
          selection={value}
          onSelectionChange={(next: T) => {
            if (next === value) return;
            haptic.select();
            onChange(next);
          }}
          modifiers={[pickerStyle("inline")]}
        >
          {values.map((each) => (
            <MenuText key={each} modifiers={[tag(each)]}>
              {words[each]}
            </MenuText>
          ))}
        </Picker>
      </Menu>
    </Host>
  );
}

/** The labels as typed on the Mac, comma separated, in one prompt. */
function promptLabels(labels: readonly string[], save: (labels: string[]) => void) {
  Alert.prompt(
    "Labels",
    "Separate labels with commas.",
    [
      { text: "Cancel", style: "cancel" },
      { text: "Save", isPreferred: true, onPress: (typed?: string) => save(typedLabels(typed ?? "")) },
    ],
    "plain-text",
    labels.join(", "),
  );
}

/** The labels as pills, and one more that edits them; a task with none shows just that one. */
function Labels({ labels, onSave }: { labels: readonly string[]; onSave: (labels: string[]) => void }) {
  const edit = () => promptLabels(labels, (next) => next.join() !== labels.join() && onSave(next));
  return (
    <>
      {labels.map((label) => (
        <Pressable key={label} accessibilityRole="button" accessibilityLabel={`Label ${label}`} accessibilityHint="Edits the labels" onPress={edit} className="active:opacity-60">
          <Pill label={label} />
        </Pressable>
      ))}
      <Pressable accessibilityRole="button" accessibilityLabel={labels.length ? "Edit labels" : "Add labels"} onPress={edit} className="active:opacity-60">
        <Pill icon={<Plus size={16} className="text-ink-4" />} label={labels.length ? null : "Labels"} />
      </Pressable>
    </>
  );
}

/**
 * The task's properties under its title, as the desktop's task document lays them out: status and priority as menus,
 * the project it belongs to, and its labels. Moving a task to another project stays on the Mac.
 */
export function TaskProperties({ task, project, onSave }: { task: Task; project: string | null; onSave: (patch: TaskPatch) => void }) {
  return (
    <View className="flex-row flex-wrap gap-1.5">
      <PillMenu name="Status" value={task.status} values={STATUS_ORDER} words={boardStatus} icon={<TaskStatusMark status={task.status} />} onChange={(status) => onSave({ status })} />
      <PillMenu name="Priority" value={task.priority} values={PRIORITY_ORDER} words={boardPriority} icon={<PriorityMark priority={task.priority} />} onChange={(priority) => onSave({ priority })} />
      {project ? (
        <View accessible accessibilityLabel={`Project ${project}`}>
          <Pill icon={<Folder size={16} className="text-ink-4" />} label={project} />
        </View>
      ) : null}
      <Labels labels={task.labels} onSave={(labels) => onSave({ labels })} />
    </View>
  );
}
