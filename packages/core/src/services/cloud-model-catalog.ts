/**
 * The models OpenOrc Cloud runs for the person, from its machines' own agent CLIs: each listing mapped by the very code
 * that maps the same CLI's listing on this Mac. An agent the cloud has not read yet offers this Mac's own listing of it,
 * read from this Mac's CLI, as the person's sign-in there is most often the one they gave the cloud; with none, its
 * CLI's default alone. Never a written list. The cloud's own listing replaces this Mac's once it has one.
 */
import type { AcpModel, ClaudeCatalog, CodexModel } from "@openorc/agents";
import type { WireCloudModels } from "@openorc/hosted";
import { CLOUD_DEFAULT_MODEL, HOSTED_AGENTS, harnessCatalog, harnessShortName, type HostedAgent, type ModelCatalog, type ModelCatalogProvider, type ModelOption } from "@openorc/protocol";
import { acpOptions, claudeOptions, codexOptions } from "./run-catalog.js";

/** A cloud machine's environment, of which the app knows nothing: what Claude's Fast rules read from it is unset. */
const CLOUD_ENV: Readonly<NodeJS.ProcessEnv> = {};

function optionsOf(entry: WireCloudModels["agents"][number]): { models: ModelOption[]; message?: string } {
  if (entry.agent === "claude") return claudeOptions(entry.listing as ClaudeCatalog, entry.cliVersion, CLOUD_ENV);
  if (entry.agent === "codex") return { models: codexOptions(entry.listing as CodexModel[]) };
  return { models: acpOptions("opencode", entry.listing as AcpModel[], null) };
}

/** The one choice for an agent the cloud has not read: its CLI picks the model. */
const cliDefault = (agent: HostedAgent): ModelOption => ({
  id: CLOUD_DEFAULT_MODEL,
  label: `${harnessShortName(agent)} default`,
  agent,
  provider: harnessCatalog[agent].account,
  isDefault: true,
  efforts: [],
  defaultEffort: null,
  fastMode: { supported: false, reason: "Fast mode isn't offered until OpenOrc Cloud has read this agent's models." },
});

/** This Mac's listing of an agent, when its CLI here was read (now or before), not a written one; else none. */
function macListing(mac: ModelCatalog | null, agent: HostedAgent): { models: ModelOption[]; provider: ModelCatalogProvider } | null {
  const read = mac?.providers.find((provider) => provider.agent === agent && (provider.status === "ready" || provider.status === "stale"));
  const models = mac?.models.filter((model) => model.agent === agent) ?? [];
  return read && models.length ? { models, provider: { agent, status: "ready", refreshedAt: read.refreshedAt, message: null } } : null;
}

export function cloudModelCatalog(answer: WireCloudModels, mac: ModelCatalog | null): ModelCatalog {
  const entries = HOSTED_AGENTS.map((agent): { models: ModelOption[]; provider: ModelCatalogProvider } => {
    const entry = answer.agents.find((one) => one.agent === agent);
    if (!entry) return macListing(mac, agent) ?? { models: [cliDefault(agent)], provider: { agent, status: "fallback", refreshedAt: null, message: null } };
    const { models, message } = optionsOf(entry);
    return { models, provider: { agent, status: "ready", refreshedAt: Date.parse(entry.readAt), message: message ?? null } };
  });
  return { models: entries.flatMap((entry) => entry.models), providers: entries.map((entry) => entry.provider) };
}
