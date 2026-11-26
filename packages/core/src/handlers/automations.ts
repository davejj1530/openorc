import type { AutomationService } from "../services/automations.js";
import type { Handlers } from "./types.js";

type Dependencies = { automations: Pick<AutomationService, "list" | "save" | "switch" | "remove" | "tryCheck" | "setTriggerValue" | "programs"> };
type AutomationMethod =
  | "automations.list"
  | "automations.save"
  | "automations.switch"
  | "automations.remove"
  | "automations.tryCheck"
  | "automations.writeTrigger"
  | "automations.trigger"
  | "automations.setTriggerValue"
  | "automations.tryTrigger";

export function createAutomationHandlers({ automations }: Dependencies): Pick<Handlers, AutomationMethod> {
  const { programs } = automations;
  return {
    "automations.tryCheck": ({ projectId, command }) => automations.tryCheck(projectId, command),
    "automations.writeTrigger": (asked) => programs.write(asked),
    "automations.trigger": ({ id }) => programs.state(id),
    "automations.setTriggerValue": async ({ id, name, value }) => {
      await automations.setTriggerValue(id, name, value);
      return null;
    },
    "automations.tryTrigger": async ({ id, on }) => {
      await programs.try(id, on);
      return null;
    },
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
