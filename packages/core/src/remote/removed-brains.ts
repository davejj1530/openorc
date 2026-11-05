import { settings, type Db } from "@openorc/db";

const REMOVED = "brain.removed";
/** More than anyone sets up and removes; the oldest goes first. */
const KEPT = 8;

/** The cloud brains this Mac removed, by the link keys phones saved them under, newest first. */
export function removedBrains(db: Db): string[] {
  return JSON.parse(settings.get(db, REMOVED) ?? "[]") as string[];
}

export function rememberRemovedBrain(db: Db, linkKey: string): void {
  settings.set(db, REMOVED, JSON.stringify([linkKey, ...removedBrains(db).filter((key) => key !== linkKey)].slice(0, KEPT)));
}
