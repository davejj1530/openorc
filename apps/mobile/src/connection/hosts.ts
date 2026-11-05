import type { PhoneDoors } from "./door";
import type { MacStore, SavedMac } from "./saved-macs";

/**
 * The hosts Home shows together: the one shown, and the host it pairs with, a Mac and the cloud brain it named. Without
 * one, Home is the shown host's alone, as before.
 */
export interface HostGroup {
  primary: SavedMac | null;
  partner: SavedMac | null;
}

/** Pure, from the saved hosts, so Home paints the group before anything connects. */
export function groupOf(saved: readonly SavedMac[], activeId: string | null): HostGroup {
  const primary = saved.find((host) => host.id === activeId) ?? null;
  if (!primary) return { primary: null, partner: null };
  const partner = primary.kind === "brain" ? saved.find((host) => host.brain === primary.id) : saved.find((host) => host.id === primary.brain);
  return { primary, partner: partner && partner.id !== primary.id ? partner : null };
}

/**
 * The saved hosts as the partner's link sees them: only the partner, which it shows; routes it learns are saved, but it
 * never chooses another host or forgets one. Pairing and Forget stay with the shown host's link.
 */
export function partnerStore(store: MacStore, partner: () => string | null): MacStore {
  let active: string | null = null;
  const current = () => store.list().filter((host) => host.id === partner());
  return {
    list: current,
    activeId: () => (active && current().some((host) => host.id === active) ? active : null),
    setActiveId: (id) => {
      active = id;
    },
    save: (host) => store.save(host),
    remove: () => undefined,
  };
}

/**
 * The partner's doors: it may wake a host asleep behind its proxy only while the person has one of that host's screens
 * open. Home listing the partner's threads is not a reason to wake it.
 */
export function doorsOnIntent(doors: PhoneDoors, opened: () => boolean): PhoneDoors {
  return { ...doors, has: async (macId) => opened() && (await doors.has(macId)) };
}

/**
 * What a link does with the brains a host says it removed: `forget` (the shown host's link's) each saved brain among
 * them, unless another saved Mac still names it as its own, so one Mac never makes the phone forget another's brain.
 */
export function forgetRemovedBrains(store: MacStore, forget: (id: string) => void): (macId: string, removed: readonly string[]) => void {
  return (macId, removed) => {
    const saved = store.list();
    const namedElsewhere = (id: string) => saved.some((host) => host.id !== macId && host.brain === id);
    for (const host of saved) if (host.kind === "brain" && removed.includes(host.id) && !namedElsewhere(host.id)) forget(host.id);
  };
}

/** The Mac's word about its brain, kept on the Mac's record so a cold start regroups at once. */
export function namedBrain(store: MacStore, macId: string, brain: string | null): boolean {
  const mac = store.list().find((host) => host.id === macId);
  if (!mac || mac.kind === "brain" || (mac.brain ?? null) === brain) return false;
  store.save({ ...mac, brain });
  return true;
}

/**
 * The Mac that moves a thread on `host` (null: the shown one) between itself and its cloud brain, and whether the
 * thread is on the brain now. Null unless the group holds both a Mac and its brain.
 */
export function moverOf(saved: readonly SavedMac[], group: { primary: string | null; partner: string | null }, host: string | null): { mac: string; onBrain: boolean } | null {
  const here = host ?? group.primary;
  const other = here === group.primary ? group.partner : group.primary;
  if (!here || !other) return null;
  const kindOf = (id: string) => saved.find((each) => each.id === id)?.kind ?? "mac";
  if (kindOf(here) === kindOf(other)) return null;
  return kindOf(here) === "brain" ? { mac: other, onBrain: true } : { mac: here, onBrain: false };
}

/** The saved hosts, the partner's record as its own link last saved it: it learns its name and routes there. */
export function withPartnerRecord(shown: readonly SavedMac[], partner: readonly SavedMac[]): readonly SavedMac[] {
  if (!partner.length) return shown;
  return shown.map((host) => partner.find((each) => each.id === host.id) ?? host);
}
