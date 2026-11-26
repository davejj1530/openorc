import type { ITerminalOptions } from "@xterm/xterm";
import { useCodeFont } from "../lib/code-font";
import { terminalFontSize, useTextSize } from "../lib/text-size";

/** Keep one running terminal fitted to the selected face and text size, after its real glyphs are available. */
export function followTerminalFont(term: { options: Pick<ITerminalOptions, "fontFamily" | "fontSize"> }, fit: () => void): () => void {
  let live = true;
  let revision = 0;
  const update = async (): Promise<void> => {
    const current = ++revision;
    const family = getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim() || "monospace";
    const size = terminalFontSize[useTextSize.getState().size];
    try {
      await document.fonts?.load(`${size}px ${family}`);
    } catch {
      // If a font cannot load, xterm measures the same fallback used by the rest of the app.
    }
    if (!live || current !== revision) return;
    term.options.fontFamily = family;
    term.options.fontSize = size;
    fit();
  };
  const offFont = useCodeFont.subscribe(() => void update());
  const offSize = useTextSize.subscribe(() => void update());
  void update();
  return () => {
    live = false;
    offFont();
    offSize();
  };
}
