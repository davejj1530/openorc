/**
 * A way to snooze a thread. Its wake time counts from the moment it is chosen, which can be long after a menu showed
 * it; a preset whose time has passed by then wakes at the next one the menu lists.
 */
export interface SnoozePreset {
  label: string;
  until: (chosenAt: Date) => number;
}

const HOUR = 3_600_000;
/** This evening is offered while six o'clock is more than this far ahead. */
const EVENING_LEAD = 600_000;

/** `chosenAt` on another day at a time of day. */
function dayAt(chosenAt: Date, addDays: number, hours: number): number {
  const d = new Date(chosenAt);
  d.setDate(d.getDate() + addDays);
  d.setHours(hours, 0, 0, 0);
  return d.getTime();
}

const evening = (at: Date) => dayAt(at, 0, 18);
const eveningAhead = (at: Date) => at.getTime() < evening(at) - EVENING_LEAD;
const tomorrowMorning = (at: Date) => dayAt(at, 1, 9);

/** When a snoozed thread comes back: in an hour or three, this evening while it is still ahead, tomorrow morning, next Monday. */
export function snoozePresets(now = new Date()): SnoozePreset[] {
  return [
    { label: "In 1 hour", until: (chosenAt) => chosenAt.getTime() + HOUR },
    { label: "In 3 hours", until: (chosenAt) => chosenAt.getTime() + 3 * HOUR },
    ...(eveningAhead(now) ? [{ label: "This evening", until: (chosenAt: Date) => (eveningAhead(chosenAt) ? evening(chosenAt) : tomorrowMorning(chosenAt)) }] : []),
    { label: "Tomorrow morning", until: tomorrowMorning },
    { label: "Next week", until: (chosenAt) => dayAt(chosenAt, (8 - chosenAt.getDay()) % 7 || 7, 9) },
  ];
}

/** When the presets offered at `now` next change: as This evening stops being offered, or at midnight, when it is again. */
export function snoozePresetsChangeAt(now: Date): number {
  return eveningAhead(now) ? evening(now) - EVENING_LEAD : dayAt(now, 1, 0);
}

/** When a snoozed thread wakes, as its header says it: "Mon 9:00 AM". */
export function snoozeWakeLabel(until: number): string {
  return new Date(until).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
}
