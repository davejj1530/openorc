// @vitest-environment jsdom
import { expect, it, vi } from "vitest";

const kept = vi.hoisted(() => new Map<string, string>([["home.filter", "orc"]]));
vi.mock("../client", async () => {
  const { ScratchStore } = await import("../scratch-store");
  return { storage: new ScratchStore({ getString: (key) => kept.get(key), set: (key, value) => void kept.set(key, value), remove: (key) => void kept.delete(key) }) };
});

const { storage } = (await import("../client")) as unknown as { storage: import("../scratch-store").ScratchStore };
const { chooseFilter, filterChoice } = await import("./filter");
const shown = async () => {
  const { useHomeFilter } = await import("./filter");
  const { renderHook } = await import("@testing-library/react");
  return filterChoice(renderHook(useHomeFilter).result.current);
};

it("forgets a filter chosen in the demo when it ends, back to the one kept", async () => {
  expect(await shown()).toBe("orc");
  storage.scratch(true);
  chooseFilter("pinned");
  expect(await shown()).toBe("pinned");
  chooseFilter("archived");
  storage.scratch(false);
  expect(await shown()).toBe("orc");
  expect(kept.get("home.filter")).toBe("orc");
});
