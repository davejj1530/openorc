import type { SearchEntry, SearchGroup } from "../lib/search";

function make<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string) {
  const element = document.createElement(tag);
  element.className = className;
  if (text) element.textContent = text;
  return element;
}

/** A result: the name, and a faint line of context under it. */
function option(entry: SearchEntry) {
  const link = make("a", "search-option");
  link.dataset.part = "";
  link.id = `search-${entry.id}`;
  link.href = entry.href;
  link.tabIndex = -1;
  link.setAttribute("role", "option");
  link.setAttribute("aria-selected", "false");
  link.append(make("span", "search-option-name", entry.name));
  if (entry.about) link.append(make("span", "search-option-about", entry.about));
  return link;
}

function group({ label, entries }: SearchGroup, index: number) {
  const box = make("div", "search-group");
  const heading = make("div", "search-group-label", label);
  heading.dataset.part = "";
  heading.id = `search-group-${index}`;
  box.setAttribute("role", "group");
  box.setAttribute("aria-labelledby", heading.id);
  box.append(heading, ...entries.map(option));
  return box;
}

function nothing() {
  const line = make("div", "search-empty", "No matches");
  line.dataset.part = "";
  return line;
}

/**
 * The listbox under the field. The field keeps focus; the arrows move which result is active, the active one scrolls
 * into view, Enter opens it, and the pointer moves it too, so there is only ever one highlighted row.
 */
export function createResults(listbox: HTMLElement, input: HTMLInputElement) {
  let options: HTMLAnchorElement[] = [];
  let active = 0;

  function activate(index: number, reveal: boolean) {
    options[active]?.setAttribute("aria-selected", "false");
    active = index;
    const current = options[active];
    if (!current) {
      input.removeAttribute("aria-activedescendant");
      return;
    }
    current.setAttribute("aria-selected", "true");
    input.setAttribute("aria-activedescendant", current.id);
    if (reveal) current.scrollIntoView({ block: "nearest" });
  }

  function show(groups: SearchGroup[]) {
    listbox.replaceChildren(...(groups.length ? groups.map(group) : [nothing()]));
    options = [...listbox.querySelectorAll<HTMLAnchorElement>('[role="option"]')];
    activate(0, false);
    listbox.parentElement?.scrollTo({ top: 0 });
  }

  let pointer = "";
  listbox.addEventListener("pointermove", (event) => {
    // Scrolling the active row into view slides rows under a resting pointer; only a pointer that moved picks one.
    const at = `${event.clientX},${event.clientY}`;
    if (at === pointer) return;
    pointer = at;
    const hovered = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('[role="option"]') : null;
    if (hovered) activate(options.indexOf(hovered), false);
  });

  input.addEventListener("keydown", (event) => {
    if (event.isComposing) return;
    if ((event.key === "ArrowDown" || event.key === "ArrowUp") && options.length) {
      event.preventDefault();
      activate((active + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length, true);
    } else if (event.key === "Enter") {
      event.preventDefault();
      // A click, so choosing by key opens, closes and sounds the same as choosing by pointer.
      options[active]?.click();
    }
  });

  return { show };
}
