import { duration } from "../data/hero/timeline";

/*
 * The homepage's live window (components/mocks/AppPreview.astro). A thread's tab switches everything that belongs to
 * a thread: its conversation, its sidebar row on the current-row fill, the usage of its account, the header's
 * "working" and its own panel pages; opening a thread reads its result. A panel's tabs switch its page. Each switch
 * blurs the old view out as the new one blurs in. Tabs take the app's keys: arrows, Home and End move between them
 * and pick as they go. A working thread's clock keeps counting.
 */

const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
const keys: Record<string, (index: number, count: number) => number> = {
  ArrowLeft: (index, count) => (index - 1 + count) % count,
  ArrowRight: (index, count) => (index + 1) % count,
  Home: () => 0,
  End: (_, count) => count - 1,
};

/** Shows or hides a view; one in a stack of views crossfades with a short blur instead of cutting. */
function reveal(view: HTMLElement, show: boolean) {
  if (show === !view.hidden && !view.dataset.swap) return;
  if (reducedMotion.matches || !view.parentElement?.matches(".hs-pages, .hs-app-panel")) {
    view.hidden = !show;
    return;
  }
  view.hidden = false;
  view.dataset.swap = show ? "in" : "out";
}

/** Wires a tablist's tabs: clicks and the keys pick a tab, which `onPick` shows. */
function tablist(list: HTMLElement, onPick: (tab: HTMLButtonElement) => void) {
  const tabs = [...list.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  const pick = (tab: HTMLButtonElement) => {
    if (tab.getAttribute("aria-selected") === "true") return;
    for (const each of tabs) {
      const chosen = each === tab;
      each.setAttribute("aria-selected", String(chosen));
      each.tabIndex = chosen ? 0 : -1;
      each.closest(".hs-tab")?.toggleAttribute("data-current", chosen);
    }
    onPick(tab);
  };
  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => pick(tab));
    tab.addEventListener("keydown", (event) => {
      const move = keys[event.key];
      if (!move) return;
      event.preventDefault();
      const next = tabs[move(index, tabs.length)];
      pick(next);
      next.focus();
    });
  });
}

/** Counts a working turn's clock on from the seconds the page was drawn with. */
function tick(root: HTMLElement) {
  const clocks = [...root.querySelectorAll<HTMLElement>("[data-tick]")].map((el) => ({ el, from: Number(el.dataset.tick) }));
  if (!clocks.length) return;
  const start = performance.now();
  setInterval(() => {
    const seconds = Math.floor((performance.now() - start) / 1000);
    for (const clock of clocks) clock.el.textContent = `working ${duration(clock.from + seconds)}`;
  }, 1000);
}

export function initAppPreview(root: HTMLElement) {
  const header = root.querySelector<HTMLElement>(".hs-app-thread .hs-header");
  const owned = [...root.querySelectorAll<HTMLElement>("[data-for]")];
  const rows = [...root.querySelectorAll<HTMLElement>(".hs-row[data-row]")];

  root.addEventListener("animationend", (event) => {
    const view = event.target as HTMLElement;
    if (event.animationName !== "hs-swap-in" && event.animationName !== "hs-swap-out") return;
    if (view.dataset.swap === "out") view.hidden = true;
    delete view.dataset.swap;
  });

  const threads = root.querySelector<HTMLElement>('.hs-app-thread [role="tablist"]');
  if (threads)
    tablist(threads, (tab) => {
      const thread = tab.dataset.value!;
      const face = tab.closest<HTMLElement>(".hs-tab")!;
      for (const view of owned) reveal(view, view.dataset.for!.split(" ").includes(thread));
      for (const row of rows) row.toggleAttribute("data-current", row.dataset.row === thread);
      header?.toggleAttribute("data-busy", face.hasAttribute("data-busy"));
      // Opening a thread reads the result it was holding.
      if (face.hasAttribute("data-unread")) {
        face.removeAttribute("data-unread");
        tab.removeAttribute("aria-label");
        root.querySelector(`.hs-row[data-row="${thread}"]`)?.removeAttribute("data-done");
      }
    });

  for (const session of root.querySelectorAll<HTMLElement>(".hs-panel-session")) {
    const pages = session.querySelector<HTMLElement>('[role="tablist"]');
    if (!pages) continue;
    tablist(pages, (tab) => {
      const shown = tab.getAttribute("aria-controls");
      for (const page of session.querySelectorAll<HTMLElement>(".hs-pages > .hs-page")) reveal(page, page.id === shown);
    });
  }

  tick(root);
}
