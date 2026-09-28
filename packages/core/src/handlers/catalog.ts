import { RunService } from "../services/runs.js";
import type { Handlers } from "./types.js";
type Dependencies = {
  runService: Pick<RunService, "models" | "modelCatalog">;
  invalidate: (keys: string[]) => void;
};

export function createCatalogHandlers({ runService, invalidate }: Dependencies): Pick<Handlers, "agents.models" | "agents.modelCatalog" | "agents.models.refresh"> {
  return {
    "agents.models": ({ agent }) => runService.models(agent),
    "agents.modelCatalog": ({ agent }) => runService.modelCatalog(agent),
    "agents.models.refresh": async ({ agent }) => {
      const result = await runService.modelCatalog(agent, true);
      invalidate(["models"]);
      return result;
    },
  };
}
