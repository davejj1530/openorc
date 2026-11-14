import { afterEach, expect, it } from "vitest";
import { groundOf } from "./use-anchor-ground";

afterEach(() => {
  document.body.innerHTML = "";
});

const at = (html: string) => {
  document.body.innerHTML = html;
  return document.querySelector("[data-at]");
};

it("reads a piece set into the ground as its own ground, so a menu over it paints the float's own fill, not the ground's", () => {
  expect(groundOf(at('<div class="composer-shell"><button data-at></button></div>'))).toBe("piece");
  expect(groundOf(at('<div class="question-card" data-plane><button data-at></button></div>'))).toBe("piece");
  expect(groundOf(at('<div class="settings-card"><span data-at></span></div>'))).toBe("piece");
});

it("steps a layer over a sheet, a dialog, the panel or another menu to the ground's fill, and leaves the tile as it is", () => {
  expect(groundOf(at('<div role="dialog"><span data-at></span></div>'))).toBe("plane");
  expect(groundOf(at('<div class="menu-popup"><span data-at></span></div>'))).toBe("plane");
  expect(groundOf(at('<div role="dialog"><div class="settings-card"><span data-at></span></div></div>'))).toBe("piece");
  expect(groundOf(at('<div class="panel-content"><div data-plane="tile"><span data-at></span></div></div>'))).toBe("tile");
  expect(groundOf(at("<main><span data-at></span></main>"))).toBe("tile");
});
