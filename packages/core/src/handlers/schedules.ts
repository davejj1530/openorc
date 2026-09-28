import { ScheduleService } from "../services/schedules.js";
import type { Handlers } from "./types.js";
type Dependencies = {
  schedules: Pick<ScheduleService, "list" | "create" | "update" | "delete" | "fire" | "trigger">;
};

export function createSchedulesHandlers({
  schedules,
}: Dependencies): Pick<Handlers, "schedules.list" | "schedules.create" | "schedules.update" | "schedules.delete" | "schedules.run" | "schedules.trigger"> {
  return {
    "schedules.list": ({ projectId }) => schedules.list(projectId),
    "schedules.create": (input) => schedules.create(input),
    "schedules.update": ({ id, patch }) => schedules.update(id, patch),
    "schedules.delete": ({ id }) => {
      schedules.delete(id);
      return null;
    },
    "schedules.run": ({ id }) => {
      const s = schedules.list().find((x) => x.id === id);
      if (!s) throw new Error(`schedule ${id} not found`);
      return schedules.fire(s);
    },
    "schedules.trigger": ({ id, requestKey }) => schedules.trigger(id, requestKey),
  };
}
