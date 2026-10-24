import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { AppSettings, PermissionPreset } from "@openorc/protocol";
import type { CoreConnection } from "./connection.js";
import type { ClientQueries } from "./query.js";

/**
 * The permission new work starts with. Choices save one after another, so a slower answer never replaces a newer
 * choice, and composers mounted together share the choice before it lands; the core tells other clients. A client
 * that may not change app settings keeps each choice on the work it was made for.
 */
export function createPermissionDefault(connection: CoreConnection, queries: ClientQueries, savesDefault: boolean) {
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

  function saveDefaultPermission(permission: PermissionPreset): Promise<void> {
    const selection = ++revision;
    pending = permission;
    announce();
    const result = saving
      .catch(() => {})
      .then(async () => {
        await queries.queryClient.cancelQueries({ queryKey: ["app.settings.get", {}] });
        const settings = await connection.call("app.settings.set", { defaultPermissionMode: permission });
        if (selection === revision) queries.queryClient.setQueryData<AppSettings>(["app.settings.get", {}], settings);
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

  function useDefaultPermission(): PermissionPreset | null {
    const settings = queries.useRpc("app.settings.get", {});
    const selection = useSyncExternalStore(subscribe, snapshot);
    return selection ?? settings.data?.defaultPermissionMode ?? null;
  }

  /** Existing work keeps its saved policy; fresh composers follow the shared default. */
  function usePermissionSelection(saved?: PermissionPreset) {
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
        if (saved !== undefined || !savesDefault) setSelection(permission);
        setError(null);
        if (!savesDefault) return;
        void saveDefaultPermission(permission).catch(() => setError("Could not save the default permission. Select it again to retry."));
      },
    };
  }

  return { saveDefaultPermission, useDefaultPermission, usePermissionSelection };
}

export type PermissionDefault = ReturnType<typeof createPermissionDefault>;
