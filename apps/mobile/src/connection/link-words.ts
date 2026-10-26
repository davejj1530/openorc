import type { DownReason, LinkRoute, LinkState, LostMac } from "./manager";

/** The connection dot: connected, on its way, held up by something the person may want to know, or not trying. */
export type LinkTone = "ok" | "busy" | "attention" | "off";

export interface LinkWords {
  tone: LinkTone;
  /** A few words after the Mac's name: how it is reached, or what is in the way. Null when the name says enough. */
  status: string | null;
  /** The dot's spoken label. */
  spoken: string;
  /** What Settings says under the Mac's name: what is wrong and what helps, as far as the phone can tell. */
  detail: string;
}

const routeNames: Record<Exclude<LinkRoute["kind"], "demo">, string> = { lan: "Wi-Fi", tailnet: "Tailscale" };

/** The demo Mac lives in the app: its name says what it is, and Settings says where. */
const demoWords: LinkWords = { tone: "ok", status: null, spoken: "On this iPhone", detail: "On this iPhone" };

const down: Record<DownReason, LinkWords> = {
  restarting: { tone: "attention", status: "Restarting", spoken: "Restarting OpenOrc", detail: "OpenOrc is restarting on this Mac." },
  disabled: { tone: "attention", status: "Phone access is off", spoken: "Phone access is off", detail: "Turn on Allow paired phones in OpenOrc’s Phone settings on this Mac." },
  busy: { tone: "attention", status: "Too many phones", spoken: "Too many phones", detail: "This Mac has too many phones connected. This iPhone tries again in a moment." },
  // The phone can tell nothing more, so Settings says no more than Home.
  offline: { tone: "off", status: "No internet", spoken: "No internet", detail: "No internet" },
  "no-route": {
    tone: "attention",
    status: "Not on its network",
    spoken: "Not on its network",
    detail: "This iPhone reaches this Mac on the same Wi-Fi, or anywhere when both run Tailscale.",
  },
  unreachable: { tone: "busy", status: "Reconnecting", spoken: "Reconnecting", detail: "This Mac isn’t answering. It may be asleep or on another network." },
  silent: { tone: "off", status: "Not reachable", spoken: "Not reachable", detail: "This Mac isn’t answering. It may be asleep or on another network." },
  tailnet: { tone: "attention", status: "Check Tailscale", spoken: "Not reachable over Tailscale", detail: "Tailscale is off on this iPhone, or another VPN is on." },
};

export function linkWords(state: LinkState): LinkWords {
  switch (state.kind) {
    case "unpaired":
      return { tone: "off", status: null, spoken: "Not paired", detail: "Not paired" };
    case "connected": {
      if (state.route.kind === "demo") return demoWords;
      const via = routeNames[state.route.kind];
      return { tone: "ok", status: via, spoken: `Connected over ${via}`, detail: `Connected over ${via}` };
    }
    case "connecting":
      return state.why ? down[state.why] : { tone: "busy", status: "Connecting", spoken: "Connecting", detail: "Connecting" };
    case "waiting":
      return down[state.why];
    case "suspended":
      return { tone: "off", status: null, spoken: "Not connected", detail: "Not connected" };
    case "incompatible":
      return { tone: "attention", status: "Needs an update", spoken: "Needs an update", detail: "Update OpenOrc on this iPhone and on this Mac." };
  }
}

/** Why the last Mac went, when the person did not forget it. */
export const lostWords: Record<LostMac["why"], (name: string) => string> = {
  removed: (name) => `${name} removed this iPhone`,
  "key-lost": (name) => `This iPhone lost its key for ${name}`,
};
