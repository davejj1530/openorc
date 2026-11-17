import type { MacStore, SavedMac } from "./saved-macs";

/** A saved host as an earlier build may have written it: one that paired a Mac's cloud brain beside the Mac. */
type EarlierHost = SavedMac & { kind?: string; brain?: string | null };

/**
 * Drops what an earlier build saved for a Mac's cloud brain, which no Mac has any more: the brain's own entry, with
 * this phone's keys for it (`forget`), and the brain each Mac's record named. A phone that showed a brain last shows
 * the Mac that named it, else its first Mac. Run at every start; with nothing left to drop it changes nothing.
 */
export function dropSavedBrains(store: MacStore, forget: (id: string) => void): void {
  const saved = store.list() as EarlierHost[];
  const brains = saved.filter((host) => host.kind === "brain");
  const macs = saved.filter((host) => host.kind !== "brain");
  const shown = brains.find((brain) => brain.id === store.activeId());
  if (shown) store.setActiveId((macs.find((mac) => mac.brain === shown.id) ?? macs[0])?.id ?? null);
  for (const brain of brains) {
    store.remove(brain.id);
    forget(brain.id);
  }
  for (const mac of macs)
    if ("kind" in mac || "brain" in mac) {
      const { kind: _kind, brain: _brain, ...plain } = mac;
      store.save(plain);
    }
}
