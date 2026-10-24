import type { DownReason, LinkState } from "./manager";

/** The connection dot: connected, on its way, held up by something the person may want to know, or not trying. */
export type LinkTone = "ok" | "busy" | "attention" | "off";

export interface LinkWords {
  tone: LinkTone;
  /** A few words beside the Mac's name, and the dot's spoken label. */
  status: string;
  /** The quiet line under Home's title while the phone is not connected. */
  line: string | null;
}

function down(why: DownReason, name: string): LinkWords {
  switch (why) {
    case "restarting":
      return { tone: "attention", status: "Restarting OpenOrc", line: "Your Mac is restarting OpenOrc" };
    case "disabled":
      return { tone: "attention", status: "Phone access is off", line: `Phone access is off on ${name}` };
    case "busy":
      return { tone: "attention", status: "Too many phones", line: `${name} has too many phones connected` };
    case "offline":
      return { tone: "off", status: "No network", line: "No network" };
    case "unreachable":
      return { tone: "busy", status: "Reconnecting", line: `Reconnecting to ${name}` };
  }
}

export function linkWords(state: LinkState): LinkWords {
  switch (state.kind) {
    case "unpaired":
      return { tone: "off", status: "Not paired", line: null };
    case "connected":
      return { tone: "ok", status: "Connected", line: null };
    case "connecting":
      return state.why ? down(state.why, state.mac.name) : { tone: "busy", status: "Connecting", line: `Connecting to ${state.mac.name}` };
    case "waiting":
      return down(state.why, state.mac.name);
    case "suspended":
      return { tone: "off", status: "Not connected", line: null };
    case "incompatible":
      return { tone: "attention", status: "Needs an update", line: "Update OpenOrc on this phone and on your Mac" };
  }
}
