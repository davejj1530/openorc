import type { OnlineTaskPreparation, OnlineTaskThread } from "@openorc/protocol";
import { TaskChanged } from "./task-requests.js";

export async function prepareTaskThread(request: Promise<OnlineTaskThread>): Promise<OnlineTaskPreparation> {
  try {
    return { state: "ready", ...(await request) };
  } catch (error) {
    if (error instanceof TaskChanged) return { state: "conflict", ...error.current };
    throw error;
  }
}
