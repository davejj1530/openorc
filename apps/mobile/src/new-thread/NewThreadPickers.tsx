import { WORKSPACE_ID } from "@openorc/protocol";
import { router } from "expo-router";
import { Keyboard, Pressable, View } from "react-native";
import { ChevronDown, FolderOpen, Globe } from "../generated/icons";
import type { ProjectChoice } from "../projects";
import { Text } from "../ui/Text";

function Picker({ label, name, Icon, disabled, onPress }: { label: string; name: string; Icon: typeof FolderOpen; disabled: boolean; onPress: () => void }) {
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
      <Icon size={16} className="text-ink-3" />
      <Text numberOfLines={1} className="min-w-0 flex-shrink text-md">
        {name}
      </Text>
      <ChevronDown size={12} className="text-ink-4" />
    </Pressable>
  );
}

/** The new thread's project, above the composer. */
export function NewThreadPickers({ composerId, project, starting, uploading }: { composerId: string; project: ProjectChoice | undefined; starting: boolean; uploading: boolean }) {
  const projectName = project?.name ?? "Project";
  return (
    <View className="min-h-touch flex-row items-center gap-2 px-3">
      <Picker
        label={`Project, ${projectName}`}
        name={projectName}
        Icon={project?.id === WORKSPACE_ID ? Globe : FolderOpen}
        disabled={starting || uploading}
        onPress={() => router.push({ pathname: "/project", params: { composerId } })}
      />
    </View>
  );
}
