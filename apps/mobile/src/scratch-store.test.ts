import { describe, expect, it, vi } from "vitest";
import { ScratchStore, type KeyValue } from "./scratch-store";

function memory(initial: Record<string, string> = {}): KeyValue & { values: Map<string, string> } {
  const values = new Map(Object.entries(initial));
  return { values, getString: (key) => values.get(key), set: (key, value) => void values.set(key, value), remove: (key) => void values.delete(key) };
}

describe("ScratchStore", () => {
  it("reads and writes what is kept while nothing is scratched", () => {
    const kept = memory({ appearance: "dark" });
    const store = new ScratchStore(kept);
    store.set("home.filter", "orc");
    store.remove("appearance");
    expect(Object.fromEntries(kept.values)).toEqual({ "home.filter": "orc" });
    expect(store.getString("home.filter")).toBe("orc");
  });

  it("keeps writes in memory while scratching, over the kept values, and never touches them", () => {
    const kept = memory({ appearance: "dark", "home.filter": "orc" });
    const store = new ScratchStore(kept);
    store.scratch(true);
    expect(store.getString("appearance")).toBe("dark");
    store.set("appearance", "light");
    store.remove("home.filter");
    store.set("lists.demo", "[]");
    expect(store.getString("appearance")).toBe("light");
    expect(store.getString("home.filter")).toBeUndefined();
    expect(store.getString("lists.demo")).toBe("[]");
    expect(Object.fromEntries(kept.values)).toEqual({ appearance: "dark", "home.filter": "orc" });
  });

  it("drops the scratch when it ends, and tells whoever holds a value in memory to read it again", () => {
    const kept = memory({ appearance: "dark" });
    const store = new ScratchStore(kept);
    const dropped = vi.fn(() => store.getString("appearance"));
    store.onDropped(dropped);
    store.scratch(true);
    store.set("appearance", "light");
    store.scratch(false);
    expect(dropped).toHaveBeenCalledTimes(1);
    expect(dropped).toHaveReturnedWith("dark");
    expect(store.getString("appearance")).toBe("dark");
    expect([...kept.values.keys()]).toEqual(["appearance"]);
  });

  it("starts each scratch empty, and says nothing when the scratch did not change", () => {
    const store = new ScratchStore(memory());
    const dropped = vi.fn();
    store.onDropped(dropped);
    store.scratch(false);
    store.scratch(true);
    store.set("drafts.t1", "hello");
    store.scratch(true);
    expect(store.getString("drafts.t1")).toBe("hello");
    store.scratch(false);
    store.scratch(true);
    expect(store.getString("drafts.t1")).toBeUndefined();
    expect(dropped).toHaveBeenCalledTimes(1);
  });
});
