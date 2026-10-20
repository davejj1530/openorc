/**
 * The ground a floating layer lands on. Floating layers have no shadow: they take the fill step
 * away from what is under them (D2). Over the tile they paint --surface; over a plane (the panel,
 * a sheet, a dialog, the composer, another menu) they paint the tile, --bg. The layer carries
 * data-ground and styles/floating.css turns it into --float-fill.
 *
 * What counts is where the layer lands, not where its trigger sits: the composer's pickers open
 * from the composer onto the conversation, and a panel's menus drop onto the panel. So the ground
 * is read under the open layer, once it is placed.
 */
export type Ground = "tile" | "plane";

/* Planes and the tile cards that sit inside them. Keep in step with the contextual-fill lists in
   app.css; new planes should carry data-plane rather than join these lists. */
const PLANE =
  ':is([data-plane]:not([data-plane="tile"]), .panel-content, .composer-shell, [role="dialog"], .menu-popup, .floating-popover, .model-picker-popup, .composer-context-popup, .composer-effort-popup, .command-palette)';
const TILE_CARD = ':is([data-plane="tile"], .settings-group, .settings-card, .settings-disclosure, .usage-account, .memory-control, .skills-scope, .harness-list)';

export function groundOf(element: Element | null): Ground {
  const nearest = element?.closest(`${PLANE}, ${TILE_CARD}`);
  return nearest?.matches(PLANE) ? "plane" : "tile";
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
  const planes = points.filter(([x, y]) => groundOf(beneath(x, y)) === "plane").length;
  return { ground: planes > points.length / 2 ? "plane" : "tile", straddles: planes > 0 && planes < points.length };
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
