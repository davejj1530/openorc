import type { ThemePreset } from "@openorc/client/theme";
import { useSyncExternalStore } from "react";
import { useLinkState, useRpc } from "../client";
import { currentLook, subscribeLook } from "./look";

/**
 * Keeps the shown Mac's look on the phone: mounted once at the root, it holds the Mac's settings read open, so a change
 * on the Mac (its "settings" push) reads them again and `followMacLook` repaints. Returns the palette on screen.
 */
export function useMacLook(): ThemePreset {
  useRpc("app.settings.get", {}, { enabled: useLinkState().kind !== "unpaired" });
  return useSyncExternalStore(subscribeLook, currentLook).preset;
}
