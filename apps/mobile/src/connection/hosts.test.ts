import { describe, expect, it } from "vitest";
import { forgetRemovedBrains, macsOnly, namedBrain } from "./hosts";
import type { MacStore, SavedMac } from "./saved-macs";

const mac: SavedMac = { id: "mac", name: "Studio", routes: [{ kind: "lan", host: "192.168.1.2", port: 47820 }], lastRoute: null, kind: "mac", brain: "brain" };
const brain: SavedMac = { id: "brain", name: "Cloud", routes: [{ kind: "public", host: "sb-1.vercel.run", port: 443 }], lastRoute: null, kind: "brain" };
const other: SavedMac = { id: "other", name: "Laptop", routes: [], lastRoute: null };

function store(saved: SavedMac[], active: string | null = "mac"): MacStore & { saved: SavedMac[] } {
  const self = {
    saved,
    list: () => self.saved,
    activeId: () => active,
    setActiveId: (id: string | null) => void (active = id),
    save: (host: SavedMac) => void (self.saved = [...self.saved.filter((each) => each.id !== host.id), host]),
    remove: (id: string) => void (self.saved = self.saved.filter((each) => each.id !== id)),
  };
  return self;
}

describe("a cloud brain an earlier build paired", () => {
  it("is out of the link's sight, which still saves a Mac and removes any host by its id", () => {
    const saved = store([mac, brain, other]);
    const view = macsOnly(saved);
    expect(view.list().map((host) => host.id)).toEqual(["mac", "other"]);
    expect(view.activeId()).toBe("mac");
    view.save({ ...other, name: "Travel laptop" });
    expect(view.list().map((host) => host.name)).toEqual(["Studio", "Travel laptop"]);
    view.remove("brain");
    expect(saved.list().map((host) => host.id)).toEqual(["mac", "other"]);
  });

  it("gives way to the Mac that named it when it was shown last, else to the first Mac, else to none", () => {
    expect(macsOnly(store([other, mac, brain], "brain")).activeId()).toBe("mac");
    expect(macsOnly(store([other, { ...mac, brain: null }, brain], "brain")).activeId()).toBe("other");
    expect(macsOnly(store([brain], "brain")).activeId()).toBeNull();
    expect(macsOnly(store([mac, brain, other], "other")).activeId()).toBe("other");
  });

  it("is forgotten once its Mac removed it, but never a Mac, nor a brain another Mac still names as its own", () => {
    const forgotten = (saved: SavedMac[], removed: string[]) => {
      const ids: string[] = [];
      forgetRemovedBrains(store(saved), (id) => void ids.push(id))("mac", removed);
      return ids;
    };
    expect(forgotten([{ ...mac, brain: null }, brain, other], ["brain"])).toEqual(["brain"]);
    expect(forgotten([mac, brain, other], ["brain", "other"])).toEqual(["brain"]);
    expect(forgotten([mac, brain, { ...other, kind: "mac", brain: "brain" }], ["brain"])).toEqual([]);
    expect(forgotten([mac, brain], [])).toEqual([]);
  });

  it("stays named on its Mac's record until the Mac names none, each word kept once", () => {
    const saved = store([{ ...mac, brain: null }, brain]);
    expect(namedBrain(saved, "mac", "brain")).toBe(true);
    expect(namedBrain(saved, "mac", "brain")).toBe(false);
    expect(saved.list().find((host) => host.id === "mac")?.brain).toBe("brain");
    expect(namedBrain(saved, "mac", null)).toBe(true);
    expect(saved.list().find((host) => host.id === "mac")?.brain).toBeNull();
    expect(namedBrain(saved, "brain", "mac")).toBe(false);
  });
});
