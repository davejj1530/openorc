import { WORKSPACE_ID } from "@openorc/protocol";
import { router } from "expo-router";
import { Keyboard, Pressable, View } from "react-native";
import type { ThreadPlace } from "../composer/settings-bridge";
import { ChevronDown, Cloud, FolderOpen, Globe, Laptop } from "../generated/icons";
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

/** The new thread's environment and project, side by side above the composer. */
export function NewThreadPickers({
  composerId,
  project,
  place,
  starting,
  uploading,
}: {
  composerId: string;
  project: ProjectChoice | undefined;
  place: ThreadPlace | undefined;
  starting: boolean;
  uploading: boolean;
}) {
  const placeName = place === "cloud" ? "Cloud" : "This Mac";
  const projectName = project?.name ?? "Project";
  return (
    <View className="min-h-touch flex-row items-center gap-2 px-3">
      {place ? (
        <View className="min-h-touch flex-shrink-0 justify-center">
          <Picker
            label={`Runs on, ${placeName}`}
            name={placeName}
            Icon={place === "cloud" ? Cloud : Laptop}
            disabled={starting}
            onPress={() => router.push({ pathname: "/place", params: { composerId } })}
          />
        </View>
      ) : null}
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
