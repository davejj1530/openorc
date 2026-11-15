import { settings, type Db } from "@openorc/db";

/**
 * The cloud brains this Mac removed while it had a cloud of the person's own, by the link keys phones saved them under,
 * newest first. Nothing adds to the list any more; a phone that paired one of them still asks for it, to forget it.
 */
export function removedBrains(db: Db): string[] {
  return JSON.parse(settings.get(db, "brain.removed") ?? "[]") as string[];
}
