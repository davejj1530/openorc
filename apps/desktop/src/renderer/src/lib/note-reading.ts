/** Whether the window is the person's now, as reading needs it, and a way to hear when that changes. */
export interface ReadingWindow {
  focused(): boolean;
  onChange(listener: () => void): () => void;
}

/** What reading watches the notes with: half of a note in view counts as seen. */
interface Watcher {
  observe(element: Element): void;
  unobserve(element: Element): void;
  disconnect(): void;
}

type Seen = (entries: readonly { target: Element; isIntersecting: boolean }[]) => void;

export interface NoteReader {
  /** Watches a note's element until the returned function stops it. */
  watch(element: Element, id: string): () => void;
  close(): void;
}

const browserWindow: ReadingWindow = {
  focused: () => document.visibilityState === "visible" && document.hasFocus(),
  onChange(listener) {
    window.addEventListener("focus", listener);
    document.addEventListener("visibilitychange", listener);
    return () => {
      window.removeEventListener("focus", listener);
      document.removeEventListener("visibilitychange", listener);
    };
  },
};

/** The most notes one mark reads, as the server takes them. */
const MOST = 100;

/**
 * Marks read the notes that tag the reader once each has been on screen in the person's focused window. A note only
 * loaded, or on screen while the window is behind another, stays unread. Ids go in batches of at most a hundred; one
 * whose mark failed goes again the next time it is seen.
 */
export function noteReader(
  read: (ids: string[]) => Promise<unknown>,
  {
    window: win = browserWindow,
    observe = (callback: Seen) => new IntersectionObserver(callback, { threshold: 0.5 }),
    delay = 400,
  }: { window?: ReadingWindow; observe?: (callback: Seen) => Watcher; delay?: number } = {},
): NoteReader {
  const ids = new Map<Element, string>();
  const visible = new Set<string>();
  const sent = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = () => {
    timer ??= setTimeout(flush, delay);
  };
  const flush = () => {
    timer = null;
    if (!win.focused()) return;
    const owed = [...visible].filter((id) => !sent.has(id));
    const batch = owed.slice(0, MOST);
    if (!batch.length) return;
    for (const id of batch) sent.add(id);
    read(batch).catch(() => batch.forEach((id) => sent.delete(id)));
    if (owed.length > batch.length) schedule();
  };
  const watcher = observe((entries) => {
    for (const entry of entries) {
      const id = ids.get(entry.target);
      if (id === undefined) continue;
      if (entry.isIntersecting) visible.add(id);
      else visible.delete(id);
    }
    schedule();
  });
  const stop = win.onChange(schedule);
  return {
    watch(element, id) {
      ids.set(element, id);
      watcher.observe(element);
      return () => {
        watcher.unobserve(element);
        ids.delete(element);
        visible.delete(id);
      };
    },
    close() {
      stop();
      watcher.disconnect();
      if (timer) clearTimeout(timer);
    },
  };
}
