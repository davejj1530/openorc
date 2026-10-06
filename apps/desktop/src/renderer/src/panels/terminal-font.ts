import type { ITerminalOptions } from "@xterm/xterm";
import { useCodeFont } from "../lib/code-font";

/** Keep one running terminal fitted to the selected face, after its real glyphs are available. */
export function followTerminalFont(term: { options: Pick<ITerminalOptions, "fontFamily" | "fontSize"> }, fit: () => void): () => void {
  let live = true;
  let revision = 0;
  const update = async (): Promise<void> => {
    const current = ++revision;
    const family = getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim() || "monospace";
    try {
      await document.fonts?.load(`${term.options.fontSize ?? 12}px ${family}`);
    } catch {
      // If a font cannot load, xterm measures the same fallback used by the rest of the app.
    }
    if (!live || current !== revision) return;
    term.options.fontFamily = family;
    fit();
  };
  const off = useCodeFont.subscribe(() => void update());
  void update();
  return () => {
    live = false;
    off();
  };
}
