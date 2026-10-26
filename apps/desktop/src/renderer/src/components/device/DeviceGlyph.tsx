import type { Device, DevicePlatform } from "@openorc/protocol";
import { Smartphone, Tablet } from "../icons";

export const platformName: Record<DevicePlatform, string> = { ios: "iOS", android: "Android" };

export function DeviceGlyph({ formFactor, size = 15 }: { formFactor: Device["formFactor"]; size?: number }) {
  const Icon = formFactor === "tablet" ? Tablet : Smartphone;
  return <Icon size={size} />;
}
