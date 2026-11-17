/**
 * The models OpenOrc Cloud runs for the person, from its machines' own agent CLIs: each listing mapped by the very code
 * that maps the same CLI's listing on this Mac. An agent the cloud has not read yet offers its CLI's default alone,
 * never this Mac's list or a written one.
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

export function cloudModelCatalog(answer: WireCloudModels): ModelCatalog {
  const entries = HOSTED_AGENTS.map((agent): { models: ModelOption[]; provider: ModelCatalogProvider } => {
    const entry = answer.agents.find((one) => one.agent === agent);
    if (!entry) return { models: [cliDefault(agent)], provider: { agent, status: "fallback", refreshedAt: null, message: null } };
    const { models, message } = optionsOf(entry);
    return { models, provider: { agent, status: "ready", refreshedAt: Date.parse(entry.readAt), message: message ?? null } };
  });
  return { models: entries.flatMap((entry) => entry.models), providers: entries.map((entry) => entry.provider) };
}
