import type { Device, DevicePlatformSupport } from "@openorc/protocol";
import type { DeviceOperation } from "./operations";
import type { StreamStatus } from "./stream";

/** What a device tab shows. Streaming and reconnecting draw the screen; the others draw their state over it. */
export type ScreenPhase =
  { kind: "shutdown" } | { kind: "starting"; detail?: string } | { kind: "stopping" } | { kind: "streaming" } | { kind: "reconnecting" } | { kind: "unavailable"; reason: string };

export type ScreenFacts = {
  /** Undefined once the list no longer has the device. */
  device: Device | undefined;
  operation: DeviceOperation | undefined;
  /** The device's platform as this Mac supports it. */
  support: DevicePlatformSupport | undefined;
  stream: StreamStatus;
};

/** Whether the screen should be streaming now: a booted device with nothing in flight and video this Mac can serve. */
export function streamable({ device, operation, support }: Omit<ScreenFacts, "stream">): boolean {
  if (device?.state !== "booted" || operation?.kind === "booting" || operation?.kind === "stopping") return false;
  return support?.video?.available !== false;
}

function fromStream(stream: StreamStatus): ScreenPhase {
  switch (stream.kind) {
    case "connecting":
      return { kind: "starting", detail: stream.detail };
    case "streaming":
      return { kind: "streaming" };
    case "reconnecting":
      return { kind: "reconnecting" };
    case "failed":
      return { kind: "unavailable", reason: stream.reason };
  }
}

const fromDevice: Record<Exclude<Device["state"], "booted">, ScreenPhase> = {
  shutdown: { kind: "shutdown" },
  booting: { kind: "starting" },
  "shutting-down": { kind: "stopping" },
};

export function screenPhase(facts: ScreenFacts): ScreenPhase {
  const { device, operation, support, stream } = facts;
  if (operation?.kind === "booting") return { kind: "starting" };
  if (operation?.kind === "stopping") return { kind: "stopping" };
  if (!device) return { kind: "unavailable", reason: support?.available === false && support.reason ? support.reason : "This device is no longer on this Mac." };
  if (device.state !== "booted") return fromDevice[device.state];
  if (support?.video?.available === false) return { kind: "unavailable", reason: support.video.reason ?? "Video is unavailable for this device." };
  return fromStream(stream);
}
