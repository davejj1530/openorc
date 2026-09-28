import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { AppSettings, PermissionPreset } from "@openorc/protocol";
import { core } from "./rpc";
import { queryClient, useRpc } from "./query";

// Share optimistic selections between mounted composers. Serialize writes so a
// slower response cannot replace a newer choice; the core broadcasts to other windows.
let pending: PermissionPreset | null = null;
let revision = 0;
let saving: Promise<void> = Promise.resolve();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const snapshot = () => pending;
const announce = () => listeners.forEach((listener) => listener());

export function saveDefaultPermission(permission: PermissionPreset): Promise<void> {
  const selection = ++revision;
  pending = permission;
  announce();
  const result = saving
    .catch(() => {})
    .then(async () => {
      await queryClient.cancelQueries({ queryKey: ["app.settings.get", {}] });
      const settings = await core.call("app.settings.set", { defaultPermissionMode: permission });
      if (selection === revision) queryClient.setQueryData<AppSettings>(["app.settings.get", {}], settings);
    });
  saving = result;
  void result
    .finally(() => {
      if (selection === revision) {
        pending = null;
        announce();
      }
    })
    .catch(() => {});
  return result;
}

export function useDefaultPermission(): PermissionPreset | null {
  const settings = useRpc("app.settings.get", {});
  const selection = useSyncExternalStore(subscribe, snapshot);
  return selection ?? settings.data?.defaultPermissionMode ?? null;
}

/** Existing work keeps its saved policy; fresh composers follow the shared default. */
export function usePermissionSelection(saved?: PermissionPreset) {
  const defaultPermission = useDefaultPermission();
  const [selection, setSelection] = useState<PermissionPreset | null>(null);
  const lastSaved = useRef(saved);
  useEffect(() => {
    if (saved !== lastSaved.current) {
      lastSaved.current = saved;
      setSelection(null);
    }
  }, [saved]);
  const [error, setError] = useState<string | null>(null);
  return {
    permission: selection ?? saved ?? defaultPermission ?? "trusted",
    ready: (selection ?? saved ?? defaultPermission) != null,
    error,
    select(permission: PermissionPreset) {
      if (saved !== undefined) setSelection(permission);
      setError(null);
      void saveDefaultPermission(permission).catch(() => setError("Could not save the default permission. Select it again to retry."));
    },
  };
}
