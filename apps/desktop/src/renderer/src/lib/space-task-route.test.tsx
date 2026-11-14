import { expect, it } from "vitest";
import { validSpaceView, type SpaceInventory } from "./space-view";
import { routeFromSpec, specFromRoute, type Route } from "./router";

const ref = { kind: "online", accountId: "account", spaceId: "team", projectId: "remote-project", id: "task" };
const route = { view: "task", taskId: "task", tab: "spec", taskRef: ref };
const inventory: SpaceInventory = {
  id: "team",
  accountId: "account",
  personal: false,
  taskIds: [],
  threads: [],
  projects: [{ key: "project", name: "Project", repo: null, localProjectId: null, hostedProjectId: "remote-project", connected: false }],
};
it("restores an explicit online task without depending on the local task list", () => {
  expect(validSpaceView({ destination: route, history: [route] }, inventory)).toMatchObject({ destination: route, history: [route] });
});
it("keeps online identity in a window route instead of producing a local task link", () => {
  const explicit: Route = { view: "task", taskId: "task:one", tab: "spec", taskRef: { kind: "online", accountId: "account", spaceId: "team", projectId: "remote-project", id: "task:one" } };
  expect(routeFromSpec(specFromRoute(explicit))).toEqual(explicit);
  expect(routeFromSpec("online-task:account:team:project:task:spec:extra")).toBeNull();
  expect(routeFromSpec("online-task:account:team:project:task:unknown")).toBeNull();
});
it.each([{ accountId: "other" }, { spaceId: "other" }, { projectId: "other" }, { id: "other" }, { kind: "local" }])(
  "never turns an inaccessible online task into a same-id local task: %j",
  (change) => {
    const saved = { destination: { ...route, taskRef: { ...ref, ...change } } };
    expect(validSpaceView(saved, { ...inventory, taskIds: ["task"] }).destination).toEqual({ view: "newthread" });
  },
);
