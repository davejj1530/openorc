import { ExecutionMode, executionMode, executionModeAvailable, executionModePresentation, executionModeSettings } from "@openorc/protocol";
import * as Haptics from "expo-haptics";
import { router, useLocalSearchParams } from "expo-router";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Check, Lightbulb, Pencil, ShieldCheck, Wand } from "../generated/icons";
import { Text } from "../ui/Text";
import { useSharedSettings } from "./settings-bridge";

const icons = { plan: Lightbulb, review: ShieldCheck, trusted: Pencil, autonomous: Wand } as const;

/** How the agent works: plan, or how much it may do before asking. Only the modes the agent offers. */
export function ModeSheet() {
  const { composerId } = useLocalSearchParams<{ composerId: string }>();
  const insets = useSafeAreaInsets();
  const settings = useSharedSettings(composerId);
  const agent = settings?.choice?.agent;
  const current = settings ? executionMode(settings.mode, settings.permission) : null;
  return (
    <View className="gap-1 bg-bg px-5 pt-6" style={{ paddingBottom: insets.bottom + 16 }}>
      <Text accessibilityRole="header" className="mb-2 text-xl">
        Mode
      </Text>
      {ExecutionMode.options
        .filter((mode) => executionModeAvailable(agent, mode))
        .map((mode) => {
          const Icon = icons[mode];
          const { label, hint } = executionModePresentation(agent, mode);
          return (
            <Pressable
              key={mode}
              accessibilityRole="radio"
              accessibilityState={{ checked: mode === current }}
              onPress={() => {
                if (!settings) return;
                void Haptics.selectionAsync();
                settings.selectExecutionMode(executionModeSettings(mode));
                router.back();
              }}
              className="min-h-touch-row flex-row items-center gap-3 rounded-md px-3 active:bg-surface-2"
            >
              <Icon size={16} className="text-ink-3" />
              <View className="min-w-0 flex-1">
                <Text className="text-md">{label}</Text>
                <Text className="text-sm text-ink-4">{hint}</Text>
              </View>
              {mode === current ? <Check size={16} /> : null}
            </Pressable>
          );
        })}
    </View>
  );
}
