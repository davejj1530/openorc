import { catalogModel, pickerSettings } from "@openorc/client";
import { effortLabel, executionMode, executionModePresentation } from "@openorc/protocol";
import { router } from "expo-router";
import type { ReactNode } from "react";
import { Keyboard, Pressable } from "react-native";
import { useRpc } from "../client";
import { Lightbulb, Pencil, ShieldCheck, Wand } from "../generated/icons";
import { HarnessLogo } from "../ui/HarnessLogo";
import { Text } from "../ui/Text";
import type { ComposerSettings } from "./settings-bridge";

const modeIcons = { plan: Lightbulb, review: ShieldCheck, trusted: Pencil, autonomous: Wand } as const;

/**
 * A 28 pt chip on the composer's fill that opens one of the thread's native sheets. The keyboard goes first: a focused
 * prompt would keep it up over the sheet.
 */
function Chip({ label, children, onPress }: { label: string; children: ReactNode; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={() => {
        Keyboard.dismiss();
        onPress();
      }}
      hitSlop={{ top: 8, bottom: 8 }}
      className="h-control-sm min-w-0 flex-shrink flex-row items-center gap-1.5 rounded-full bg-surface-2 pl-2 pr-2.5 active:bg-surface-3"
    >
      {children}
    </Pressable>
  );
}

/** The model with its effort, and the mode, as the desktop's composer shows them; each opens its sheet for this composer. */
export function ComposerChips({ composerId, settings }: { composerId: string; settings: ComposerSettings }) {
  const models = useRpc("agents.models", {}, { staleTime: 5 * 60_000 });
  const { choice } = settings;
  const model = catalogModel(models.data, choice);
  const { effort } = pickerSettings({ model, value: choice, loading: models.isLoading, failed: Boolean(models.error) });
  const name = model?.label ?? choice?.model ?? "Model";
  const mode = executionMode(settings.mode, settings.permission);
  const modeLabel = executionModePresentation(choice?.agent, mode).label;
  const ModeIcon = modeIcons[mode];
  return (
    <>
      <Chip label={`Model, ${name}`} onPress={() => router.push({ pathname: "/model", params: { composerId } })}>
        {choice ? <HarnessLogo agent={choice.agent} size={13} /> : null}
        <Text numberOfLines={1} className="min-w-0 flex-shrink text-sm text-ink-2">
          {name}
        </Text>
        {effort ? <Text className="text-sm text-ink-4">{effortLabel(effort)}</Text> : null}
      </Chip>
      <Chip label={`Mode, ${modeLabel}`} onPress={() => router.push({ pathname: "/mode", params: { composerId } })}>
        <ModeIcon size={13} className="text-ink-4" />
        <Text numberOfLines={1} className="min-w-0 flex-shrink text-sm text-ink-2">
          {modeLabel}
        </Text>
      </Chip>
    </>
  );
}
