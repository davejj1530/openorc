import { runs as runRepo, type Db } from "@openorc/db";
import type { AgentKind, ModelOption } from "@openorc/protocol";
import { squash } from "../services/thread-agent-tools.js";

/** An agent with this many current models gets a short list, as the phone's model sheet does. */
const SHORT_LIST_FROM = 13;
/** Models the person used lately that a short list offers besides the default. */
const RECENTS_SHOWN = 3;
/** The most matches a search returns. */
const MATCHES_SHOWN = 40;

const providerOf = (model: ModelOption) => model.provider?.label?.trim() || "Other";

/** One model as the Orcling reads it: what to pass to start work on it, and why it is listed. */
function line(model: ModelOption, named: boolean, note?: string) {
  return {
    id: model.id,
    label: model.label,
    ...(note ? { note } : {}),
    ...(named ? { provider: providerOf(model) } : {}),
    ...(model.efforts.length ? { efforts: model.efforts, defaultEffort: model.defaultEffort } : {}),
    ...(model.fastMode?.supported ? { fast: true } : {}),
    ...(model.legacy ? { older: true } : {}),
    ...(model.unavailable ? { unavailable: model.unavailable } : {}),
  };
}

/** Why a model in a whole list matters to the person, if it does. */
function noteFor(model: ModelOption, lastUsed: string | undefined): string | undefined {
  if (model.id === lastUsed) return "Last used";
  return model.isDefault ? "The agent's default" : undefined;
}

/** Whether a model fits every word of a search, in its id, its name or its provider. */
function fits(model: ModelOption, search: string): boolean {
  const hay = squash(`${model.id} ${model.label} ${providerOf(model)}`);
  return search
    .split(/\s+/)
    .map(squash)
    .filter(Boolean)
    .every((word) => hay.includes(word));
}

/**
 * One agent's models for the Orcling, short enough to read. A search looks through all of them, older ones too. A small
 * catalog comes whole; a large one comes as the models that matter to the person (last used, used lately, the agent's
 * default) and a count per provider, with a search to find the rest.
 */
export function agentModels(db: Db, agent: AgentKind, options: readonly ModelOption[], search: string | undefined) {
  const named = new Set(options.map(providerOf)).size > 1;
  const current = options.filter((model) => !model.legacy);
  if (search?.trim()) {
    const found = options.filter((model) => fits(model, search));
    return {
      agent,
      count: options.length,
      matches: found.slice(0, MATCHES_SHOWN).map((model) => line(model, named)),
      ...(found.length > MATCHES_SHOWN ? { more: `${found.length - MATCHES_SHOWN} more match; narrow the search.` } : {}),
    };
  }
  const recent = runRepo.recentModels(db, agent, RECENTS_SHOWN + 1, { people: true });
  if (current.length < SHORT_LIST_FROM) {
    return { agent, count: current.length, models: current.map((model) => line(model, named, noteFor(model, recent[0]))) };
  }
  const picks = new Map<string, ReturnType<typeof line>>();
  const pick = (model: ModelOption | undefined, note: string) => {
    if (model && !model.unavailable && !picks.has(model.id)) picks.set(model.id, line(model, named, note));
  };
  pick(
    current.find((model) => model.id === recent[0]),
    "Last used",
  );
  for (const id of recent.slice(1))
    pick(
      current.find((model) => model.id === id),
      "Used lately",
    );
  pick(
    current.find((model) => model.isDefault),
    "The agent's default",
  );
  const providers = new Map<string, number>();
  for (const model of current) providers.set(providerOf(model), (providers.get(providerOf(model)) ?? 0) + 1);
  return {
    agent,
    count: current.length,
    suggested: [...picks.values()],
    providers: [...providers].map(([provider, models]) => ({ provider, models })),
    more: `Pass agent "${agent}" with a search, such as a model or a provider's name, to find the others.`,
  };
}
