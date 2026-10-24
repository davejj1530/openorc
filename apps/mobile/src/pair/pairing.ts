import { AccessibilityInfo } from "react-native";
import { create } from "zustand";
import { link } from "../client";
import { haptic } from "../ui/haptics";

/** `spent` when the failed code can never pair; otherwise Try again sends `code` once more. */
export type Pairing = { kind: "idle" } | { kind: "pairing" } | { kind: "failed"; message: string; code: string; spent: boolean };

/** The one pairing in progress, shared by the scanner, the paste button and links the system camera opens. */
export const usePairing = create<{ pairing: Pairing }>(() => ({ pairing: { kind: "idle" } }));

/**
 * Codes that can never pair again (one paired, the Mac refused one, it expired, it is not a code), so seeing one again
 * does nothing. The link the system camera opened the app with stays its opening link, offered again on every visit.
 */
const spent = new Set<string>();
/**
 * Codes the camera read since the Pair screen opened. It reads the code in view many times a second, so each is tried
 * once; after a failure, Try again sends it again.
 */
const scanned = new Set<string>();

export const isPairingUrl = (text: string) => text.trim().startsWith("openorc://pair#");

function set(pairing: Pairing, said: string | null): void {
  usePairing.setState({ pairing });
  if (said) AccessibilityInfo.announceForAccessibility(said);
}

async function pairWith(code: string): Promise<boolean> {
  if (usePairing.getState().pairing.kind === "pairing") return false;
  set({ kind: "pairing" }, "Pairing…");
  const result = await link.pair(code);
  if (result.ok || result.spent) spent.add(code);
  if (result.ok) {
    haptic.confirm();
    set({ kind: "idle" }, `Paired with ${result.mac.name}`);
    return true;
  }
  haptic.fail();
  set({ kind: "failed", message: result.message, code, spent: result.spent }, result.message);
  return false;
}

/** A code the person pasted or the system camera opened the app with. Resolves true once paired. */
export function offerCode(text: string): Promise<boolean> {
  const code = text.trim();
  if (!isPairingUrl(code) || spent.has(code)) return Promise.resolve(false);
  if (usePairing.getState().pairing.kind === "pairing") return Promise.resolve(false);
  haptic.select();
  return pairWith(code);
}

/** A code the camera read: tried the first time only, while the Pair screen stays open. Resolves true once paired. */
export function scanCode(text: string): Promise<boolean> {
  const code = text.trim();
  if (scanned.has(code) || usePairing.getState().pairing.kind === "pairing") return Promise.resolve(false);
  if (isPairingUrl(code)) scanned.add(code);
  return offerCode(code);
}

/** The Pair screen opened: no failure left from an earlier visit, and the camera may try every code once more. */
export function openPairing(): void {
  scanned.clear();
  if (usePairing.getState().pairing.kind === "failed") usePairing.setState({ pairing: { kind: "idle" } });
}

/** Try again: the code that last failed to reach the Mac. */
export function retryPairing(): Promise<boolean> {
  const pairing = usePairing.getState().pairing;
  return pairing.kind === "failed" && !pairing.spent ? pairWith(pairing.code) : Promise.resolve(false);
}
