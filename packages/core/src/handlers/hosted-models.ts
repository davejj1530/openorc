import type { Hosted } from "@openorc/hosted";
import { HOSTED_AGENTS, type HostedModelsRpcResults, type ModelCatalog } from "@openorc/protocol";
import { cloudModelCatalog } from "../services/cloud-model-catalog.js";
import type { Handlers } from "./types.js";

/**
 * The models OpenOrc Cloud runs for the person; null where its server keeps no catalog, or nobody is signed in. For an
 * agent the cloud has not read yet, this Mac's own listing (`macModels`), read only then.
 */
export function createHostedModelsHandlers(account: Hosted | null, macModels: () => Promise<ModelCatalog>): Pick<Handlers, keyof HostedModelsRpcResults> {
  return {
    "cloudModels.catalog": async () => {
      const answer = account?.account.status().state === "signed-in" ? await account.models.read() : null;
      if (!answer) return null;
      const unread = HOSTED_AGENTS.some((agent) => !answer.agents.some((entry) => entry.agent === agent));
      return cloudModelCatalog(answer, unread ? await macModels().catch(() => null) : null);
    },
  };
}
