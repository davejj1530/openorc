import { harnessAvailability } from "@openorc/protocol";
import { AgentUpdateService } from "../services/agent-updates.js";
import type { PlanLimits } from "@openorc/protocol";
import { ProviderUsageService } from "../services/provider-usage.js";
import { SystemService } from "../services/system.js";
import type { Handlers } from "./types.js";
type Dependencies = {
  system: Pick<SystemService, "info" | "gh">;
  accountInfo?: (refresh?: boolean, id?: string) => ReturnType<SystemService["info"]>;
  /** The checks for the default Claude account, which a thread started without naming one runs on. */
  defaultAccountInfo: () => ReturnType<SystemService["info"]>;
  agentUpdates: Pick<AgentUpdateService, "get" | "check" | "install" | "configure">;
  providerUsage: Pick<ProviderUsageService, "read" | "redeemCodex">;
  planLimits: () => Promise<PlanLimits[]>;
  invalidate: (keys: string[]) => void;
};

export function createSystemHandlers({
  system,
  accountInfo,
  defaultAccountInfo,
  agentUpdates,
  providerUsage,
  planLimits,
  invalidate,
}: Dependencies): Pick<
  Handlers,
  | "system.info"
  | "system.gh"
  | "agents.availability"
  | "agents.updates.get"
  | "agents.updates.check"
  | "agents.updates.install"
  | "agents.updates.configure"
  | "providers.usage"
  | "providers.limits"
  | "providers.codex.reset"
> {
  return {
    "system.info": ({ refresh, claudeAccountId }) => (accountInfo ? accountInfo(refresh, claudeAccountId) : system.info(refresh)),
    "system.gh": () => system.gh(),
    "agents.availability": async () => harnessAvailability(await defaultAccountInfo()),
    "agents.updates.get": () => agentUpdates.get(),
    "agents.updates.check": () => agentUpdates.check(),
    "agents.updates.install": ({ ids }) => agentUpdates.install(ids),
    "agents.updates.configure": (patch) => agentUpdates.configure(patch),
    "providers.usage": ({ provider, claudeAccountId }) => providerUsage.read(provider, claudeAccountId),
    "providers.limits": () => planLimits(),
    "providers.codex.reset": async (input) => {
      const result = await providerUsage.redeemCodex(input);
      invalidate(["provider-usage"]);
      return result;
    },
  };
}
