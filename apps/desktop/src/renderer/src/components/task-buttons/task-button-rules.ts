import type { TaskStatus } from "@openorc/protocol";
import { statusOrder } from "../status";

/** Every status a button can show on. Archived tasks show no buttons, since none can run there. */
export const showable = statusOrder.filter((status) => status !== "archived");

/** The showable statuses a button shows on, or undefined for all of them, as it is saved. */
export function shownOn(statuses: readonly TaskStatus[] | undefined): TaskStatus[] | undefined {
  const shown = showable.filter((status) => !statuses || statuses.includes(status));
  return shown.length === showable.length ? undefined : shown;
}
