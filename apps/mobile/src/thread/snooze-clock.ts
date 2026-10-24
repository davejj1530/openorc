import { snoozePresetsChangeAt } from "@openorc/client";
import { useSyncExternalStore } from "react";

let now = new Date();
let timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

/** The clock's time, read afresh once the presets it offered have changed or the device's clock went back. */
function read(): Date {
  const at = Date.now();
  if (at < now.getTime() || at >= snoozePresetsChangeAt(now)) now = new Date(at);
  return now;
}

function schedule(): void {
  timer = setTimeout(tick, snoozePresetsChangeAt(read()) - Date.now());
}

function tick(): void {
  listeners.forEach((listener) => listener());
  schedule();
}

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) schedule();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) clearTimeout(timer);
  };
}

/**
 * The time thread menus are built for: one clock for every menu on screen, which moves only when the snooze presets
 * change (This evening leaving at ten to six, coming back at midnight). A row keeps its native menu for hours, so it is
 * built again then, and not every minute.
 */
export function useSnoozeClock(): Date {
  return useSyncExternalStore(subscribe, read);
}
