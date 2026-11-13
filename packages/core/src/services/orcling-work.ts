import { claudeAccounts, runs as runRepo, type Db } from "@openorc/db";
import { STAY_QUIET } from "./orcling-quiet.js";
import type { OrclingWorker } from "@openorc/mcp";
import { executionModeAvailable, executionModeLabel, executionModeUnavailable, type AgentKind, type ExecutionMode, type ModelOption, type Thread } from "@openorc/protocol";
import { modelsNamed, pickModel, squash } from "./thread-agent-tools.js";

/** What work an Orcling hands out runs on: the agent, model, effort and Fast mode, and the Claude account that pays. */
export interface WorkSettings {
  agent: AgentKind;
  /** Unset leaves the agent's own default. */
  model: string | undefined;
  effort: string | undefined;
  fastMode: boolean;
  claudeAccountId: string | undefined;
}

/** What the person has to choose from: the agents they turned on, the one new threads start on, and each agent's models. */
export interface WorkCatalog {
  enabled(): readonly AgentKind[];
  defaultAgent(): AgentKind | null;
  /** An agent's models, as a Claude account sees them when one is named. */
  models(agent: AgentKind, claudeAccountId?: string): Promise<ModelOption[]>;
}

/** Spoken names for effort levels, matched once spaces and dashes are gone. */
const EFFORT_NAMES: Record<string, string> = { extrahigh: "xhigh", veryhigh: "xhigh", maximum: "max", med: "medium", minimum: "minimal" };

const usable = (option: ModelOption) => !option.unavailable && !option.legacy;

/**
 * The settings work runs on, as the person would pick them: the agent and model named, matched loosely; a model named
 * alone is looked for across the agents they turned on; otherwise the agent new threads start on. An agent without a
 * model named runs on the model last used with it, else its default, never a legacy one or one that can't run.
 */
export async function workSettings(db: Db, catalog: WorkCatalog, chosen: Extract<OrclingWorker, { kind: "agent" }>): Promise<WorkSettings> {
  // A Claude account means Claude, and its models are the ones that account can run.
  const worker = chosen.claudeAccount ? { ...chosen, agent: chosen.agent ?? ("claude" as const) } : chosen;
  const claudeAccountId = accountNamed(db, worker.agent, worker.claudeAccount);
  if (worker.agent && !catalog.enabled().includes(worker.agent)) throw new Error(`${worker.agent} is turned off. The person can turn it on in Settings.`);
  const models = (agent: AgentKind) => catalog.models(agent, claudeAccountId);
  const { agent, model } = await agentAndModel(db, { ...catalog, models }, worker);
  if (worker.fast && model?.fastMode?.supported === false) throw new Error(`${model.label} can't use Fast mode${model.fastMode.reason ? `: ${model.fastMode.reason}` : "."}`);
  return {
    agent,
    model: model?.id,
    effort: pickEffort(model, worker.effort),
    fastMode: worker.fast ?? false,
    claudeAccountId,
  };
}

async function agentAndModel(db: Db, catalog: WorkCatalog, worker: Extract<OrclingWorker, { kind: "agent" }>): Promise<{ agent: AgentKind; model: ModelOption | null }> {
  if (worker.agent) {
    const options = await catalog.models(worker.agent);
    return { agent: worker.agent, model: worker.model ? pickModel(options, worker.agent, worker.model) : (lastUsed(db, worker.agent, options) ?? fallback(options)) };
  }
  if (worker.model) return modelAnywhere(catalog, worker.model);
  const usual = newThreadAgent(db, catalog.defaultAgent(), catalog.enabled());
  if (!usual) throw new Error("The person hasn't turned on any agents. They can in Settings.");
  const { agent } = usual;
  const options = await catalog.models(agent);
  return { agent, model: lastUsed(db, agent, options) ?? fallback(options) };
}

/**
 * The agent new work starts on, and why: the one the person chose in Settings while it is on, else the one they have run
 * their own work on most lately, else the first they turned on. Null when none is on.
 */
export function newThreadAgent(db: Db, chosen: AgentKind | null, enabled: readonly AgentKind[]): { agent: AgentKind; why: string } | null {
  if (chosen && enabled.includes(chosen)) return { agent: chosen, why: "Chosen in Settings" };
  const used = runRepo.peopleAgents(db).find((agent) => enabled.includes(agent));
  if (used) return { agent: used, why: "No default is set in Settings, so the agent the person has used most lately" };
  const first = enabled[0];
  return first ? { agent: first, why: "No default is set in Settings and nothing has run yet, so the first agent turned on" } : null;
}

