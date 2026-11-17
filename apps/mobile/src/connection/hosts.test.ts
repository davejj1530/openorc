import { describe, expect, it } from "vitest";
import { dropSavedBrains } from "./hosts";
import type { MacStore, SavedMac } from "./saved-macs";

type Earlier = SavedMac & { kind?: string; brain?: string | null };

const mac: Earlier = { id: "mac", name: "Studio", routes: [{ kind: "lan", host: "192.168.1.2", port: 47820 }], lastRoute: null, kind: "mac", brain: "brain" };
const brain: Earlier = { id: "brain", name: "Cloud", routes: [{ kind: "public", host: "sb-1.vercel.run", port: 443 }], lastRoute: null, kind: "brain" };
const other: Earlier = { id: "other", name: "Laptop", routes: [], lastRoute: null };

function store(saved: Earlier[], active: string | null = "mac"): MacStore & { saved: Earlier[] } {
  const self = {
    saved,
    list: () => self.saved,
    activeId: () => active,
    setActiveId: (id: string | null) => void (active = id),
    save: (host: SavedMac) => void (self.saved = self.saved.map((each) => (each.id === host.id ? host : each))),
    remove: (id: string) => void (self.saved = self.saved.filter((each) => each.id !== id)),
  };
  return self;
}

const dropped = (saved: MacStore) => {
  const forgotten: string[] = [];
  dropSavedBrains(saved, (id) => void forgotten.push(id));
  return forgotten;
};

describe("what an earlier build saved for a cloud brain", () => {
  it("goes at start, with this phone's keys for it, and the Macs' records lose the brain they named", () => {
    const saved = store([mac, brain, other]);
    expect(dropped(saved)).toEqual(["brain"]);
    expect(saved.saved).toEqual([
      { id: "mac", name: "Studio", routes: mac.routes, lastRoute: null },
      { id: "other", name: "Laptop", routes: [], lastRoute: null },
    ]);
    expect(saved.activeId()).toBe("mac");
  });

  it("gives way to the Mac that named it when it was shown last, else to the first Mac, else to none", () => {
    const shown = (saved: Earlier[]) => {
      const kept = store(saved, "brain");
      dropped(kept);
      return kept.activeId();
    };
    expect(shown([other, mac, brain])).toBe("mac");
    expect(shown([other, { ...mac, brain: null }, brain])).toBe("other");
    expect(shown([brain])).toBeNull();
  });

  it("leaves a phone with nothing of the kind as it was, on every later start", () => {
    const saved = store([{ ...other }], "other");
    const before = saved.saved;
    expect(dropped(saved)).toEqual([]);
    expect(saved.saved).toBe(before);
    expect(saved.activeId()).toBe("other");
  });
});
