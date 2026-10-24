import { linkHooks } from "../connection/link-hooks";

/** The phone's link as screens see it, its hooks included: which session it has with the Mac, if any. */
export function fakeLink() {
  let serial: number | null = 1;
  const listeners = new Set<() => void>();
  const mac = { id: "mac", name: "Studio" };
  const route = { kind: "lan", host: "studio.local", port: 47820 } as const;
  const hooks = linkHooks({
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    getState: () => (serial === null ? { kind: "waiting", mac, why: "unreachable", retryAt: null } : { kind: "connected", mac, route, serial }),
  });
  return {
    ...hooks,
    /** Moves the link to session `next`, or down when it is null. */
    to(next: number | null) {
      serial = next;
      listeners.forEach((listener) => listener());
    },
  };
}

export type FakeLink = ReturnType<typeof fakeLink>;
