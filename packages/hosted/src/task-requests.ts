import type { OnlineTaskEnvelope, OnlineTaskCreation } from "@openorc/protocol";
import { z } from "zod";
import { Refused } from "./session.js";
import { wireTaskEnvelope } from "./wire-tasks.js";
import type { Route } from "./wire.js";

export class TaskChanged extends Refused {
  constructor(readonly current: OnlineTaskEnvelope) {
    super("This task changed.", 409, "TASK_CHANGED");
  }
}
const conflict = z.object({ code: z.literal("TASK_CHANGED"), current: wireTaskEnvelope });
/** Only an authorized task conflict can supply a replacement record. Unknown error data stays private. */
export function taskRequest<T>(route: Route<T>): Route<T> {
  return {
    ...route,
    refusal: (status, body) => {
      if (status !== 409) return undefined;
      const parsed = conflict.safeParse(body);
      return parsed.success ? new TaskChanged(parsed.data.current) : undefined;
    },
  };
}

/** A definitive refusal lets the author correct a new task; an unknown reply keeps its receipt. */
export async function taskCreation(write: Promise<OnlineTaskEnvelope>): Promise<OnlineTaskCreation> {
  try {
    return { state: "saved", ...(await write) };
  } catch (error) {
    if (error instanceof Refused && error.status !== undefined && error.status >= 400 && error.status < 500) return { state: "refused", code: error.code ?? "TASK_REFUSED", message: error.message };
    throw error;
  }
}
