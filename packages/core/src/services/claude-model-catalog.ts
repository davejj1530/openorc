import { ULTRACODE_EFFORT, harnessCatalog, type ModelOption } from "@openorc/protocol";
import { claudeFastModeReason, type ClaudeModel } from "@openorc/agents";
import type { DiscoveredModels } from "./model-catalog.js";

/** The family and version the pinned ID carries; the CLI's own name when the ID carries none. */
export function claudeModelLabel(id: string, displayName: string): string {
  const match = /^claude-(?:([a-z]+)-(\d+(?:-\d+)*?)|(\d+(?:-\d+)*?)-([a-z]+))(?:-\d{8})?(\[1m\])?$/.exec(id);
  if (!match) return displayName;
  const family = match[1] ?? match[4]!;
  const version = (match[2] ?? match[3]!).replaceAll("-", ".");
  return `${family[0]!.toUpperCase()}${family.slice(1)} ${version}${match[5] ? " (1M context)" : ""}`;
}

/** Pin aliases only when the CLI provides their actual wire model ID. */
export function claudeModelsFrom(rows: ClaudeModel[], fallback: ModelOption[], ultracode: boolean, env: Readonly<NodeJS.ProcessEnv>): DiscoveredModels {
  const fastDisabled =
    env["CLAUDE_CODE_DISABLE_FAST_MODE"] === "1" || ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"].some((key) => /^(1|true)$/i.test(env[key] ?? ""));
  const models = rows.map((row): ModelOption => {
    const explicit = row.resolvedModel || row.value;
    const pinned = /^claude-[a-z0-9-]*\d[a-z0-9-]*(?:\[\w+\])?$/.test(explicit) && !explicit.endsWith("-latest");
    const known = fallback.find((m) => m.id === explicit);
    const efforts = row.supportsEffort === false ? [] : [...new Set(row.supportedEffortLevels ?? known?.efforts.filter((e) => e !== ULTRACODE_EFFORT) ?? [])];
    if (efforts.includes("xhigh") && ultracode && !efforts.includes(ULTRACODE_EFFORT)) efforts.push(ULTRACODE_EFFORT);
    return {
      id: explicit,
      label: claudeModelLabel(explicit, row.displayName),
      agent: "claude",
      provider: harnessCatalog.claude.account,
      isDefault: false,
      efforts,
      defaultEffort: efforts.includes("medium") ? "medium" : null,
      ...modelFastMode({ disabled: fastDisabled, advertised: row.supportsFastMode }),
      ...modelAvailability(pinned, known),
    };
  });
  if (!models.some((m) => !m.unavailable)) return { models: fallback, message: "Compatibility catalog: this CLI did not return selectable pinned model IDs. Run claude update, then Refresh models." };
  const unique = [...new Map(models.map((m) => [m.id, m])).values()];
  const preferred = unique.find((m) => !m.unavailable && m.id.includes("sonnet")) ?? unique.find((m) => !m.unavailable);
  if (preferred) preferred.isDefault = true;
  return { models: unique };
}

function modelFastMode({ disabled, advertised }: { disabled: boolean; advertised: boolean | undefined }): Pick<ModelOption, "fastMode"> {
  if (disabled) return { fastMode: { supported: false, reason: "Fast mode is disabled by this connection." } };
  if (advertised === undefined) return {};
  if (advertised) return { fastMode: { supported: true } };
  return { fastMode: { supported: false, reason: "The installed Claude Code does not advertise Fast mode for this model." } };
}

/** Older generations follow the CLI's own rows; a live row for the same model, with or without [1m], wins. */
export function withClaudeLegacyModels(discovered: DiscoveredModels, legacy: ModelOption[]): DiscoveredModels {
  const listed = new Set(discovered.models.map((m) => m.id.replace(/\[\w+\]$/, "")));
  return { ...discovered, models: [...discovered.models, ...legacy.filter((m) => !listed.has(m.id)).map((m) => ({ ...m, legacy: true, isDefault: false }))] };
}

/**
 * Claude Code checks Fast access for the account, not per model: when it
 * cannot serve Fast, no model offers it. Its allowed-models check ran against
 * the CLI's default model rather than each row, so that one is left to the run.
 */
export function withClaudeAccountFastMode(discovered: DiscoveredModels, code: string | undefined): DiscoveredModels {
  const reason = code === "model_not_allowed" ? null : claudeFastModeReason(code);
  if (!reason) return discovered;
  return { ...discovered, models: discovered.models.map((m) => (m.fastMode?.supported ? { ...m, fastMode: { supported: false, reason } } : m)) };
}

function modelAvailability(pinned: boolean, known: ModelOption | undefined): Pick<ModelOption, "unavailable"> {
  if (!pinned) return { unavailable: "Update Claude Code to resolve this alias to a pinned model version. Run claude update." };
  if (known?.unavailable) return { unavailable: known.unavailable };
  return {};
}
