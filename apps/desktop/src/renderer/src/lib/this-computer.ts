/**
 * What the app calls the machine it runs on. OpenOrc runs on macOS, Windows and Linux, so every label about "here"
 * takes its words from this file instead of saying Mac.
 */
// Read off globalThis, since modules that word their messages with these also load where there is no window or
// bridge (previews, tests in Node). There it reads as a Mac.
const platform = (globalThis as { openorc?: { platform?: string } }).openorc?.platform ?? "darwin";

const names: Record<string, string> = { win32: "PC", linux: "computer" };
/** "Mac", "PC" or "computer". */
export const computer = names[platform] ?? "Mac";
/** "this Mac", for the middle of a sentence. */
export const thisComputer = `this ${computer}`;
/** "This Mac", for a label or the start of a sentence. */
export const ThisComputer = `This ${computer}`;
/** The name where it stands alone, as in "Bring to Mac": "Mac", "PC" or "this computer". */
export const machine = computer === "computer" ? thisComputer : computer;

/** The file manager's own words for showing a file or folder in it. */
export function revealLabel(on: string = platform): string {
  if (on === "darwin") return "Show in Finder";
  return on === "win32" ? "Show in Explorer" : "Show in folder";
}
