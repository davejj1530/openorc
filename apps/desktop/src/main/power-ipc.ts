import { powerMonitor } from "electron";

/**
 * Tells the core when this computer wakes from sleep, so it dials OpenOrc Cloud again at once. powerMonitor exists only
 * in main. The core is a utility process here, or one inside a WSL distribution.
 */
export function installPowerEvents(child: { postMessage(message: unknown): void; once(event: "exit", listener: () => void): unknown }): void {
  const resume = () => child.postMessage({ type: "awoke" });
  powerMonitor.on("resume", resume);
  child.once("exit", () => powerMonitor.off("resume", resume));
}
