import { powerMonitor } from "electron";

/**
 * Tells the core when this Mac goes to sleep and wakes up, so conversations working here can carry on in the cloud
 * meanwhile. powerMonitor exists only in main.
 */
export function installPowerEvents(child: { postMessage(message: unknown): void; once(event: "exit", listener: () => void): unknown }): void {
  const suspend = () => child.postMessage({ type: "power", state: "suspend" });
  const resume = () => child.postMessage({ type: "power", state: "resume" });
  powerMonitor.on("suspend", suspend);
  powerMonitor.on("resume", resume);
  child.once("exit", () => {
    powerMonitor.off("suspend", suspend);
    powerMonitor.off("resume", resume);
  });
}
