import { catalogModel, pickerSettings } from "@openorc/client";
import { effortLabel, executionMode, executionModePresentation } from "@openorc/protocol";
import { router } from "expo-router";
import type { ReactNode } from "react";
import { Keyboard, Pressable } from "react-native";
import { Cloud, Laptop, Lightbulb, Pencil, ShieldCheck, Wand } from "../generated/icons";
import { cn } from "../ui/cn";
import { HarnessLogo } from "../ui/HarnessLogo";
import { Text } from "../ui/Text";
import { useComposerModels } from "./claude-account";
import type { ComposerSettings } from "./settings-bridge";

const modeIcons = { plan: Lightbulb, review: ShieldCheck, trusted: Pencil, autonomous: Wand } as const;

/**
 * A 28 pt chip on the composer's fill that opens one of the thread's native sheets. The keyboard goes first: a focused
 * prompt would keep it up over the sheet.
 */
function Chip({ label, children, onPress, round = false }: { label: string; children: ReactNode; onPress: () => void; round?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={() => {
        Keyboard.dismiss();
        onPress();
      }}
      hitSlop={{ top: 8, bottom: 8 }}
      className={cn("h-control-sm min-w-0 flex-shrink flex-row items-center gap-1.5 rounded-full bg-surface-2 pl-2 pr-2.5 active:bg-surface-3", round && "w-7 flex-shrink-0 justify-center px-0")}
    >
      {children}
    </Pressable>
  );
}

/** Where a new thread runs, as its mark alone, so the model and mode keep their names beside it. */
function PlaceChip({ composerId, place }: { composerId: string; place: "mac" | "cloud" }) {
  const Icon = place === "cloud" ? Cloud : Laptop;
  return (
    <Chip round label={`Runs on, ${place === "cloud" ? "Cloud" : "This Mac"}`} onPress={() => router.push({ pathname: "/place", params: { composerId } })}>
      <Icon size={14} className="text-ink-3" />
    </Chip>
  );
}

/** The model with its effort, the mode and, for a new thread the Mac could run in the cloud, where it runs; each opens its sheet for this composer. */
export function ComposerChips({ composerId, settings }: { composerId: string; settings: ComposerSettings }) {
  const models = useComposerModels(settings);
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
      {settings.place ? <PlaceChip composerId={composerId} place={settings.place.chosen} /> : null}
    </>
  );
}
