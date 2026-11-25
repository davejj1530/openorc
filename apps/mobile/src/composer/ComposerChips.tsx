import { catalogModel, pickerSettings, usageMeter } from "@openorc/client";
import { effortLabel, executionMode, executionModePresentation } from "@openorc/protocol";
import { router } from "expo-router";
import type { ReactNode } from "react";
import { Keyboard, Pressable } from "react-native";
import { Lightbulb, Pencil, ShieldCheck, Signal, Wand, Zap } from "../generated/icons";
import { cn } from "../ui/cn";
import { HarnessLogo } from "../ui/HarnessLogo";
import { ShareDisc } from "../ui/ShareDisc";
import { Text } from "../ui/Text";
import { useComposerModels } from "./claude-account";
import { useComposerUsage } from "./composer-usage";
import type { ComposerSettings } from "./settings-bridge";

const modeIcons = { plan: Lightbulb, review: ShieldCheck, trusted: Pencil, autonomous: Wand } as const;

/**
 * A 28 pt chip on the composer's fill that opens one of the thread's native sheets. The keyboard goes first: a focused
 * prompt would keep it up over the sheet. Short of room, a chip that `yields` gives up its words before the other
 * gives up any: a hundred times the other's share of what must go.
 */
function Chip({ label, yields = false, children, onPress }: { label: string; yields?: boolean; children: ReactNode; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={() => {
        Keyboard.dismiss();
        onPress();
      }}
      hitSlop={{ top: 8, bottom: 8 }}
      className={cn("h-control-sm min-w-0 shrink flex-row items-center gap-1 rounded-full bg-key pl-2 pr-2.5 active:bg-surface-3", yields && "shrink-100")}
    >
      {children}
    </Pressable>
  );
}

/**
 * The pill's meter, as the desktop's model pill ends with one: the week's share left on the account the pill's choice
 * runs on, filled on its disc, amber when a tenth or less is left; a plain glyph for a balance. The model sheet the
 * pill opens says the rest. Nothing for an account with no weekly limit, and until the Mac answers.
 */
function useChipMeter(settings: ComposerSettings) {
  const usage = useComposerUsage(settings);
  return usage ? usageMeter(usage.limits, usage.limits, null) : null;
}

function ChipMeter({ left, low }: { left: number | null; low: boolean }) {
  if (left === null) return <Signal size={13} className={low ? "text-warn" : "text-ink-3"} />;
  return <ShareDisc left={left} size={13} low={low} />;
}

/** The model with its effort and its account's usage, and the mode; each opens its sheet for this composer. */
export function ComposerChips({ composerId, settings }: { composerId: string; settings: ComposerSettings }) {
  const models = useComposerModels(settings);
  const meter = useChipMeter(settings);
  const { choice } = settings;
  const model = catalogModel(models.data, choice);
  const { effort, fast, fastBlocked } = pickerSettings({
    model: models.isPlaceholderData ? undefined : model,
    value: choice,
    loading: models.isLoading || models.isPlaceholderData,
    failed: Boolean(models.error),
  });
  const name = model?.label ?? choice?.model ?? "Model";
  const fastLabel = fastBlocked ? "Fast mode unavailable" : "Fast mode requested";
  const mode = executionMode(settings.mode, settings.permission);
  const modeLabel = executionModePresentation(choice?.agent, mode).label;
  const ModeIcon = modeIcons[mode];
  return (
    <>
      <Chip label={[`Model, ${name}`, fast ? fastLabel : null, meter?.words].filter(Boolean).join(", ")} onPress={() => router.push({ pathname: "/model", params: { composerId } })}>
        {choice ? <HarnessLogo agent={choice.agent} size={13} /> : null}
        <Text numberOfLines={1} className="min-w-0 flex-shrink text-sm text-ink-2">
          {name}
        </Text>
        {effort ? <Text className="text-sm text-ink-4">{effortLabel(effort)}</Text> : null}
        {fast ? <Zap size={13} className={fastBlocked ? "text-warn" : "text-ink-3"} /> : null}
        {meter ? <ChipMeter left={meter.left} low={meter.low} /> : null}
      </Chip>
      {/* The model's name is read before the mode's, whose glyph says it too. */}
      <Chip label={`Mode, ${modeLabel}`} yields onPress={() => router.push({ pathname: "/mode", params: { composerId } })}>
        <ModeIcon size={13} className="text-ink-4" />
        <Text numberOfLines={1} className="min-w-0 flex-shrink text-sm text-ink-2">
          {modeLabel}
        </Text>
      </Chip>
    </>
  );
}
