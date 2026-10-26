import { create } from "zustand";
import { queryClient } from "../client";
import { core } from "../rpc";

/** A start or shutdown the user asked for, kept outside any tab so it survives switching tabs while it runs. */
export type DeviceOperation = { kind: "booting" } | { kind: "stopping" } | { kind: "failed"; action: "start" | "shut down"; error: string };

export const useDeviceOperations = create<{ operations: Record<string, DeviceOperation> }>(() => ({ operations: {} }));

function set(deviceId: string, operation: DeviceOperation | null): void {
  useDeviceOperations.setState(({ operations }) => {
    const { [deviceId]: _previous, ...rest } = operations;
    return { operations: operation ? { ...rest, [deviceId]: operation } : rest };
  });
}

const refreshList = () => queryClient.invalidateQueries({ queryKey: ["devices.list"] });

async function run(deviceId: string, running: DeviceOperation, action: "start" | "shut down", call: () => Promise<unknown>): Promise<void> {
  const current = useDeviceOperations.getState().operations[deviceId];
  if (current?.kind === "booting" || current?.kind === "stopping") return;
  set(deviceId, running);
  try {
    await call();
    // The operation stands in for the device's state until the list has caught up, so the screen never shows the old one.
    await refreshList();
    set(deviceId, null);
  } catch (error) {
    set(deviceId, { kind: "failed", action, error: error instanceof Error ? error.message : String(error) });
    void refreshList();
  }
}

/** Boots a device and attaches its stream. Resolves once the core is done, whatever the outcome. */
export const bootDevice = (deviceId: string): Promise<void> => run(deviceId, { kind: "booting" }, "start", () => core.call("devices.boot", { deviceId }));

export const shutdownDevice = (deviceId: string): Promise<void> => run(deviceId, { kind: "stopping" }, "shut down", () => core.call("devices.shutdown", { deviceId }));
