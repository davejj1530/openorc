import type { DeviceService } from "../devices/service.js";
import type { Handlers } from "./types.js";

type DeviceMethod = "devices.status" | "devices.setup" | "devices.settings.set" | "devices.list" | "devices.boot" | "devices.shutdown";

export function createDeviceHandlers({ devices }: { devices: DeviceService }): Pick<Handlers, DeviceMethod> {
  return {
    "devices.status": () => devices.status(),
    "devices.setup": (params) => devices.setup(params),
    "devices.settings.set": (patch) => devices.setSettings(patch),
    "devices.list": () => devices.list(),
    "devices.boot": ({ deviceId }) => devices.boot(deviceId),
    "devices.shutdown": ({ deviceId }) => devices.shutdown(deviceId),
  };
}
