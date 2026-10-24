import { lookOf, sameLook } from "@openorc/client/theme";
import { useEffect } from "react";
import { useRpc, useRpcMutation } from "./client";
import { useTheme } from "./theme";

/*
 * Phones follow the palette and colors this Mac paints with. The renderer keeps painting from its own storage, read
 * before the first frame, and app settings carry a copy to every client. Only this Mac's windows write it, so the copy
 * follows what is on screen: handed over once when the core holds none, then saved after each change.
 */

/** A color picker writes on every step of a drag; a phone needs only where it stops. */
const SAVE_AFTER_MS = 400;

/** For App: keeps the core's look the one on screen. */
export function useLookHandover(): void {
  const saved = useRpc("app.settings.get", {}).data?.look;
  const { mutate: save } = useRpcMutation("app.settings.set");
  const preset = useTheme((state) => state.preset);
  const custom = useTheme((state) => state.custom);
  useEffect(() => {
    if (saved === undefined) return;
    const look = lookOf(preset, custom);
    if (sameLook(saved, look)) return;
    const timer = setTimeout(() => save({ look }), SAVE_AFTER_MS);
    return () => clearTimeout(timer);
  }, [saved, preset, custom, save]);
}
