import type { CheckWriter } from "../services/automation-check-writer.js";
import type { AutomationService } from "../services/automations.js";
import type { Handlers } from "./types.js";

type Dependencies = { automations: Pick<AutomationService, "list" | "save" | "switch" | "remove">; checks: Pick<CheckWriter, "write" | "try"> };
type AutomationMethod = "automations.list" | "automations.save" | "automations.switch" | "automations.remove" | "automations.writeCheck" | "automations.tryCheck";

export function createAutomationHandlers({ automations, checks }: Dependencies): Pick<Handlers, AutomationMethod> {
  return {
    "automations.writeCheck": (asked) => checks.write(asked),
    "automations.tryCheck": ({ projectId, command }) => checks.try(projectId, command),
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
