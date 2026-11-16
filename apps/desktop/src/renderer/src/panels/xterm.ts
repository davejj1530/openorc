import { FitAddon } from "@xterm/addon-fit";
import { Terminal as Xterm } from "@xterm/xterm";
import { terminalTheme } from "./terminal-theme";

/** The mode the theme store stamped on the document, read the way DiffView reads it. */
export function isDark(): boolean {
  const stamped = document.documentElement.dataset.theme;
  if (stamped === "dark") return true;
  if (stamped === "light") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/**
 * An xterm drawn into `element` and fitted to its content. The fit measures the box xterm opens in by its border edge,
 * the size the app's border-box sizing gives it, so a box with padding would count the padding as room and draw the
 * last columns past the edge. xterm opens in a bare box of its own instead, filling `element` inside its padding,
 * which leaves with the terminal.
 */
export function openXterm(element: HTMLElement): { term: Xterm; fit: FitAddon } {
  const term = new Xterm({
    cursorBlink: true,
    // The selected face is applied after loading, so xterm never caches its fallback's metrics.
    fontFamily: "monospace",
    fontSize: 12,
    lineHeight: 1.35,
    macOptionIsMeta: true,
    // The ring in main is the replay after a re-attach; this is only what the
    // reader can scroll back through in the view they are looking at.
    scrollback: 5000,
    // Read where the terminal sits: the panel card restates --bg as its own surface.
    theme: terminalTheme(getComputedStyle(element), isDark()),
  });
  const box = element.ownerDocument.createElement("div");
  Object.assign(box.style, { width: "100%", height: "100%" });
  element.append(box);
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon({ activate: () => {}, dispose: () => box.remove() });
  term.open(box);
  fit.fit();
  return { term, fit };
}
