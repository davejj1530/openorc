import sprite from "./icons-diff.svg?raw";

let symbols: Element[] | undefined;

/** Apply the local family through the diff renderer's onPostRender hook. */
export function applyDiffIcons(node: HTMLElement) {
  const sheet = node.shadowRoot?.querySelector("svg[data-icon-sprite]");
  if (!sheet || sheet.hasAttribute("data-openorc-icons")) return;
  symbols ??= Array.from(new DOMParser().parseFromString(sprite, "image/svg+xml").documentElement.children);
  sheet.replaceChildren(...symbols.map((symbol) => symbol.cloneNode(true)));
  sheet.setAttribute("data-openorc-icons", "precision-outline");
}
