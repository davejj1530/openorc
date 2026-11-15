import type { MacStore, SavedMac } from "./saved-macs";

/*
 * An earlier build paired a Mac's cloud brain as a second host and saved it beside the Mac. This build shows Macs only.
 * A brain saved then stays out of sight and is never dialled, and it goes, with this phone's keys for it, once a Mac
 * says it removed it.
 */

const isBrain = (host: SavedMac) => host.kind === "brain";

/**
 * The saved hosts as the link sees them: the Macs. A phone that showed a brain last shows the Mac that named it instead,
 * or its first Mac. A host is still removed by its id, a hidden brain included.
 */
export function macsOnly(store: MacStore): MacStore {
  const list = () => store.list().filter((host) => !isBrain(host));
  const shown = store.list().find((host) => host.id === store.activeId());
  if (shown && isBrain(shown)) store.setActiveId((list().find((mac) => mac.brain === shown.id) ?? list()[0])?.id ?? null);
  return { ...store, list };
}

/**
 * What the link does with the brains a Mac says it removed: `forget` each saved brain among them, unless another saved
 * Mac still names it as its own, so one Mac never makes the phone forget another's brain.
 */
export function forgetRemovedBrains(store: MacStore, forget: (id: string) => void): (macId: string, removed: readonly string[]) => void {
  return (macId, removed) => {
    const saved = store.list();
    const namedElsewhere = (id: string) => saved.some((host) => host.id !== macId && host.brain === id);
    for (const host of saved) if (isBrain(host) && removed.includes(host.id) && !namedElsewhere(host.id)) forget(host.id);
  };
}

/** The Mac's word about its brain, kept on the Mac's record: whose brain a saved one is. */
export function namedBrain(store: MacStore, macId: string, brain: string | null): boolean {
  const mac = store.list().find((host) => host.id === macId);
  if (!mac || isBrain(mac) || (mac.brain ?? null) === brain) return false;
  store.save({ ...mac, brain });
  return true;
}
