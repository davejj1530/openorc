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
  toggleFold("day-open:yesterday");
  toggleFold("snoozed-open:threads");
  expect(phone.saved.get("home.collapsed.studio")).toBe(JSON.stringify(["day-open:yesterday", "snoozed-open:threads"]));
  phone.mac = "laptop";
  expect(savedFolds()).toEqual([]);
  phone.mac = "studio";
  expect(savedFolds()).toEqual(["day-open:yesterday", "snoozed-open:threads"]);
  expect(savedFolds()).toBe(savedFolds());
  toggleFold("day-open:yesterday");
  expect(savedFolds()).toEqual(["snoozed-open:threads"]);
});

it("drops the folds of the project groups Home used to show, and keeps sub thread folds", () => {
  phone.saved.set("home.collapsed.studio", JSON.stringify(["project:openorc", "pinned:openorc", "thread-closed:parent", "day-closed:today"]));
  expect(savedFolds()).toEqual(["thread-closed:parent", "day-closed:today"]);
  toggleFold("day-open:older");
  expect(JSON.parse(phone.saved.get("home.collapsed.studio")!)).toEqual(["thread-closed:parent", "day-closed:today", "day-open:older"]);
});

it("forgets a Mac's folds with the Mac", () => {
  toggleFold("pinned:threads");
  forgetFolds({ remove: (key) => phone.saved.delete(key) }, "studio");
  expect(savedFolds()).toEqual([]);
});

it("keeps the partner host's folds under its own id, apart from the shown Mac's", () => {
  toggleFold("day-open:yesterday", "brain");
  expect(savedFolds("brain")).toEqual(["day-open:yesterday"]);
  expect(savedFolds()).toEqual([]);
  expect(savedFolds("brain")).toBe(savedFolds("brain"));
  toggleFold("day-closed:today");
  expect([savedFolds(), savedFolds("brain")]).toEqual([["day-closed:today"], ["day-open:yesterday"]]);
});
