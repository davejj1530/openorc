import { Host, Menu, Picker, RNHostView, Text as MenuText } from "@expo/ui/swift-ui";
import { accessibilityLabel, accessibilityValue, pickerStyle, tag } from "@expo/ui/swift-ui/modifiers";
import { effortLabel, type ModelExecutionSettings, type OrclingPermission } from "@openorc/protocol";
import { router } from "expo-router";
import { View } from "react-native";
import { useRpc } from "../client";
import { ChevronRight, ChevronsUpDown, ShieldCheck } from "../generated/icons";
import { RowLines, rowClass } from "../settings/parts";
import { cn } from "../ui/cn";
import { haptic } from "../ui/haptics";
import { HarnessLogo } from "../ui/HarnessLogo";
import { ListPressable } from "../ui/ListPressable";
import { useMode } from "../ui/mode";
import { Text } from "../ui/Text";

const PERMISSIONS: readonly { value: OrclingPermission; label: string }[] = [
  { value: "approve", label: "Approve" },
  { value: "allow", label: "Allow" },
];

/** The model it runs on as the Mac names it, with its effort; without one, whether the Mac is still saying. */
function useModelLabel(settings: ModelExecutionSettings | null, loading: boolean): string {
  const models = useRpc("agents.models", {}, { staleTime: 5 * 60_000 });
  if (!settings) return loading ? "Loading…" : "Choose a model";
  const model = models.data?.find((each) => each.agent === settings.agent && each.id === settings.model)?.label ?? settings.model;
  return settings.effort ? `${model} · ${effortLabel(settings.effort)}` : model;
}

/**
 * What it runs on, opening the model sheet that `composerId` shares its model through. A new Orcling has none while the
 * Mac's default loads, or when the Mac has no agent to run; the sheet then says how to get one.
 */
export function ModelRow({ settings, loading = false, composerId }: { settings: ModelExecutionSettings | null; loading?: boolean; composerId: string }) {
  const model = useModelLabel(settings, loading);
  return (
    <ListPressable
      accessibilityRole="button"
      accessibilityLabel={`Model, ${model}`}
      onPress={() => router.push({ pathname: "/model", params: { composerId } })}
      className={cn(rowClass, "active:bg-surface-2")}
    >
      <RowLines
        lead={settings ? <HarnessLogo agent={settings.agent} size={16} /> : null}
        label="Model"
        trailing={
          <View className="max-w-56 flex-row items-center gap-1">
            <Text numberOfLines={1} className="shrink text-md text-ink-4">
              {model}
            </Text>
            <ChevronRight size={14} className="text-ink-4" />
          </View>
        }
      />
    </ListPressable>
  );
}

/** Approve or Allow, from iOS's own pull-down menu, as Settings picks a value. */
export function PermissionRow({ value, onChange }: { value: OrclingPermission; onChange: (value: OrclingPermission) => void }) {
  const label = PERMISSIONS.find((each) => each.value === value)!.label;
  return (
    <Host matchContents={{ vertical: true }} colorScheme={useMode()}>
      <Menu
        modifiers={[accessibilityLabel("Permission"), accessibilityValue(label)]}
        label={
          <RNHostView matchContents={{ vertical: true }}>
            <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" className={rowClass}>
              <RowLines
                lead={<ShieldCheck size={16} className="text-ink-4" />}
                label="Permission"
                trailing={
                  <View className="flex-row items-center gap-1">
                    <Text className="text-md text-ink-4">{label}</Text>
                    <ChevronsUpDown size={14} className="text-ink-4" />
                  </View>
                }
              />
            </View>
          </RNHostView>
        }
      >
        <Picker
          selection={value}
          onSelectionChange={(next: OrclingPermission) => {
            if (next === value) return;
            haptic.select();
            onChange(next);
          }}
          modifiers={[pickerStyle("inline")]}
        >
          {PERMISSIONS.map((each) => (
            <MenuText key={each.value} modifiers={[tag(each.value)]}>
              {each.label}
            </MenuText>
          ))}
        </Picker>
      </Menu>
    </Host>
  );
}
