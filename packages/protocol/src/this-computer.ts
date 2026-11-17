/**
 * What the app calls the computer it runs on. OpenOrc runs on macOS, Windows and Linux, so every word about "here", in
 * the window and in the core's own words, comes from these instead of saying Mac.
 */
export interface ComputerNames {
  /** "Mac", "PC" or "computer". */
  computer: string;
  /** "this Mac", for the middle of a sentence. */
  thisComputer: string;
  /** "This Mac", for a label or the start of a sentence. */
  ThisComputer: string;
  /** The name where it stands alone, as in "Move to Mac": "Mac", "PC" or "this computer". */
  machine: string;
}

const NAMES: Record<string, string> = { win32: "PC", linux: "computer" };

/** The names for a computer on `platform` (Node's `process.platform`). */
export function computerNames(platform: string): ComputerNames {
  const computer = NAMES[platform] ?? "Mac";
  const thisComputer = `this ${computer}`;
  return { computer, thisComputer, ThisComputer: `This ${computer}`, machine: computer === "computer" ? thisComputer : computer };
}
