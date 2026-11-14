import { useEffect, useSyncExternalStore } from "react";
import type { CoreConnection } from "@openorc/client";
import { OrganizationAccessStore, organizationContentState } from "./organization-access-store";
import { core } from "./rpc";

/** One window's account-wide gate; all feature caches share its generation and deadline. */
export const organizationContentGate = new OrganizationAccessStore({ now: () => Date.now(), read: () => core.call("spaces.refresh", {}) });

interface Source {
  onPush: CoreConnection["onPush"];
  onFocus(listener: () => void): () => void;
}

export function organizationGateConnection(store: OrganizationAccessStore, source: Source): () => () => void {
  let users = 0;
  let disconnect = () => {};
  let queued = false;
  const refresh = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      if (users) void store.refresh();
    });
  };
  return () => {
    if (++users === 1) {
      const pushes = source.onPush((push) => {
        if (push.type === "session") {
          store.reset();
          refresh();
        }
        if (push.type === "invalidate" && push.keys.some((key) => key === "account" || key === "spaces" || key.startsWith("people:"))) refresh();
      });
      const focus = source.onFocus(refresh);
      disconnect = () => {
        pushes();
        focus();
        store.suspend();
      };
      refresh();
    }
    let released = false;
    return () => {
      if (!released && --users === 0) disconnect();
      released = true;
    };
  };
}

export const startOrganizationContentGate = organizationGateConnection(organizationContentGate, {
  onPush: (listener) => core.onPush(listener),
  onFocus: (listener) => {
    window.addEventListener("focus", listener);
    window.addEventListener("online", listener);
    return () => {
      window.removeEventListener("focus", listener);
      window.removeEventListener("online", listener);
    };
  },
});

/** Rendering and asynchronous consumers use the same authority; project permission remains an additional check. */
export function useOrganizationContentGate(spaceId: string | null) {
  useEffect(startOrganizationContentGate, []);
  const snapshot = useSyncExternalStore(organizationContentGate.subscribe, organizationContentGate.getSnapshot);
  return organizationContentState(snapshot, spaceId);
}
