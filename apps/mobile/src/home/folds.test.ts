import { beforeEach, expect, it, vi } from "vitest";
import { forgetFolds } from "./fold-keys";
import { savedFolds, toggleFold, unfoldProject } from "./folds";

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
  toggleFold("snoozed-open:openorc");
  expect(phone.saved.get("home.collapsed.studio")).toBe(JSON.stringify(["project:openorc", "snoozed-open:openorc"]));
  phone.mac = "laptop";
  expect(savedFolds()).toEqual([]);
  phone.mac = "studio";
  expect(savedFolds()).toEqual(["project:openorc", "snoozed-open:openorc"]);
  expect(savedFolds()).toBe(savedFolds());
  toggleFold("project:openorc");
  expect(savedFolds()).toEqual(["snoozed-open:openorc"]);
});

it("opens a folded project when a thread starts in it, and leaves an open one", () => {
  toggleFold("project:openorc");
  unfoldProject("openorc");
  unfoldProject("website");
  expect(savedFolds()).toEqual([]);
});

it("forgets a Mac's folds with the Mac", () => {
  toggleFold("pinned:openorc");
  forgetFolds({ remove: (key) => phone.saved.delete(key) }, "studio");
  expect(savedFolds()).toEqual([]);
});

it("keeps the partner host's folds under its own id, apart from the shown Mac's", () => {
  toggleFold("project:openorc", "brain");
  expect(savedFolds("brain")).toEqual(["project:openorc"]);
  expect(savedFolds()).toEqual([]);
  expect(savedFolds("brain")).toBe(savedFolds("brain"));
  toggleFold("project:website");
  expect([savedFolds(), savedFolds("brain")]).toEqual([["project:website"], ["project:openorc"]]);
  unfoldProject("openorc", "brain");
  expect(savedFolds("brain")).toEqual([]);
});
