import { expect, it } from "vitest";
import { routeFromSpec, specFromRoute } from "./router";
import { validSpaceView, type SpaceInventory } from "./space-view";

const inventory: SpaceInventory = { id: "team", personal: false, projects: [], threads: [], taskIds: [] };
it.each(["invitations", "seats"] as const)("restores the organization's %s destination and history", (section) => {
  const route = { view: "people" as const, spaceId: "team", section };
  expect(routeFromSpec(specFromRoute(route))).toEqual(route);
  expect(validSpaceView({ destination: route, history: [route] }, inventory)).toMatchObject({ destination: route, history: [route] });
  expect(validSpaceView({ destination: route }, { ...inventory, id: "another" }).destination).toEqual({ view: "newthread" });
});
