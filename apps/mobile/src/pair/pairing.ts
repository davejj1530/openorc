import { create } from "zustand";
import { link } from "../client";

export type Pairing = { kind: "idle" } | { kind: "pairing" } | { kind: "failed"; message: string };

/** The one pairing in progress, shared by the scanner, the paste field and links the system camera opens. */
export const usePairing = create<{ pairing: Pairing }>(() => ({ pairing: { kind: "idle" } }));

export const isPairingUrl = (text: string) => text.trim().startsWith("openorc://pair#");

/** Spends a pairing code. Resolves true once the Mac is saved and connected. */
export async function pairWith(url: string): Promise<boolean> {
  if (usePairing.getState().pairing.kind === "pairing") return false;
  usePairing.setState({ pairing: { kind: "pairing" } });
  const result = await link.pair(url);
  usePairing.setState({ pairing: result.ok ? { kind: "idle" } : { kind: "failed", message: result.message } });
  return result.ok;
}
