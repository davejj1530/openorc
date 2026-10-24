import { WORKSPACE_ID } from "@openorc/protocol";
import { useRef } from "react";
import { Pressable, ScrollView, type ScrollViewInstance } from "react-native";
import { Folder, FolderOpen, Globe } from "../generated/icons";
import type { ProjectChoice } from "../projects";
import { cn } from "../ui/cn";
import { haptic } from "../ui/haptics";
import { Text } from "../ui/Text";

/** Workspace's globe, or a project's folder, open while it is the one chosen, as Home's headings draw them. */
function choiceIcon(id: string, on: boolean) {
  if (id === WORKSPACE_ID) return Globe;
  return on ? FolderOpen : Folder;
}

/**
 * Where the thread lives: Workspace, then the Mac's projects, in one row that scrolls sideways. The chosen one sits on
 * a fill with its folder open, and comes into view when the sheet opens for a project further along.
 */
export function ProjectPicker({ choices, selected, disabled, onSelect }: { choices: ProjectChoice[]; selected: string; disabled: boolean; onSelect: (id: string) => void }) {
  const row = useRef<ScrollViewInstance>(null);
  const shown = useRef(false);
  return (
    <ScrollView ref={row} horizontal scrollsToTop={false} showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerClassName="gap-1 px-3">
      {choices.map((choice) => {
        const on = choice.id === selected;
        const Icon = choiceIcon(choice.id, on);
        return (
          <Pressable
            key={choice.id}
            accessibilityRole="radio"
            accessibilityLabel={choice.name}
            accessibilityState={{ checked: on, disabled }}
            disabled={disabled}
            hitSlop={{ top: 7, bottom: 7 }}
            onLayout={(event) => {
              if (!on || shown.current) return;
              shown.current = true;
              row.current?.scrollTo({ x: Math.max(0, event.nativeEvent.layout.x - 12), animated: false });
            }}
            onPress={() => {
              if (on) return;
              haptic.select();
              onSelect(choice.id);
            }}
            className={cn("h-control-md max-w-56 flex-row items-center gap-1.5 rounded-full pl-2.5 pr-3 active:bg-surface-2", on && "bg-surface-2")}
          >
            <Icon size={14} className={cn("text-ink-4", on && "text-ink-2")} />
            <Text numberOfLines={1} className={cn("flex-shrink text-sm text-ink-3", on && "text-ink")}>
              {choice.name}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}
