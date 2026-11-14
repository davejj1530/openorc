/**
 * The ground a floating layer lands on. Floating layers take the fill step away from what is under them (D2). Over the
 * tile they paint --surface; over a plane that is itself --surface (a sheet, a dialog, another menu, the panel) they
 * paint the tile, --bg. A piece set into the ground (the composer, a card, a Settings tile) is a step darker than the
 * ground, so a layer over one paints --surface as it does over the tile, with a hairline for its edge where the two
 * fills meet. The layer carries data-ground and styles/floating.css turns it into --float-fill.
 *
 * What counts is where the layer lands, not where its trigger sits: the composer's pickers open
 * from the composer onto the conversation, and a panel's menus drop onto the panel. So the ground
 * is read under the open layer, once it is placed.
 */
export type Ground = "tile" | "plane" | "piece";

/* Planes painted --surface (floating layers, sheets, the panel), then the pieces set into the ground. Keep in step with
   the contextual-fill lists in app.css; a new piece should carry data-plane rather than join the list. */
const PLANE = ':is(.panel-content, [role="dialog"], .menu-popup, .floating-popover, .model-picker-popup, .composer-context-popup, .composer-effort-popup, .command-palette, .commit-sheet)';
const PIECE = ':is([data-plane]:not([data-plane="tile"]), .composer-shell, .settings-group, .settings-card, .settings-disclosure, .usage-account, .memory-control)';
const TILE_CARD = ':is([data-plane="tile"], .harness-list)';

export function groundOf(element: Element | null): Ground {
  const nearest = element?.closest(`${PLANE}, ${PIECE}, ${TILE_CARD}`);
  if (nearest?.matches(PLANE)) return "plane";
  return nearest?.matches(PIECE) ? "piece" : "tile";
}

/**
 * The ground most of the layer covers, sampled at its centre and four inset points. A layer that
 * straddles tile and plane has no step away from both, so it steps away from the larger part and
 * reports that it straddles.
 */
export function groundBeneath(layer: HTMLElement): { ground: Ground; straddles: boolean } {
  if (typeof document.elementsFromPoint !== "function") return { ground: "tile", straddles: false };
  const own = layer.parentElement ?? layer;
  const box = layer.getBoundingClientRect();
  const inset = Math.min(16, box.width / 4, box.height / 4);
  const points: [number, number][] = [
    [box.left + box.width / 2, box.top + box.height / 2],
    [box.left + inset, box.top + inset],
    [box.right - inset, box.top + inset],
    [box.left + inset, box.bottom - inset],
    [box.right - inset, box.bottom - inset],
  ];
  // Skip the layer itself and Base UI's invisible click-catching backdrops.
  const beneath = (x: number, y: number) => document.elementsFromPoint(x, y).find((element) => !own.contains(element) && !element.matches("[data-base-ui-inert]")) ?? null;
  const grounds = points.map(([x, y]) => groundOf(beneath(x, y)));
  const count = (ground: Ground) => grounds.filter((each) => each === ground).length;
  const most = (["plane", "piece", "tile"] as const).reduce((best, ground) => (count(ground) > count(best) ? ground : best));
  return { ground: most, straddles: count("plane") > 0 && count("plane") < points.length };
}

/**
 * A ref for a floating layer's popup. Once the positioner has placed it, the layer reads the
 * ground under it and sets data-ground, plus data-straddles when it lands across the tile and a
 * plane (a composer picker over the conversation). A layer that states data-ground itself keeps it: a list
 * that only ever opens inside a dialog or sheet is "plane" even where it hangs over the backdrop.
 */
export function floatingGround(layer: HTMLElement | null) {
  if (!layer || layer.dataset.ground) return;
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      if (!layer.isConnected) return;
      const { ground, straddles } = groundBeneath(layer);
      layer.dataset.ground = ground;
      if (straddles) layer.dataset.straddles = "";
    }),
  );
}
