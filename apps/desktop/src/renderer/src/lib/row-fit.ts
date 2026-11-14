/**
 * What a sidebar row's second line gives up to fit, a step at a time: the place, whole (a cloud keeps its glyph), then a
 * teammate's name (the face stays, the name in its tooltip). The age, the face and the pull request never go.
 */
export const ROW_FIT = ["whole", "no-place", "face"] as const;

/**
 * Keeps a row's second line at the first step where it fits, measured again whenever the line changes size or its
 * words change. Pass it as the line's ref; the step is the line's `data-fit`.
 */
export function rowFit(line: HTMLElement | null) {
  if (!line) return;
  const fit = () => {
    for (const step of ROW_FIT) {
      line.dataset.fit = step;
      if (line.scrollWidth <= line.clientWidth) return;
    }
  };
  fit();
  const resized = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(fit);
  resized?.observe(line);
  const words = new MutationObserver(fit);
  words.observe(line, { childList: true, subtree: true, characterData: true });
  return () => {
    resized?.disconnect();
    words.disconnect();
  };
}
