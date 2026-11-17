import type { Hosted } from "@openorc/hosted";
import type { HostedModelsRpcResults } from "@openorc/protocol";
import { cloudModelCatalog } from "../services/cloud-model-catalog.js";
import type { Handlers } from "./types.js";

/** The models OpenOrc Cloud runs for the person; null where its server keeps no catalog, or nobody is signed in. */
export function createHostedModelsHandlers(account: Hosted | null): Pick<Handlers, keyof HostedModelsRpcResults> {
  return {
    "cloudModels.catalog": async () => {
      const answer = account?.account.status().state === "signed-in" ? await account.models.read() : null;
      return answer && cloudModelCatalog(answer);
    },
  };
}
