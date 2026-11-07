import { settings, type Db } from "@openorc/db";

const LEAVING = "brain.leaving";

/** On the cloud brain: until `until`, as while it moves to another service, it starts no new conversation. Null ends that. */
export function markLeaving(db: Db, until: number | null): void {
  if (until === null) settings.remove(db, LEAVING);
  else settings.set(db, LEAVING, String(until));
}

/** Throws while this host is leaving: a conversation started now would be left behind on it. */
export function assertStaying(db: Db, now = Date.now()): void {
  if (Number(settings.get(db, LEAVING) ?? 0) > now) throw new Error("The cloud brain is moving to another service. Start the conversation once it's done.");
}
