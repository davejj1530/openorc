/**
 * Wires the `[role="tab"]` buttons inside `root` to its `[data-panel]` elements:
 * selection, roving focus, and arrow-key navigation. `onSelect` hears the
 * visitor's picks, not the first selection.
 */
export function initTabs(root: HTMLElement, onSelect?: (index: number) => void) {
  const tabs = [...root.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  const panels = [...root.querySelectorAll<HTMLElement>("[data-panel]")];
  if (!tabs.length || panels.length !== tabs.length) return false;

  const show = (index: number) =>
    tabs.forEach((tab, i) => {
      tab.setAttribute("aria-selected", String(i === index));
      tab.tabIndex = i === index ? 0 : -1;
      panels[i].hidden = i !== index;
    });
  const select = (index: number, focus = false) => {
    show(index);
    if (focus) tabs[index].focus();
    onSelect?.(index);
  };

  tabs.forEach((tab, i) => {
    tab.addEventListener("click", () => select(i));
    tab.addEventListener("keydown", (event) => {
      let next = i;
      if (event.key === "ArrowRight") next = (i + 1) % tabs.length;
      else if (event.key === "ArrowLeft") next = (i - 1 + tabs.length) % tabs.length;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = tabs.length - 1;
      else return;
      event.preventDefault();
      select(next, true);
    });
  });
  panels.forEach((panel, i) => {
    panel.setAttribute("role", "tabpanel");
    panel.setAttribute("aria-labelledby", tabs[i].id);
  });
  show(
    Math.max(
      0,
      tabs.findIndex((tab) => tab.getAttribute("aria-selected") === "true"),
    ),
  );
  return true;
}
