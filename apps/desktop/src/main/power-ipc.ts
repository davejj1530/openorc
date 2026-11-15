import { powerMonitor, type UtilityProcess } from "electron";

/** Tells the core when this Mac wakes from sleep, so it dials OpenOrc Cloud again at once. powerMonitor exists only in main. */
export function installPowerEvents(child: UtilityProcess): void {
  const resume = () => child.postMessage({ type: "awoke" });
  powerMonitor.on("resume", resume);
  child.once("exit", () => powerMonitor.off("resume", resume));
}
