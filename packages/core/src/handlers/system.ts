import { AgentUpdateService } from "../services/agent-updates.js";
import { ProviderUsageService } from "../services/provider-usage.js";
import { SystemService } from "../services/system.js";
import type { Handlers } from "./types.js";
type Dependencies = {
  system: Pick<SystemService, "info">;
  accountInfo?: (refresh?: boolean, id?: string) => ReturnType<SystemService["info"]>;
  agentUpdates: Pick<AgentUpdateService, "get" | "check" | "install" | "configure">;
  providerUsage: Pick<ProviderUsageService, "read" | "redeemCodex">;
  invalidate: (keys: string[]) => void;
};

export function createSystemHandlers({
  system,
  accountInfo,
  agentUpdates,
  providerUsage,
  invalidate,
}: Dependencies): Pick<Handlers, "system.info" | "agents.updates.get" | "agents.updates.check" | "agents.updates.install" | "agents.updates.configure" | "providers.usage" | "providers.codex.reset"> {
  return {
    "system.info": ({ refresh, claudeAccountId }) => (accountInfo ? accountInfo(refresh, claudeAccountId) : system.info(refresh)),
    "agents.updates.get": () => agentUpdates.get(),
    "agents.updates.check": () => agentUpdates.check(),
    "agents.updates.install": ({ ids }) => agentUpdates.install(ids),
    "agents.updates.configure": (patch) => agentUpdates.configure(patch),
    "providers.usage": ({ provider, claudeAccountId }) => providerUsage.read(provider, claudeAccountId),
    "providers.codex.reset": async (input) => {
      const result = await providerUsage.redeemCodex(input);
      invalidate(["provider-usage"]);
      return result;
    },
  };
}
