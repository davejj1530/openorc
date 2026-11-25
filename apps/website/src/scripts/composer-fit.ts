/**
 * What a composer's bar gives up to fit its row, a step at a time, as the app's does (lib/composer-fit.ts): the
 * model's effort, then the mode's name, then the context's number and the Commit chip's totals, then the model's name;
 * under that the send cluster takes a row of its own.
 */
const STEPS = ["whole", "no-effort", "marks", "no-context", "logos", "least"] as const;

/** Keeps every composer bar on the page at the first step where its chips fit, measured again whenever it changes size. */
export function fitComposers() {
  for (const bar of document.querySelectorAll<HTMLElement>(".hs-bar:not([data-fitted])")) {
    const tools = bar.querySelector<HTMLElement>(".hs-bar-tools");
    const end = bar.querySelector<HTMLElement>(".hs-bar-end");
    if (!tools) continue;
    bar.dataset.fitted = "";
    const fit = () => {
      // A bar that is not on screen has no width to fit to.
      if (!bar.clientWidth) return;
      for (const step of STEPS) {
        bar.dataset.fit = step;
        if (tools.scrollWidth <= tools.clientWidth) return;
      }
    };
    const resized = new ResizeObserver(fit);
    resized.observe(bar);
    if (end) resized.observe(end);
  }
}
