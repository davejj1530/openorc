import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import type { Terminal as Xterm } from "@xterm/xterm";
import { followTerminalFont } from "./terminal-font";
import { openXterm } from "./xterm";

/**
 * The panel slides over 220ms and the observer reports every frame of it. A trailing wait longer than one frame
 * collapses the whole slide into a single fit, which is all a shell wants: the sizes in between belong to an
 * animation, and redrawing for each of them is work for nobody.
 */
const RESIZE_SETTLE_MS = 150;
/** A drag reports every cell it crosses; the selection is handed on once it rests. */
const SELECTION_SETTLE_MS = 100;

/** A terminal's screen in a panel: the xterm, its find, and what the pointer rests on. */
export interface TerminalScreen {
  readonly term: Xterm;
  readonly search: SearchAddon;
  /** The web address under the pointer, if it rests on one. */
  link(): string | null;
  dispose(): void;
}

/** Opens a web address the way the window opens every link: in Preview where the conversation has one, otherwise in the browser. */
export function openTerminalLink(address: string): void {
  if (/^https?:\/\//i.test(address)) window.open(address, "_blank", "noopener");
}

/** Linux pastes the last selection with a middle click, so a terminal's selection is handed to the system as it is made. */
function shareSelection(term: Xterm): () => void {
  let rest = 0;
  const heard = term.onSelectionChange(() => {
    window.clearTimeout(rest);
    rest = window.setTimeout(() => {
      const text = term.getSelection();
      if (text) window.openorc.terminal.selected(text);
    }, SELECTION_SETTLE_MS);
  });
  return () => {
    window.clearTimeout(rest);
    heard.dispose();
  };
}

/**
 * An xterm in `element`, kept fitted to it in the selected face. `settled` hears each size the screen settles at after
 * the first, which the caller reads off the terminal as it opens its shell. Web addresses open on the platform's own
 * gesture, ⌘ click on a Mac and Ctrl click elsewhere, so a click or a double click still only selects. xterm draws its
 * rows as text in the page, not on a canvas: a canvas has no part in the app's font smoothing, and its letters come out
 * heavier and tighter than every other line of code the app shows.
 */
export function openTerminalScreen(element: HTMLElement, settled: (term: Xterm) => void): TerminalScreen {
  const { term, fit } = openXterm(element);
  const platform = window.openorc.platform;

  // Wide characters and emoji take two cells, as the programs that print them count.
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = "11";

  let link: string | null = null;
  const follow = (event: MouseEvent, address: string): void => {
    if (platform === "darwin" ? event.metaKey : event.ctrlKey) openTerminalLink(address);
  };
  const hover = (_event: MouseEvent, address: string): void => {
    link = address;
  };
  const leave = (): void => {
    link = null;
  };
  // Links a program names itself (OSC 8), then the addresses found in what it printed.
  term.options.linkHandler = { activate: follow, hover, leave };
  term.loadAddon(new WebLinksAddon(follow, { hover, leave }));

  const search = new SearchAddon();
  term.loadAddon(search);

  let settle = 0;
  const refit = (): void => {
    fit.fit();
    settled(term);
  };
  const observer = new ResizeObserver(() => {
    window.clearTimeout(settle);
    settle = window.setTimeout(refit, RESIZE_SETTLE_MS);
  });
  observer.observe(element);
  const stopFont = followTerminalFont(term, refit);
  const stopSelection = platform === "linux" ? shareSelection(term) : () => {};

  return {
    term,
    search,
    link: () => link,
    dispose() {
      window.clearTimeout(settle);
      observer.disconnect();
      stopFont();
      stopSelection();
      term.dispose();
    },
  };
}
