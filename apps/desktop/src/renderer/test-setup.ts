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
