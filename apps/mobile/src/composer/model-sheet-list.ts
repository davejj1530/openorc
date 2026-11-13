import { matchesQuery, type ModelChoice } from "@openorc/client";
import type { AgentKind, ModelOption } from "@openorc/protocol";

/** Show a short list starting at this many current models. */
export const SHORT_LIST_FROM = 13;
/** Recent models offered for one agent, besides the current and default ones. */
const RECENTS_SHOWN = 3;

export type SheetModel = { model: ModelOption; note: string | null };

/** What the Model sheet lists for one agent: matches, one provider's models, everything, or the short list. */
export type SheetList =
  | { kind: "search"; models: SheetModel[] }
  | { kind: "provider"; provider: string; models: SheetModel[]; olderHidden: number }
  | { kind: "all"; models: SheetModel[] }
  | { kind: "short"; suggested: SheetModel[]; providers: { label: string; count: number }[]; models: SheetModel[] };

const key = (model: { agent: AgentKind; id: string }) => `${model.agent}:${model.id}`;
const providerOf = (model: ModelOption) => model.provider?.label?.trim() || "Other";

/**
 * One agent's models in the sheet. A search looks through all of them, older ones too. Otherwise a short list of the
 * current, recent and default models comes first, then one row per provider to open, or every model when it has one.
 */
export function sheetList(input: {
  /** Every model the composer can run, older ones too. */
  catalog: ModelOption[];
  agent: AgentKind;
  choice: ModelChoice | null;
  /** Models picked on this phone, newest first, as `agent:id`. */
  recents: string[];
  query: string;
  provider: string | null;
}): SheetList {
  const own = input.catalog.filter((model) => model.agent === input.agent);
  const providers = new Set(own.map(providerOf));
  const named = providers.size > 1;
  const row = (model: ModelOption, note: string | null = null): SheetModel => ({
    model,
    note: [note, named ? providerOf(model) : null, model.legacy ? "Older" : null].filter(Boolean).join(" · ") || null,
  });
  if (input.query.trim()) return { kind: "search", models: own.filter((model) => matchesQuery(model, input.query)).map((model) => row(model)) };
  const current = own.filter((model) => !model.legacy);
  if (input.provider !== null && named) {
    const theirs = own.filter((model) => providerOf(model) === input.provider);
    return { kind: "provider", provider: input.provider, models: theirs.filter((model) => !model.legacy).map((model) => row(model)), olderHidden: theirs.filter((model) => model.legacy).length };
  }
  if (current.length < SHORT_LIST_FROM) return { kind: "all", models: current.map((model) => row(model)) };
  const suggested = new Map<string, SheetModel>();
  const add = (model: ModelOption | undefined, note: string) => {
    if (model && !model.unavailable && !suggested.has(key(model))) suggested.set(key(model), row(model, note));
  };
  // The chosen model is listed even when older, so the person sees what they are on.
  add(input.choice ? own.find((model) => model.id === input.choice!.model && model.agent === input.choice!.agent) : undefined, "Current");
  for (const recent of input.recents.filter((each) => each.startsWith(`${input.agent}:`)).slice(0, RECENTS_SHOWN))
    add(
      current.find((model) => key(model) === recent),
      "Recent",
    );
  add(
    current.find((model) => model.isDefault),
    "Default",
  );
  const counts = new Map<string, number>();
  for (const model of current) counts.set(providerOf(model), (counts.get(providerOf(model)) ?? 0) + 1);
  return {
    kind: "short",
    suggested: [...suggested.values()],
    providers: named ? [...counts.entries()].map(([label, count]) => ({ label, count })) : [],
    models: named ? [] : current.filter((model) => !suggested.has(key(model))).map((model) => row(model)),
  };
}
