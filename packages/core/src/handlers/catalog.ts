import { RunService } from "../services/runs.js";
import type { Handlers } from "./types.js";
type Dependencies = {
  runService: Pick<RunService, "models" | "modelCatalog">;
  invalidate: (keys: string[]) => void;
};

export function createCatalogHandlers({ runService, invalidate }: Dependencies): Pick<Handlers, "agents.models" | "agents.modelCatalog" | "agents.models.refresh"> {
  return {
    "agents.models": ({ agent, claudeAccountId }) => runService.models(agent, undefined, undefined, claudeAccountId),
    "agents.modelCatalog": ({ agent, claudeAccountId }) => runService.modelCatalog(agent, false, undefined, undefined, claudeAccountId),
    "agents.models.refresh": async ({ agent, claudeAccountId }) => {
      const result = await runService.modelCatalog(agent, true, undefined, undefined, claudeAccountId);
      invalidate(["models"]);
      return result;
    },
  };
}
