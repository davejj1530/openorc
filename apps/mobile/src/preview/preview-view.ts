import { pageHost, pageLabel, publicAddress } from "@openorc/client";
import type { PreviewState } from "@openorc/protocol";

/** What the Preview screen's body shows. `page` is a frame on screen, still while the next page loads. */
export type PreviewView =
  | { kind: "opening" }
  | { kind: "closed" }
  | { kind: "refused"; message: string }
  | { kind: "loading"; host: string }
  | { kind: "failed"; message: string }
  | { kind: "stopped" }
  | { kind: "page"; navigating: boolean; dim: boolean };

interface ViewInput {
  /** The Mac's newest word on the page: the watch's answer, then its pushes. */
  state: PreviewState | undefined;
  /** Why the Mac refused the watch, if it did. */
  refused: string | null;
  /** A frame is on screen. */
  shown: boolean;
  connected: boolean;
  /** The app is in front. Away, the screen holds no frame, so the App Switcher shows the ground. */
  active: boolean;
}

/** The screen's body for what the Mac said and what the phone holds. */
export function previewView({ state, refused, shown, connected, active }: ViewInput): PreviewView {
  if (refused !== null) return { kind: "refused", message: refused };
  if (!active || state === undefined) return { kind: "opening" };
  if (!state.open) return { kind: "closed" };
  if (state.phase === "failed") return { kind: "failed", message: state.error ?? "" };
  if (state.phase === "stopped") return { kind: "stopped" };
  if (shown) return { kind: "page", navigating: state.phase === "loading", dim: !connected };
  return state.phase === "loading" ? { kind: "loading", host: pageHost(state.address) } : { kind: "opening" };
}

const label = (state: PreviewState | undefined) => (state?.open ? pageLabel({ url: state.address, title: state.title }) : null);
const host = (state: PreviewState | undefined) => (state?.open ? pageHost(state.address) : null);

/** The faint line under the screen's title. `read` is the thread screen's read, which names the page while it opens. */
export function previewLine(view: PreviewView, state: PreviewState | undefined, read: PreviewState | undefined): string | null {
  switch (view.kind) {
    case "opening":
      return label(state ?? read);
    case "closed":
    case "refused":
      return null;
    case "loading":
      return view.host;
    case "failed":
    case "stopped":
      return host(state);
    case "page":
      return view.navigating ? `Loading ${host(state)}…` : label(state);
  }
}

/** What an older Mac answers for a method it does not have. */
const NOT_AVAILABLE = "This is not available from a phone.";

/** A refused watch in the phone's words: the Mac's own, or, from a Mac without Preview, what would bring it. */
export function refusalWords(message: string, mac: string): string {
  return message === NOT_AVAILABLE ? `Update OpenOrc on ${mac} to see its Preview.` : message;
}

/**
 * The address Open in Safari takes, or null: only a public one the Mac's shaping left whole. A local address on the
 * phone is the phone, and a redacted one would not load the page the Mac shows.
 */
export function safariAddress(state: PreviewState | undefined): string | null {
  if (!state?.open || state.address.includes("[redacted:")) return null;
  return publicAddress(state.address) ? state.address : null;
}
