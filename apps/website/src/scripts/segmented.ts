/**
 * A segmented track's raised knob follows the selected choice, sliding between them as the app's switchers do.
 * The knob is placed without motion the first time, so the page never opens on a slide.
 */
export function followKnob(track: HTMLElement) {
  const knob = track.querySelector<HTMLElement>(".segmented-knob");
  if (!knob) return;
  const place = () => {
    const selected = track.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!selected) return;
    knob.style.setProperty("--knob-x", `${selected.offsetLeft}px`);
    knob.style.setProperty("--knob-width", `${selected.offsetWidth}px`);
  };
  place();
  requestAnimationFrame(() => track.setAttribute("data-ready", ""));
  new MutationObserver(place).observe(track, { subtree: true, attributeFilter: ["aria-selected"] });
  new ResizeObserver(place).observe(track);
}
