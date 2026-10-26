import { useEffect, useState } from "react";
import type { DevicePlatform } from "@openorc/protocol";
import { AndroidTransport } from "./android-transport";
import { deviceChannels } from "./channels";
import type { ScreenGeometry } from "./input";
import { IosTransport } from "./ios-transport";
import { canvasSink, type DeviceTransport, type StreamEvents, type StreamStatus } from "./stream";

export type StreamView = { status: StreamStatus; screen: ScreenGeometry | null; input: boolean };

const IDLE: StreamView = { status: { kind: "connecting" }, screen: null, input: false };

/**
 * Streams a device into the canvas while `deviceId` is set, and stops when it clears or the view unmounts, so only the
 * tab on screen streams.
 */
export function useDeviceStream(platform: DevicePlatform, deviceId: string | null, canvas: HTMLCanvasElement | null): { view: StreamView; transport: DeviceTransport | null } {
  const [view, setView] = useState<StreamView>(IDLE);
  const [transport, setTransport] = useState<DeviceTransport | null>(null);
  useEffect(() => {
    if (!deviceId || !canvas) return;
    const events: StreamEvents = {
      status: (status) => setView((current) => ({ ...current, status })),
      screen: (screen) => setView((current) => ({ ...current, screen })),
      input: (input) => setView((current) => (current.input === input ? current : { ...current, input })),
    };
    const sink = canvasSink(canvas);
    const stream = platform === "ios" ? new IosTransport(deviceChannels, deviceId, sink, events) : new AndroidTransport(deviceChannels, deviceId, sink, events);
    setTransport(stream);
    stream.start();
    return () => {
      stream.stop();
      setTransport(null);
      // The next session starts from nothing rather than showing this one's last state for a render.
      setView(IDLE);
    };
  }, [platform, deviceId, canvas]);
  return { view, transport };
}
