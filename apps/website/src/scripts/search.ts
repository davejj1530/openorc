import { downloadDevice } from "../lib/download-platform";
import { search, type SearchEntry } from "../lib/search";
import { createMorph } from "./search-morph";
import { createResults } from "./search-results";
import { play } from "./speaker";

/*
 * The header's search, after Immaculate's: the pill grows into a field over the dimmed page on a click, ⌘K or Ctrl+K,
 * and runs back into it on ⌘K again, Escape, a press on the page, or a chosen result. The index is fetched the first
 * time it opens; the suggestions ship with the page, so the panel opens at its full size.
 */

type Phase = "closed" | "open" | "closing";

function find<T extends HTMLElement = HTMLElement>(root: ParentNode, name: string): T {
  const element = root.querySelector<T>(`[data-search-${name}]`);
  if (!element) throw new Error(`The search is missing [data-search-${name}].`);
  return element;
}

/** Everything the search finds, which the site builds into /search.json. */
async function fetchIndex() {
  const response = await fetch("/search.json");
  if (!response.ok) throw new Error(`search.json: ${response.status}`);
  return (await response.json()) as SearchEntry[];
}

/** The index, fetched the first time it is asked for. A failed fetch, offline or mid-deploy, is asked for again next time. */
function lazyIndex(arrived: () => void) {
  let entries: SearchEntry[] | null = null;
  let loading: Promise<void> | null = null;
  return {
    entries: () => entries,
    load() {
      loading ??= fetchIndex().then(
        (list) => {
          entries = list;
          arrived();
        },
        () => {
          loading = null;
        },
      );
    },
  };
}

/** Tab stays inside the dialog, moving between its stops and wrapping at either end. */
function trapFocus(stops: HTMLElement[], back: boolean) {
  const at = stops.indexOf(document.activeElement as HTMLElement);
  stops[(at + (back ? -1 : 1) + stops.length) % stops.length]?.focus();
}

function initSearch(dialog: HTMLElement, pill: HTMLButtonElement) {
  const input = find<HTMLInputElement>(dialog, "input");
  const clear = find<HTMLButtonElement>(dialog, "clear");
  const scrim = find(dialog, "scrim");
  const listbox = find(dialog, "results");
  const content = find(dialog, "content");
  const morph = createMorph({
    pill,
    scrim,
    content,
    results: listbox,
    column: find(dialog, "column"),
    slot: find(dialog, "slot"),
    fieldFill: find(dialog, "field-fill"),
    panel: find(dialog, "panel"),
  });
  const results = createResults(listbox, input);
  const suggestions = JSON.parse(dialog.dataset.suggestions ?? "[]") as SearchEntry[];
  // Suggestions are on screen until something is typed; redrawing them on arrival would cut their entrance short.
  const index = lazyIndex(() => input.value.trim() && update());
  let phase: Phase = "closed";

  function update() {
    const query = input.value;
    const entries = index.entries();
    clear.toggleAttribute("data-shown", query !== "");
    if (!query.trim()) results.show([{ label: "Suggestions", entries: suggestions }]);
    else if (entries) results.show(search(entries, query));
  }

  /** Moves to a phase and shows it: on screen unless closed, taking input only while open, the page held still meanwhile. */
  function enter(next: Phase) {
    phase = next;
    dialog.hidden = phase === "closed";
    dialog.inert = phase !== "open";
    dialog.dataset.state = phase;
    pill.setAttribute("aria-expanded", String(phase === "open"));
    document.documentElement.toggleAttribute("data-search-shown", phase !== "closed");
  }

  function open() {
    if (phase === "open") return;
    if (phase === "closed") {
      input.value = "";
      update();
    }
    enter("open");
    input.focus({ preventScroll: true });
    morph.open();
    index.load();
  }

  async function close() {
    if (phase !== "open") return;
    enter("closing");
    pill.focus({ preventScroll: true });
    // A newer open cancels the run back, so it never finishes and the search stays open.
    if (!(await morph.close())) return;
    enter("closed");
    for (const animation of dialog.getAnimations({ subtree: true })) animation.cancel();
  }

  pill.addEventListener("click", open);
  scrim.addEventListener("click", () => void close());
  listbox.addEventListener("click", (event) => {
    if (event.target instanceof Element && event.target.closest('[role="option"]')) void close();
  });
  clear.addEventListener("click", () => {
    input.value = "";
    update();
    input.focus();
  });
  input.addEventListener("input", update);
  dialog.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      play("click");
      void close();
    } else if (event.key === "Tab") {
      event.preventDefault();
      trapFocus(clear.hasAttribute("data-shown") ? [input, clear] : [input], event.shiftKey);
    }
  });
  addEventListener("keydown", (event) => {
    if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "k") return;
    event.preventDefault();
    play("click");
    if (phase === "open") void close();
    else open();
  });
  new ResizeObserver(() => phase === "open" && morph.follow()).observe(content);
}

const dialog = document.querySelector<HTMLElement>("[data-search]");
const pill = document.querySelector<HTMLButtonElement>("[data-search-pill]");
if (dialog && pill) initSearch(dialog, pill);

const { platform } = downloadDevice(navigator);
if (platform === "windows" || platform === "linux" || platform === "other") {
  for (const key of document.querySelectorAll("[data-search-key]")) key.textContent = "Ctrl K";
}
