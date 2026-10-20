/*
 * Menu class names. The look lives in styles/floating.css; these only name the parts so every
 * menu, context menu and combobox list shares one recipe.
 *
 * menuPopup       drops out of its trigger: r16, padding 6, --float-fill, no border or shadow.
 * menuGrowPopup   grows out of the pill it covers, r18 to r20 over 420ms. Position it over the
 *                 trigger with growOffset. Flipped above the trigger it drops instead.
 * menuItem        a 36px r10 row; the fill step on highlight, faint when disabled.
 * menuItemDanger  a destructive row, in --bad.
 * menuItemDetail  a row with a second line under its label (label, then a faint hint).
 * menuSeparator   a hairline between groups of rows.
 *
 * Floating layers take data-ground from useAnchorGround (lib/use-anchor-ground.ts) or a fixed
 * "plane" when their trigger always sits on one.
 */
export const menuPopup = "menu-popup";
export const menuGrowPopup = "menu-popup menu-grow";
export const menuItem = "menu-item";
export const menuItemDanger = "menu-item menu-item-danger";
export const menuItemDetail = "menu-item menu-item-detail";
export const menuSeparator = "menu-separator";

/** Positioner sideOffset for menuGrowPopup: the popup's top edge sits on the trigger's. */
export function growOffset({ anchor }: { anchor: { height: number } }): number {
  return -anchor.height;
}
