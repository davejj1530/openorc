/** What a key press in a terminal means beyond the bytes xterm would send for it. */
export type TerminalKey = { kind: "copy"; thenClear: boolean } | { kind: "paste" } | { kind: "find" } | { kind: "type"; data: string };

type Press = Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey">;

/** ⌘ with these edits the line the way a Mac's text fields do: to the line's start and end, and delete to its start. */
const MAC_LINE_KEYS: Record<string, string> = { ArrowLeft: "\x01", ArrowRight: "\x05", Backspace: "\x15" };

/** Behind Ctrl+Shift everywhere but a Mac, where Ctrl alone belongs to the shell: the clipboard and find. */
const SHIFTED: Record<string, TerminalKey> = { c: { kind: "copy", thenClear: false }, v: { kind: "paste" }, f: { kind: "find" } };

function macKey(press: Press): TerminalKey | null {
  if (!press.metaKey || press.ctrlKey || press.altKey || press.shiftKey) return null;
  if (press.key.toLowerCase() === "f") return { kind: "find" };
  const data = MAC_LINE_KEYS[press.key];
  return data ? { kind: "type", data } : null;
}

function ctrlKey(press: Press, windows: boolean, selected: boolean): TerminalKey | null {
  // AltGr reads as Ctrl+Alt, and types a character.
  if (!press.ctrlKey || press.metaKey || press.altKey) return null;
  const key = press.key.toLowerCase();
  if (press.shiftKey) return SHIFTED[key] ?? null;
  if (!windows) return null;
  if (key === "c" && selected) return { kind: "copy", thenClear: true };
  return key === "v" ? { kind: "paste" } : null;
}

/**
 * A terminal's own shortcuts, each platform's as its terminals have them. On a Mac ⌘ is free, so copy and paste are the
 * browser's own and only find and the line keys are named here. Elsewhere the clipboard and find sit behind Ctrl+Shift,
 * as in a Linux terminal. Windows also copies with Ctrl+C while text is selected and pastes with Ctrl+V, as its terminal
 * does: the selection is then cleared, so the next Ctrl+C interrupts again.
 */
export function terminalKey(press: Press, platform: string, selected: boolean): TerminalKey | null {
  return platform === "darwin" ? macKey(press) : ctrlKey(press, platform === "win32", selected);
}
