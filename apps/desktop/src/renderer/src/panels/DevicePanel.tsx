import type { Device } from "@openorc/protocol";
import { DeviceLoadError } from "../components/device/DeviceLoadError";
import { DevicePicker } from "../components/device/DevicePicker";
import { DeviceScreen } from "../components/device/DeviceScreen";
import { DeviceSetup } from "../components/device/DeviceSetup";
import { bootDevice } from "../lib/device/operations";
import { helpersBusy } from "../lib/device/setup";
import { usePanelSessions, type DevicePage } from "../lib/panel-tabs";
import { useRpc } from "../lib/client";

/**
 * A Device tab. With support off it shows setup, which installs and starts nothing until asked. With support on, a
 * tab without a device is the picker and a tab with one is that device's screen. Mounted only while its tab is on
 * screen, so only that tab streams.
 */
export function DevicePanel({ scope, tabId, page }: { scope: string; tabId: string; page: DevicePage }) {
  const status = useRpc("devices.status", {}, { refetchInterval: (query) => (helpersBusy(query.state.data?.helpers) ? 1_000 : false) });
  if (status.isError) return <DeviceLoadError message="Could not read device support." retry={() => void status.refetch()} />;
  if (!status.data) return null;
  if (!status.data.settings.enabled) return <DeviceSetup status={status.data} />;
  if (page.deviceId === null) {
    const open = (device: Device) => {
      if (device.state === "shutdown") void bootDevice(device.id);
      usePanelSessions.getState().pickDevice(scope, tabId, { kind: "device", deviceId: device.id, name: device.name });
    };
    return <DevicePicker status={status.data} onOpen={open} />;
  }
  return <DeviceScreen key={page.deviceId} deviceId={page.deviceId} name={page.name} status={status.data} />;
}
