import type { HostedDeps } from "../index.js";
import type { StandIn } from "../testing/stand-in.js";

/** One device's storage, kept across the hosts a test makes on it, as protected storage and the settings table outlive a launch. */
export interface Device {
  stored: string | null;
  kept: string | null;
}

/** What a host did that a test reads: every log line, push and socket it opened, and every write in order. */
export interface Seen {
  logs: string[];
  pushes: unknown[];
  timeline: string[];
  sockets: { closed: boolean }[];
}

export const newDevice = (): Device => ({ stored: null, kept: null });

/** The deps a host hands the package, on this device, against the stand-in over real HTTP. */
export function hostDeps(stand: StandIn, device: Device, overrides: Partial<HostedDeps> = {}): { deps: HostedDeps; seen: Seen } {
  const seen: Seen = { logs: [], pushes: [], timeline: [], sockets: [] };
  const deps: HostedDeps = {
    server: stand.url,
    session: {
      load: async () => device.stored,
      save: async (value) => {
        seen.timeline.push(value === null ? "session forgotten" : "session saved");
        device.stored = value;
      },
    },
    kept: {
      load: () => device.kept,
      save: (json) => {
        seen.timeline.push(json === null ? "kept forgotten" : "kept saved");
        device.kept = json;
      },
    },
    fetch: async (input, init) => {
      seen.timeline.push(`request ${new URL(String(input)).pathname}`);
      return fetch(input, init);
    },
    connect: (url, token) => {
      const socket = stand.connect(url, token);
      const record = { closed: false };
      seen.sockets.push(record);
      return {
        onState: (listener) => socket.onState(listener),
        close: () => {
          record.closed = true;
          socket.close();
        },
      };
    },
    push: (push) => void seen.pushes.push(push),
    now: Date.now,
    log: { info: (line) => void seen.logs.push(line), warn: (line) => void seen.logs.push(line) },
    ...overrides,
  };
  return { deps, seen };
}

/** The token a device holds, read the way only a test may. */
export function storedToken(device: Device): string {
  return (JSON.parse(device.stored ?? "{}") as { token: string }).token;
}
