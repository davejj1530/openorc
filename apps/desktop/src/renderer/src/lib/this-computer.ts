import { computerNames } from "@openorc/protocol";

/**
 * What the app calls the machine it runs on, in the window (protocol's `computerNames`, which the core words its
 * messages with too).
 */
// Read off globalThis, since modules that word their messages with these also load where there is no window or
// bridge (previews, tests in Node). There it reads as a Mac.
const platform = (globalThis as { openorc?: { platform?: string } }).openorc?.platform ?? "darwin";

export const { computer, thisComputer, ThisComputer, machine } = computerNames(platform);

/** The file manager's own words for showing a file or folder in it. */
export function revealLabel(on: string = platform): string {
  if (on === "darwin") return "Show in Finder";
  return on === "win32" ? "Show in Explorer" : "Show in folder";
}
