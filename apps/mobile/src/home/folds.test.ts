import { beforeEach, expect, it, vi } from "vitest";
import { forgetFolds } from "./fold-keys";
import { savedFolds, toggleFold } from "./folds";

const phone = vi.hoisted(() => ({ mac: "studio" as string | null, saved: new Map<string, string>() }));
vi.mock("../client", () => ({
  shownMacId: () => phone.mac,
  storage: {
    getString: (key: string) => phone.saved.get(key),
    set: (key: string, value: string) => void phone.saved.set(key, value),
    remove: (key: string) => void phone.saved.delete(key),
  },
}));

beforeEach(() => {
  phone.mac = "studio";
  phone.saved.clear();
});

it("keeps folds per Mac in the desktop's keys, across launches", () => {
  toggleFold("project:openorc");
  toggleFold("snoozed-open:threads");
  expect(phone.saved.get("home.collapsed.studio")).toBe(JSON.stringify(["project:openorc", "snoozed-open:threads"]));
  phone.mac = "laptop";
  expect(savedFolds()).toEqual([]);
  phone.mac = "studio";
  expect(savedFolds()).toEqual(["project:openorc", "snoozed-open:threads"]);
  expect(savedFolds()).toBe(savedFolds());
  toggleFold("project:openorc");
  expect(savedFolds()).toEqual(["snoozed-open:threads"]);
});

it("drops the folds of the days Home used to group by, and keeps project and sub thread folds", () => {
  phone.saved.set("home.collapsed.studio", JSON.stringify(["project:openorc", "pinned:openorc", "thread-closed:parent", "day-closed:today"]));
  expect(savedFolds()).toEqual(["project:openorc", "thread-closed:parent"]);
  toggleFold("resolved-open:threads");
  expect(JSON.parse(phone.saved.get("home.collapsed.studio")!)).toEqual(["project:openorc", "thread-closed:parent", "resolved-open:threads"]);
});

it("forgets a Mac's folds with the Mac", () => {
  toggleFold("pinned:threads");
  forgetFolds({ remove: (key) => phone.saved.delete(key) }, "studio");
  expect(savedFolds()).toEqual([]);
});
