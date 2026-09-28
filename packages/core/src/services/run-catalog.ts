import { claudeModelsFrom, withClaudeAccountFastMode, withClaudeLegacyModels } from "./claude-model-catalog.js";
import { ModelCatalogCache, type DiscoveredModels } from "./model-catalog.js";
import { captureLaunchEnvironment, listClaudeModels, type AcpAdapter, type AgentLaunchEnvironment, type CodexAdapter } from "@openorc/agents";
import { ULTRACODE_EFFORT } from "@openorc/protocol";
import { harnessCatalog, harnessIds, type HarnessId, type ModelCatalog, type ModelOption } from "@openorc/protocol";
import type { RunHooks } from "./run-types.js";
import type { EnvSnapshot } from "./shell-environment.js";

/** "2.1.170 (Claude Code)" is at least "2.1.251"? Compared numerically, part by part. */
export function versionAtLeast(installed: string | null, required: string): boolean {
  const parse = (v: string) => (/\d+(?:\.\d+)*/.exec(v)?.[0] ?? "0").split(".").map(Number);
  if (!installed) return false;
  const a = parse(installed);
  const b = parse(required);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

const claudeEfforts = ["low", "medium", "high", "xhigh", "max"];
/** The first Claude Code verified to take `--effort ultracode` in print mode. */
const ULTRACODE_MIN_CLI = "2.1.278";

/** The first Claude Code that takes Fast mode on the models that offer it. */
const FAST_MODE_MIN_CLI = "2.1.219";

interface StaticClaudeModel {
  id: string;
  label: string;
  efforts: string[];
  fast: boolean;
  isDefault?: boolean;
  minCli?: string;
}

/**
 * Explicit-ID compatibility fallback for CLIs that cannot resolve their model aliases.
 * Runtime discovery is authoritative whenever it provides pinned model IDs.
 */
const claudeModels: StaticClaudeModel[] = [
  { id: "claude-sonnet-5", label: "Claude Sonnet 5", efforts: claudeEfforts, fast: false, isDefault: true },
  { id: "claude-opus-5", label: "Claude Opus 5", efforts: claudeEfforts, fast: true },
  { id: "claude-fable-5-1", label: "Claude Fable 5.1", efforts: claudeEfforts, fast: false, minCli: "2.1.251" },
  { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5", efforts: claudeEfforts, fast: false },
];

/**
 * Older generations the CLI no longer advertises but still runs by explicit ID.
 * Efforts and Fast mode were read back from Claude Code 2.1.280 for each ID;
 * minimum versions follow the first release that shipped the model.
 */
const claudeLegacyModels: StaticClaudeModel[] = [
  { id: "claude-opus-5", label: "Opus 5", efforts: claudeEfforts, fast: true, minCli: FAST_MODE_MIN_CLI },
  { id: "claude-fable-5", label: "Fable 5", efforts: claudeEfforts, fast: false, minCli: "2.1.169" },
  { id: "claude-opus-4-8", label: "Opus 4.8", efforts: claudeEfforts, fast: true, minCli: "2.1.154" },
  { id: "claude-opus-4-7", label: "Opus 4.7", efforts: claudeEfforts, fast: false, minCli: "2.1.111" },
  { id: "claude-opus-4-6", label: "Opus 4.6", efforts: ["low", "medium", "high", "max"], fast: false },
  { id: "claude-opus-4-5", label: "Opus 4.5", efforts: ["low", "medium", "high"], fast: false },
  { id: "claude-sonnet-4-6", label: "Sonnet 4.6", efforts: ["low", "medium", "high", "max"], fast: false },
];

function fastUnavailableReason(model: StaticClaudeModel, installed: string | null, env: Readonly<NodeJS.ProcessEnv>): string | undefined {
  if (!model.fast) return "Fast mode is not offered for this model.";
  if (!versionAtLeast(installed, FAST_MODE_MIN_CLI)) return `Fast mode on ${model.label} needs Claude Code ${FAST_MODE_MIN_CLI} or newer. Run claude update.`;
  if (env["CLAUDE_CODE_DISABLE_FAST_MODE"] === "1") return "Fast mode is disabled by your environment.";
  if (["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"].some((key) => /^(1|true)$/i.test(env[key] ?? ""))) {
    return "Fast mode requires the Anthropic API or a Claude subscription.";
  }
  return undefined;
}

/** Models the installed Claude Code can actually run; newer models stay listed with the reason they cannot. */
function claudeModelList(list: StaticClaudeModel[], installed: string | null, env: Readonly<NodeJS.ProcessEnv>): ModelOption[] {
  return list.map(({ minCli, fast, ...listed }) => {
    // Ultracode sits after Max: the same reasoning as xhigh, plus workflow orchestration.
    const efforts = listed.efforts.includes("xhigh") && versionAtLeast(installed, ULTRACODE_MIN_CLI) ? [...listed.efforts, ULTRACODE_EFFORT] : listed.efforts;
    const m: ModelOption = { ...listed, agent: "claude", isDefault: listed.isDefault ?? false, efforts, defaultEffort: "medium", provider: harnessCatalog.claude.account };
    if (minCli && !versionAtLeast(installed, minCli)) {
      return {
        ...m,
        isDefault: false,
        unavailable: installed ? `Needs Claude Code ${minCli} or newer. Run claude update.` : `Needs Claude Code ${minCli} or newer. Claude Code was not found on this app's PATH.`,
      };
    }
    const reason = fastUnavailableReason({ ...listed, fast }, installed, env);
    return { ...m, fastMode: reason ? { supported: false, reason } : { supported: true } };
  });
}

/** Provider catalog discovery and update fencing have one owner. */
export class RunCatalog {
  private pendingCatalogs = 0;
  private readonly modelCache = new ModelCatalogCache();

  constructor(
    private readonly hooks: Pick<RunHooks, "environment" | "claudeVersion">,
    private readonly codex: Pick<CodexAdapter, "listModels">,
    private readonly opencode: Pick<AcpAdapter, "listModels">,
    private readonly assertAvailable: () => void,
  ) {}

  get pending(): number {
    return this.pendingCatalogs;
  }

  async modelCatalog(agent?: HarnessId, refresh = false, environment: EnvSnapshot = this.hooks.environment(), admitted?: AgentLaunchEnvironment): Promise<ModelCatalog> {
    this.assertAvailable();
    this.pendingCatalogs++;
    try {
      const entries = await Promise.all((agent ? [agent] : harnessIds).map((id) => this.modelCache.read(id, environment.revision, () => this.modelLists[id](environment, admitted), refresh)));
      return { models: entries.flatMap((entry) => entry.models), providers: entries.map((entry) => entry.provider) };
    } finally {
      this.pendingCatalogs--;
    }
  }

  private readonly modelLists: Record<HarnessId, (environment: EnvSnapshot, admitted?: AgentLaunchEnvironment) => Promise<DiscoveredModels>> = {
    codex: async (environment, admitted) => ({ models: await this.codexModelList(admitted ?? captureLaunchEnvironment("codex", environment)) }),
    claude: async (environment, admitted) => this.discoverClaudeModels(environment, admitted ?? captureLaunchEnvironment("claude", environment)),
    opencode: async (environment, admitted) => ({ models: await this.opencodeModelList(admitted ?? captureLaunchEnvironment("opencode", environment)) }),
  };

  private async discoverClaudeModels(environment: EnvSnapshot, launch: AgentLaunchEnvironment): Promise<DiscoveredModels> {
    const installed = await this.hooks.claudeVersion(environment, launch.env).catch(() => null);
    const fallback = claudeModelList(claudeModels, installed, launch.env);
    const legacy = claudeModelList(claudeLegacyModels, installed, launch.env);
    try {
      const catalog = await listClaudeModels(launch);
      const discovered = withClaudeLegacyModels(claudeModelsFrom(catalog.models, fallback, versionAtLeast(installed, ULTRACODE_MIN_CLI), launch.env), legacy);
      return withClaudeAccountFastMode(discovered, catalog.fastModeDisabledReason);
    } catch {
      return withClaudeLegacyModels({ models: fallback, message: "Compatibility catalog: live Claude discovery failed. Check the connection or run claude update, then Refresh models." }, legacy);
    }
  }

  private async codexModelList(launch: AgentLaunchEnvironment): Promise<ModelOption[]> {
    return (await this.codex.listModels(launch)).map((m) => ({
      id: m.model,
      label: m.displayName || m.model,
      agent: "codex",
      provider: harnessCatalog.codex.account,
      isDefault: m.isDefault,
      efforts: m.efforts,
      defaultEffort: m.defaultEffort,
      ...(m.serviceTiers === undefined && m.additionalSpeedTiers === undefined
        ? {}
        : {
            fastMode:
              m.serviceTiers?.some((tier) => tier.id === "priority" || tier.id === "fast") || m.additionalSpeedTiers?.includes("fast")
                ? { supported: true }
                : { supported: false, reason: "This model does not advertise Fast mode in the installed Codex CLI." },
          }),
    }));
  }

  private async opencodeModelList(launch: AgentLaunchEnvironment): Promise<ModelOption[]> {
    return (await this.opencode.listModels(launch)).map((m) => ({
      id: m.id,
      label: m.label,
      agent: "opencode",
      provider: m.provider,
      isDefault: m.isDefault,
      efforts: m.efforts,
      defaultEffort: m.defaultEffort,
      fastMode: { supported: false, reason: harnessCatalog.opencode.fastModeHint },
    }));
  }
}
