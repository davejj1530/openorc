import { modelChoiceFor, pickerCatalog, pickerSettings, providerGroups, catalogModel } from "@openorc/client";
import { effortLabel, harnessShortName, isHarnessId, type ModelOption } from "@openorc/protocol";
import * as Haptics from "expo-haptics";
import { useLocalSearchParams } from "expo-router";
import { Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRpc } from "../client";
import { Check } from "../generated/icons";
import { cn } from "../ui/cn";
import { HarnessLogo } from "../ui/HarnessLogo";
import { Text } from "../ui/Text";
import { useSharedSettings } from "./settings-bridge";

/** The models the thread can run, by harness: the current one checked, its effort levels as a segmented row below. */
export function ModelSheet() {
  const { threadId } = useLocalSearchParams<{ threadId: string }>();
  const insets = useSafeAreaInsets();
  const settings = useSharedSettings(threadId);
  const models = useRpc("agents.models", {}, { staleTime: 5 * 60_000 });
  const catalog = pickerCatalog(models.data ?? []).filter((model) => !model.legacy);
  const choice = settings?.choice ?? null;
  const current = catalogModel(catalog, choice);
  const { efforts, effort } = pickerSettings({ model: current, value: choice, loading: models.isLoading, failed: Boolean(models.error) });
  const agents = [...new Set(catalog.map((model) => model.agent))];
  const pick = (model: ModelOption) => {
    if (!settings || model.unavailable) return;
    void Haptics.selectionAsync();
    settings.selectModel(modelChoiceFor(model, choice));
  };
  return (
    <ScrollView className="flex-1 bg-bg" contentContainerClassName="gap-5 px-5 pt-6" contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}>
      <Text accessibilityRole="header" className="text-xl">
        Model
      </Text>
      {current && efforts.length ? (
        <View className="gap-2">
          <Text className="text-sm text-ink-4">Effort</Text>
          <View className="flex-row rounded-full bg-surface-2 p-0.75">
            {efforts.map((level) => (
              <Pressable
                key={level}
                accessibilityRole="radio"
                accessibilityState={{ checked: level === effort }}
                onPress={() => settings && choice && settings.selectModel({ ...choice, effort: level })}
                className={cn("h-control-md flex-1 items-center justify-center rounded-full", level === effort && "bg-surface")}
              >
                <Text className={cn("text-sm text-ink-3", level === effort && "text-ink")}>{effortLabel(level)}</Text>
              </Pressable>
            ))}
          </View>
        </View>
      ) : null}
      {agents.map((agent) => (
        <View key={agent} className="gap-1">
          <View className="flex-row items-center gap-2 pb-1">
            <HarnessLogo agent={agent} size={14} />
            <Text className="text-sm text-ink-4">{isHarnessId(agent) ? harnessShortName(agent) : agent}</Text>
          </View>
          {providerGroups(
            catalog.filter((model) => model.agent === agent),
            isHarnessId(agent) ? agent : "codex",
          ).map(([provider, group]) => (
            <View key={provider ?? agent}>
              {provider ? <Text className="pb-1 pt-2 text-xs text-ink-4">{provider}</Text> : null}
              {group.map((model) => {
                const on = model.agent === choice?.agent && model.id === choice?.model;
                return (
                  <Pressable
                    key={`${model.agent}:${model.id}`}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: on, disabled: Boolean(model.unavailable) }}
                    disabled={Boolean(model.unavailable)}
                    onPress={() => pick(model)}
                    className="min-h-touch flex-row items-center gap-3 rounded-md px-3 active:bg-surface-2"
                  >
                    <View className="min-w-0 flex-1">
                      <Text className={cn("text-md", model.unavailable && "text-ink-4")}>{model.label}</Text>
                      {model.unavailable ? <Text className="text-sm text-ink-4">{model.unavailable}</Text> : null}
                    </View>
                    {on ? <Check size={16} /> : null}
                  </Pressable>
                );
              })}
            </View>
          ))}
        </View>
      ))}
    </ScrollView>
  );
}
