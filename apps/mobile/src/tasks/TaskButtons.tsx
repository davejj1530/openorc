import { buttonPendingLabel, showsOn } from "@openorc/client";
import type { Task, TaskButton } from "@openorc/protocol";
import { router } from "expo-router";
import { useState } from "react";
import { Pressable, View } from "react-native";
import { useRpcMutation } from "../client";
import { addToDraft } from "../composer/drafts";
import { failureMessage } from "../failure";
import { Play } from "../generated/icons";
import { cn } from "../ui/cn";
import { haptic } from "../ui/haptics";
import { Text } from "../ui/Text";

/**
 * The project's task buttons that show on a task in its status, as the Mac's task page offers them. A press sends the
 * button's saved prompt, in the task's thread or one of its own, and opens that thread; one set not to send leaves the
 * message in the thread's draft here. One press runs at a time.
 */
export function TaskButtons({ task, buttons }: { task: Task; buttons: readonly TaskButton[] }) {
  const run = useRpcMutation("tasks.runButton");
  const [running, setRunning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const shown = buttons.filter((button) => showsOn(button, task.status));
  if (!shown.length) return null;
  const press = async (button: TaskButton) => {
    setRunning(button.id);
    setError(null);
    haptic.tap();
    try {
      const pressed = await run.mutateAsync({ taskId: task.id, buttonId: button.id });
      if ("message" in pressed) addToDraft(pressed.threadId, pressed.message);
      router.push({ pathname: "/thread/[id]", params: { id: pressed.threadId } });
    } catch (failure) {
      haptic.fail();
      setError(failureMessage(failure));
    } finally {
      setRunning(null);
    }
  };
  return (
    <View className="gap-2">
      <View className="flex-row flex-wrap gap-2">
        {shown.map((button) => (
          <Pressable
            key={button.id}
            accessibilityRole="button"
            accessibilityState={{ disabled: running !== null, busy: running === button.id }}
            disabled={running !== null}
            onPress={() => void press(button)}
            className={cn("h-control-xl max-w-full flex-row items-center gap-1.5 rounded-full bg-surface-2 pl-3 pr-3.5 active:bg-surface-3", running !== null && running !== button.id && "opacity-50")}
          >
            <Play size={14} className="text-ink-4" />
            <Text numberOfLines={1} className="shrink text-md text-ink-2">
              {running === button.id ? buttonPendingLabel(button) : button.label}
            </Text>
          </Pressable>
        ))}
      </View>
      {error ? (
        <Text accessibilityRole="alert" selectable className="text-sm text-bad">
          {error}
        </Text>
      ) : null}
    </View>
  );
}
