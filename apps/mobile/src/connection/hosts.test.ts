import { describe, expect, it } from "vitest";
import { screenHost } from "./HostScope.helpers";
import { groupOf, moverOf, namedBrain, partnerStore, forgetRemovedBrains, withPartnerRecord } from "./hosts";
import type { MacStore, SavedMac } from "./saved-macs";

const mac: SavedMac = { id: "mac", name: "Studio", routes: [{ kind: "lan", host: "192.168.1.2", port: 47820 }], lastRoute: null, kind: "mac", brain: "brain" };
const brain: SavedMac = { id: "brain", name: "Cloud", routes: [{ kind: "public", host: "sb-1.vercel.run", port: 443 }], lastRoute: null, kind: "brain" };
const other: SavedMac = { id: "other", name: "Laptop", routes: [], lastRoute: null };

function store(saved: SavedMac[]): MacStore & { saved: SavedMac[] } {
  const self = {
    saved,
    list: () => self.saved,
    activeId: () => "mac",
    setActiveId: () => undefined,
    save: (host: SavedMac) => void (self.saved = [...self.saved.filter((each) => each.id !== host.id), host]),
    remove: (id: string) => void (self.saved = self.saved.filter((each) => each.id !== id)),
  };
  return self;
}

describe("the hosts Home shows together", () => {
  it("pairs a Mac with the brain it named, from either side, and leaves an unrelated host alone", () => {
    expect(groupOf([mac, brain, other], "mac")).toEqual({ primary: mac, partner: brain });
    expect(groupOf([mac, brain, other], "brain")).toEqual({ primary: brain, partner: mac });
    expect(groupOf([mac, brain, other], "other")).toEqual({ primary: other, partner: null });
    expect(groupOf([{ ...mac, brain: null }, brain], "mac").partner).toBeNull();
    expect(groupOf([], null)).toEqual({ primary: null, partner: null });
  });

  it("forgets a brain its Mac removed, but never a Mac, nor a brain another Mac still names as its own", () => {
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

  it("keeps a Mac's word about its brain, once", () => {
    const saved = store([{ ...mac, brain: null }, brain]);
    expect(namedBrain(saved, "mac", "brain")).toBe(true);
    expect(namedBrain(saved, "mac", "brain")).toBe(false);
    expect(saved.list().find((host) => host.id === "mac")?.brain).toBe("brain");
    expect(namedBrain(saved, "brain", "mac")).toBe(false);
  });

  it("lets the partner's link see and save only the partner, and never forget a host", () => {
    const saved = store([mac, brain]);
    let partner: string | null = "brain";
    const view = partnerStore(saved, () => partner);
    expect(view.list().map((host) => host.id)).toEqual(["brain"]);
    view.setActiveId("brain");
    expect(view.activeId()).toBe("brain");
    view.remove("brain");
    expect(saved.list()).toHaveLength(2);
    view.save({ ...brain, name: "Cloud brain" });
    expect(saved.list().find((host) => host.id === "brain")?.name).toBe("Cloud brain");
    partner = null;
    expect(view.list()).toEqual([]);
    expect(view.activeId()).toBeNull();
  });
});

describe("a screen's host", () => {
  it("is its own, else the nearest one under it, so a sheet keeps its thread's", () => {
    const routes = [{ key: "home" }, { key: "thread", params: { id: "t", host: "brain" } }, { key: "diff", params: { path: "a.ts" } }];
    expect(screenHost(routes, routes[2]!)).toBe("brain");
    expect(screenHost(routes, routes[0]!)).toBeNull();
    expect(screenHost([{ key: "thread", params: { id: "t" } }], { key: "thread", params: { id: "t" } })).toBeNull();
    // Pushed and not yet in the stack's state: its own params name its host.
    expect(screenHost([{ key: "home" }], { key: "thread", params: { id: "t", host: "brain" } })).toBe("brain");
  });
});

describe("moving threads between a Mac and its brain", () => {
  it("is the group's Mac's to do, from a brain thread and a Mac thread alike, and nobody's without both", () => {
    const saved = [mac, brain, other];
    expect(moverOf(saved, { primary: "mac", partner: "brain" }, "brain")).toEqual({ mac: "mac", onBrain: true });
    expect(moverOf(saved, { primary: "mac", partner: "brain" }, null)).toEqual({ mac: "mac", onBrain: false });
    expect(moverOf(saved, { primary: "brain", partner: "mac" }, null)).toEqual({ mac: "mac", onBrain: true });
    expect(moverOf(saved, { primary: "brain", partner: null }, null)).toBeNull();
    expect(moverOf(saved, { primary: "mac", partner: "other" }, "other")).toBeNull();
  });

  it("reads the partner's own record, which its link renamed, in the list the shown link keeps", () => {
    const renamed = { ...brain, name: "Cloud brain" };
    expect(withPartnerRecord([mac, brain], [renamed]).map((host) => host.name)).toEqual(["Studio", "Cloud brain"]);
    const alone = [mac, brain];
    expect(withPartnerRecord(alone, [])).toBe(alone);
  });
});