/** A model named without its agent: the one model it names across the person's agents, an exact name first. */
async function modelAnywhere(catalog: WorkCatalog, name: string): Promise<{ agent: AgentKind; model: ModelOption }> {
  // An agent whose models can't be listed right now offers none, rather than failing the search.
  const found = await Promise.all(catalog.enabled().map(async (agent) => ({ agent, options: await catalog.models(agent).catch(() => [] as ModelOption[]) })));
  const named = found.map(({ agent, options }) => ({ agent, ...modelsNamed(options, agent, name) }));
  const exact = named.filter((entry) => entry.exact);
  const matches = (exact.length ? exact : named).flatMap(({ agent, models }) => models.map((model) => ({ agent, model })));
  const only = matches.length === 1 ? matches[0]! : null;
  if (only?.model.unavailable) throw new Error(`${only.model.label} can't run right now: ${only.model.unavailable}`);
  if (only) return only;
  const listed = (entries: { agent: AgentKind; model: ModelOption }[]) => entries.map(({ agent, model }) => `${model.label} (${agent}, ${model.id})`).join(", ");
  if (matches.length) throw new Error(`"${name}" fits several models: ${listed(matches)}. Name the agent or the exact model.`);
  const all = found.flatMap(({ agent, options }) => options.filter(usable).map((model) => ({ agent, model })));
  throw new Error(`No model is called "${name}". Choose one of: ${listed(all) || "none available"}.`);
}

function lastUsed(db: Db, agent: AgentKind, options: readonly ModelOption[]): ModelOption | null {
  return (
    runRepo
      .recentModels(db, agent, 5, { people: true })
      .map((id) => options.find((option) => option.id === id && usable(option)))
      .find(Boolean) ?? null
  );
}

function fallback(options: readonly ModelOption[]): ModelOption | null {
  return options.find((option) => option.isDefault && usable(option)) ?? options.find(usable) ?? null;
}

/** An effort named loosely ("extra high") as the model calls it; its default when none is named. */
export function pickEffort(model: ModelOption | null, name: string | undefined): string | undefined {
  if (!name) return model?.defaultEffort ?? undefined;
  if (!model) return name;
  if (!model.efforts.length) throw new Error(`${model.label} has no effort setting.`);
  const wanted = squash(name).replace(/\./g, "");
  const found = model.efforts.find((effort) => squash(effort) === wanted || squash(effort) === EFFORT_NAMES[wanted]);
  if (!found) throw new Error(`${model.label} takes effort ${model.efforts.join(", ")}, not "${name}".`);
  return found;
}

function accountNamed(db: Db, agent: AgentKind | undefined, name: string | undefined): string | undefined {
  if (!name) return undefined;
  if (agent !== "claude") throw new Error(`Claude accounts are for Claude; ${agent} runs on its own sign-in.`);
  const accounts = claudeAccounts.list(db).filter((account) => account.enabled);
  const found = accounts.find((account) => squash(account.name) === squash(name)) ?? accounts.filter((account) => squash(account.name).includes(squash(name))).at(0);
  if (!found) throw new Error(`No Claude account is called "${name}". Choose one of: ${accounts.map((account) => account.name).join(", ") || "none on"}.`);
  return found.id;
}

const ACCESS_RANK: Record<ExecutionMode, number> = { plan: 0, review: 1, trusted: 2, autonomous: 3 };

/**
 * How freely work an Orcling starts runs: the access asked for, else the conversation's. It never goes past the
 * Orcling's own permission; asked for more, nothing starts, so the person is never told a thread runs freer than it does.
 */
export function workAccess(input: { asked: ExecutionMode | undefined; conversation: ExecutionMode; ceiling: ExecutionMode; orcling: string; agent: AgentKind }): ExecutionMode {
  const { asked, ceiling } = input;
  if (!asked) return input.conversation;
  if (ACCESS_RANK[asked] > ACCESS_RANK[ceiling])
    throw new Error(`${input.orcling} is set to Approve, so work it starts can run at most on ${executionModeLabel[ceiling]}. The person can set ${input.orcling} to Allow in its settings.`);
  const unavailable = executionModeUnavailable(input.agent, asked);
  if (!executionModeAvailable(input.agent, asked)) throw new Error(unavailable ?? `${input.agent} can't run on ${executionModeLabel[asked]}.`);
  return asked;
}

/** What work runs on, said the way the person would say it. */
export function describeWork(settings: WorkSettings, options: readonly ModelOption[]): string {
  const model = options.find((option) => option.id === settings.model);
  return [model?.label ?? settings.model ?? `${settings.agent}'s default model`, settings.effort, settings.fastMode ? "Fast" : null].filter(Boolean).join(", ");
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max).trimEnd()}…` : text);

const ENDINGS: Record<string, string> = { success: "finished its turn", cancelled: "was stopped", error: "failed" };

/** What an Orcling hears when a thread it asked about ends its turn: how it ended and what it said, quietly. Quoted words are the thread's, for the Orcling to weigh, never instructions to it. */
export function followupNote(thread: Thread, project: string, status: string, reply: string | null): string {
  const ended = ENDINGS[status] ?? "failed";
  // Its words, quoted for the Orcling to judge, never instructions to it.
  const said = reply?.trim() ? ` Its last reply, in its own words: "${clip(reply.replace(/\s+/g, " ").trim(), 600)}"` : "";
  return [
    `(OpenOrc: "${thread.title}" in ${project}, which you asked to hear back from, ${ended}.${said} Read more with orcling_thread_read, id ${thread.id}.)`,
    "",
    `If the person should know, or it needs a next step from you, act on it. Otherwise ${STAY_QUIET}.`,
  ].join("\n");
}
