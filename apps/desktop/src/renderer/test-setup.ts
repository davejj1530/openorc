/**
 * What jsdom leaves out that this renderer reads at module scope.
 *
 * theme.ts calls matchMedia while it is being imported, so anything that
 * transitively touches the theme fails to load rather than failing a test,
 * which makes the cause hard to see. Stubbed here once for the whole project
 * instead of in each test that happens to pull the theme in.
 */
if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
  window.matchMedia = (query: string): MediaQueryList => {
    const listeners = new Set<EventListenerOrEventListenerObject>();
    const list: MediaQueryList = {
      matches: false,
      media: query,
      onchange: null,
      addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => void listeners.add(listener),
      removeEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => void listeners.delete(listener),
      // The deprecated pair, because a library may still reach for it.
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => true,
    };
    return list;
  };
}

/*
 * CodeMirror measures text through Range rectangles on animation frames. jsdom has no layout and no such methods, so
 * any test that renders the editor long enough for a frame to pass would throw from the measure. Empty rectangles are
 * what a page without layout would report.
 */
if (typeof Range !== "undefined" && !("getClientRects" in Range.prototype)) {
  Object.assign(Range.prototype, { getClientRects: () => [], getBoundingClientRect: () => new DOMRect() });
}

/*
 * jsdom has no ClipboardEvent. Editors tell a paste, copy or cut from a key press by its class, so tests that fire one
 * need the class to exist; the clipboard data comes from the test, as it does from the page.
 */
if (typeof window !== "undefined" && !("ClipboardEvent" in window)) {
  class ClipboardEvent extends Event {
    clipboardData: DataTransfer | null = null;
  }
  Object.assign(window, { ClipboardEvent });
}
