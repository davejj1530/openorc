// @vitest-environment jsdom
import { expect, it, vi } from "vitest";

const kept = vi.hoisted(() => new Map<string, string>([["home.filter", "archived"]]));
const phone = vi.hoisted(() => ({ mac: "studio" as string | null }));
vi.mock("../client", async () => {
  const { ScratchStore } = await import("../scratch-store");
  return {
    shownMacId: () => phone.mac,
    storage: new ScratchStore({ getString: (key) => kept.get(key), set: (key, value) => void kept.set(key, value), remove: (key) => void kept.delete(key) }),
  };
});

const { storage } = (await import("../client")) as unknown as { storage: import("../scratch-store").ScratchStore };
const { chooseFilter, chooseOwnership, filterChoice, filterLabel, hiddenIn, ownershipIn, pruneHidden, toggleWorkspace } = await import("./filter");
const filter = async () => {
  const { useHomeFilter } = await import("./filter");
  const { renderHook } = await import("@testing-library/react");
  return renderHook(useHomeFilter).result.current;
};
const shown = async () => filterChoice(await filter());

it("lists every thread at first, forgetting the archive filter Resolved replaced", async () => {
  expect(await shown()).toBe("all");
  expect(kept.has("home.filter")).toBe(false);
});

it("forgets the pinned filter chosen in the demo when it ends", async () => {
  storage.scratch(true);
  chooseFilter("pinned");
  expect(await shown()).toBe("pinned");
  storage.scratch(false);
  expect(await shown()).toBe("all");
});

it("keeps the unticked workspaces per Mac and per space, across launches, and forgets one that went", async () => {
  toggleWorkspace("org-birch", "canvas");
  toggleWorkspace("mac", "notes");
  expect(hiddenIn(await filter(), "org-birch")).toEqual(["canvas"]);
  expect(JSON.parse(kept.get("home.hidden.studio")!)).toEqual({ "org-birch": ["canvas"], mac: ["notes"] });
  phone.mac = "laptop";
  expect(hiddenIn(await filter(), "org-birch")).toEqual([]);
  phone.mac = "studio";
  pruneHidden("org-birch", new Set(["billing"]));
  expect(hiddenIn(await filter(), "org-birch")).toEqual([]);
  expect(hiddenIn(await filter(), "mac")).toEqual(["notes"]);
  toggleWorkspace("mac", "notes");
  expect(hiddenIn(await filter(), "mac")).toEqual([]);
});

it("lists everyone's threads in a space until the person chooses their own, and names what narrows the list", async () => {
  expect(ownershipIn(await filter(), "org-birch")).toBe("everyone");
  expect(filterLabel(await filter(), "org-birch", true)).toEqual({ narrowed: false, label: "Show" });
  chooseOwnership("org-birch", "mine");
  toggleWorkspace("org-birch", "canvas");
  chooseFilter("pinned");
  expect(ownershipIn(await filter(), "org-alder")).toBe("everyone");
  expect(filterLabel(await filter(), "org-birch", true)).toEqual({ narrowed: true, label: "Show, Pinned threads, Mine, 1 workspace hidden" });
  chooseOwnership("org-birch", "everyone");
  toggleWorkspace("org-birch", "canvas");
  chooseFilter("all");
  expect(filterLabel(await filter(), "org-birch", true).narrowed).toBe(false);
});
