import { harnessName, modelEfforts, normalizeModelEffort, type AgentKind, type HarnessId, type ModelOption } from "@openorc/protocol";
import { modelFastMode } from "./model-fast-mode";

export interface ModelChoice {
  agent: AgentKind;
  model: string;
  effort: string | null;
  fastMode?: boolean;
}

/** Catalog values used by both picker layouts after protocol defaults are normalized. */
export function pickerCatalog(options: ModelOption[]): ModelOption[] {
  return options.map((model) => ({
    ...model,
    efforts: modelEfforts(model.agent, model.id, model.efforts),
    defaultEffort: normalizeModelEffort(model.agent, model.id, model.defaultEffort),
  }));
}

/** Models grouped by billing provider in the order returned by the harness. */
export function providerGroups(options: ModelOption[], agent: HarnessId): [string | null, ModelOption[]][] {
  const groups = new Map<string, ModelOption[]>();
  for (const model of options) {
    const label = model.provider?.label ?? agent;
    groups.set(label, [...(groups.get(label) ?? []), model]);
  }
  const entries = [...groups.entries()];
  return entries.length > 1 ? entries : entries.map(([, group]) => [null, group]);
}

/** Harnesses that need provider names on individual rows. */
export function multiProviderAgents(list: ModelOption[]): Set<AgentKind> {
  const providers = new Map<AgentKind, Set<string>>();
  for (const model of list) providers.set(model.agent, new Set([...(providers.get(model.agent) ?? []), model.provider?.id ?? model.agent]));
  return new Set([...providers.entries()].filter(([, ids]) => ids.size > 1).map(([agent]) => agent));
}

/** Every query word must match the model, provider, or harness. */
export function matchesQuery(model: ModelOption, query: string): boolean {
  const haystack = `${model.label} ${model.id} ${model.provider?.label ?? ""} ${harnessName(model.agent)}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => haystack.includes(word));
}

export function catalogModel(list: ModelOption[] | undefined, value: ModelChoice | null): ModelOption | undefined {
  return value ? list?.find((model) => model.agent === value.agent && model.id === value.model) : undefined;
}

/** Both layouts show the same effort and Fast state for a pinned model. */
export function pickerSettings(input: { model: ModelOption | undefined; value: ModelChoice | null; loading: boolean; failed: boolean }) {
  const model = input.model;
  const efforts = model ? modelEfforts(model.agent, model.id, model.efforts) : [];
  const defaultEffort = model ? normalizeModelEffort(model.agent, model.id, model.defaultEffort) : null;
  const effort = input.value?.effort ?? defaultEffort;
  const effortIndex = effort ? efforts.indexOf(effort) : -1;
  const fast = Boolean(input.value?.fastMode);
  const { supported: fastAvailable, blocked: fastBlocked, hint: fastHint } = modelFastMode(model, input.loading, input.failed);
  return { efforts, defaultEffort, effort, effortIndex, fast, fastAvailable, fastBlocked, fastHint };
}

export function browserModels(input: { list: ModelOption[]; section: HarnessId | "teams"; query: string }) {
  const options = input.section === "teams" ? [] : input.list.filter((model) => model.agent === input.section);
  const legacy = options.filter((model) => model.legacy);
  const searching = input.query.trim().length > 0;
  const visible = options.filter((model) => (searching || !model.legacy) && (!searching || matchesQuery(model, input.query)));
  return { legacy, searching, visible, multiProvider: multiProviderAgents(input.list) };
}

/** A model change resets effort to its advertised default and retains Fast only where supported. */
export function modelChoiceFor(model: ModelOption, previous: ModelChoice | null): ModelChoice {
  return {
    agent: model.agent,
    model: model.id,
    effort: model.defaultEffort ?? (model.efforts.includes(previous?.effort ?? "") ? (previous?.effort ?? null) : null),
    fastMode: Boolean(previous?.fastMode && previous.agent === model.agent && model.fastMode?.supported),
  };
}

/** The provider's default usable model, retaining the catalog's default effort. */
export function defaultChoice(list: ModelOption[], prefer: AgentKind | null): ModelChoice | null {
  const usable = list.filter((model) => !model.unavailable && !model.legacy);
  const pick =
    usable.find((model) => model.agent === (prefer ?? model.agent) && model.isDefault) ?? usable.find((model) => model.agent === prefer) ?? usable.find((model) => model.isDefault) ?? usable[0];
  return pick ? { agent: pick.agent, model: pick.id, effort: pick.defaultEffort } : null;
}
