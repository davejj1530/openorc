import { router } from "expo-router";
import { Keyboard, Pressable, View } from "react-native";
import type { ComponentType } from "react";
import { ChevronDown } from "../generated/icons";
import type { ProjectChoice } from "../projects";
import type { IconProps } from "../ui/icon";
import { Text } from "../ui/Text";
import { cn } from "../ui/cn";
import { projectIcon } from "./project-icon";
import { projectReach, useMacReach } from "./project-reach";

function Picker({ label, name, Icon, away, disabled, onPress }: { label: string; name: string; Icon: ComponentType<IconProps>; away: boolean; disabled: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={() => {
        Keyboard.dismiss();
        onPress();
      }}
      hitSlop={{ top: 4, bottom: 4 }}
      className="h-control-xl min-w-0 flex-shrink flex-row items-center gap-2 rounded-full bg-surface-2 px-3 active:bg-surface-3"
    >
      {/* The glyph takes its ink from its class; its fade, while the project's place is out of reach, is the view's. */}
      <View className={cn(away && "opacity-40")}>
        <Icon size={16} className="text-ink-3" />
      </View>
      <Text numberOfLines={1} className="min-w-0 flex-shrink text-md">
        {name}
      </Text>
      <ChevronDown size={12} className="text-ink-4" />
    </Pressable>
  );
}

/** The new thread's project, above the composer. */
export function NewThreadPickers({ composerId, project, starting, uploading }: { composerId: string; project: ProjectChoice; starting: boolean; uploading: boolean }) {
  const away = projectReach(project, useMacReach());
  return (
    <View className="min-h-touch flex-row items-center gap-2 px-3">
      <Picker
        away={away !== null}
        label={away ? `Project, ${project.name}, ${away}` : `Project, ${project.name}`}
        name={project.name}
        Icon={projectIcon(project, true)}
        disabled={starting || uploading}
        onPress={() => router.push({ pathname: "/project", params: { composerId } })}
      />
    </View>
  );
}
