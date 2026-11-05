import type { ThreadOwner } from "@openorc/protocol";

/** Why a row of a Mac the phone cannot reach does nothing, said when the person presses it. */
export const MAC_ASLEEP = "This conversation is on your Mac, which is asleep.";

/** Whether a row or heading Home merged in belongs to a Mac this phone cannot reach now: shown from its last list, read-only. */
export const macAsleep = (owner: ThreadOwner | null | undefined): boolean => owner?.brain === "mac" && owner.reach !== "live";

/** Where New thread opens: on the cloud brain while the shown Mac cannot be reached (`shownAway`), else on the shown host. */
export function newThreadRoute(shownAway: ThreadOwner | null, partner: string | null) {
  return macAsleep(shownAway) && partner !== null ? { pathname: "/new" as const, params: { host: partner } } : ("/new" as const);
}
