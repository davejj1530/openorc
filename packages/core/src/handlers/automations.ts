import type { AutomationService } from "../services/automations.js";
import type { Handlers } from "./types.js";

type Dependencies = { automations: Pick<AutomationService, "list" | "save" | "switch" | "remove"> };

export function createAutomationHandlers({ automations }: Dependencies): Pick<Handlers, "automations.list" | "automations.save" | "automations.switch" | "automations.remove"> {
  return {
    "automations.list": ({ projectId }) => automations.list(projectId),
    "automations.save": (draft) => automations.save(draft),
    "automations.switch": ({ id, enabled }) => {
      automations.switch(id, enabled);
      return null;
    },
    "automations.remove": ({ id }) => {
      automations.remove(id);
      return null;
    },
  };
}
