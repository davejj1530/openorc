import { orclings, threadQueue, threads, type Db } from "@openorc/db";
import { orclingWakeKey, type Orcling, type OrclingWake } from "@openorc/protocol";
import type { Logger } from "../transport.js";
import { ORCLING_QUIET_MS } from "./orclings.js";
import { STAY_QUIET } from "./orcling-quiet.js";
import type { ThreadService } from "./threads.js";

type TimeWake = Extract<OrclingWake, { kind: "time" }>;

/** Why an Orcling woke: OpenOrc opening, or a check-in time, which OpenOrc may have been closed for. */
export type WakeReason = { kind: "startup" } | { kind: "time"; at: string; dueAt: number; missed: boolean };

/** A check-in counts as on time within this long of its minute; later, the Orcling hears it was missed. */
const ON_TIME_MS = 5 * 60_000;
/** Opening OpenOrc wakes Orclings once the app has settled, not in the rush of its first seconds. */
const OPENING_DELAY_MS = 8_000;

/** The latest moment at or before now that a check-in time fell on one of its days, in the Mac's local time. */
export function lastDue(wake: TimeWake, now: number): number | null {
  const [hours, minutes] = wake.at.split(":").map(Number) as [number, number];
  const today = new Date(now);
  for (let back = 0; back < 8; back++) {
    const day = new Date(today.getFullYear(), today.getMonth(), today.getDate() - back, hours, minutes);
    if (day.getTime() <= now && wake.days.includes(day.getDay())) return day.getTime();
  }
  return null;
}

/**
 * Which rules of an Orcling are due now, each with how far it has now been checked. A time is due once for its latest
 * occurrence after it was last checked; OpenOrc opening wakes it only after a quiet stretch since its last opening wake
 * and since anything was said, so restarting the app does not wake it again.
 */
export function dueWakes(
  orcling: Pick<Orcling, "wakes">,
  checked: ReadonlyMap<string, number>,
  input: { now: number; opening: boolean; lastActivityAt: number },
): { key: string; reason: WakeReason }[] {
  const { now, opening, lastActivityAt } = input;
  return orcling.wakes.flatMap((wake): { key: string; reason: WakeReason }[] => {
    const key = orclingWakeKey(wake);
    const since = checked.get(key);
    if (wake.kind === "startup") {
      const quiet = now - (since ?? 0) >= ORCLING_QUIET_MS && now - lastActivityAt >= ORCLING_QUIET_MS;
      return opening && quiet ? [{ key, reason: { kind: "startup" } }] : [];
    }
    const dueAt = lastDue(wake, now);
    if (dueAt === null || since === undefined || dueAt <= since) return [];
    return [{ key, reason: { kind: "time", at: wake.at, dueAt, missed: now - dueAt > ON_TIME_MS } }];
  });
}

const clock = (at: number) => new Date(at).toLocaleString("en-US", { weekday: "long", hour: "numeric", minute: "2-digit" });

function wakeReason(reasons: WakeReason[]): string {
  const time = reasons.find((reason) => reason.kind === "time");
  if (!time) return "OpenOrc just opened.";
  return time.missed ? `Your ${time.at} check-in was due ${clock(time.dueAt)}, while OpenOrc was closed. It just opened.` : `It's time for your ${time.at} check-in.`;
}

/** What a waking Orcling is told. Nobody wrote, so it texts only when it has something worth saying. */
export function wakePrompt(reasons: WakeReason[], now: number): string {
  const why = wakeReason(reasons);
  return [
    `(OpenOrc: you woke up on your own; nobody wrote to you. ${why} For the person it's ${clock(now)}.)`,
    "",
    `Look at what matters to them: your memory, their projects, and work you started. If you have something worth texting about, such as a hello with something useful in it, news about work you started, or a question that can't wait, text them the way a friend would. If there's nothing worth saying, ${STAY_QUIET}.`,
  ].join("\n");
}

interface Dependencies {
  db: Db;
  activity: (threadId: string) => "idle" | "running" | "waiting";
  /** Where a wake goes: OpenOrc's own nudge into the Orcling's chat, read by its agent, never shown, and quiet if it says nothing. */
  threads: Pick<ThreadService, "send">;
  log: Logger;
  maintenance?: () => boolean;
  now?: () => number;
}

/** Wakes Orclings on their own: as OpenOrc opens and at their check-in times, catching up once on a time missed while it was closed. */
export class OrclingWakeService {
  private timer: NodeJS.Timeout | null = null;
  private opening: NodeJS.Timeout | null = null;
  private ticking: Promise<void> | null = null;

  constructor(private readonly deps: Dependencies) {}

  start(): void {
    if (this.timer) return;
    this.opening = setTimeout(() => void this.tick(true), OPENING_DELAY_MS);
    this.opening.unref();
    this.timer = setInterval(() => void this.tick(false), 60_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.opening) clearTimeout(this.opening);
    if (this.timer) clearInterval(this.timer);
    this.opening = null;
    this.timer = null;
  }

  /** One pass over every Orcling. A pass never overlaps another, and a due rule is marked checked before its nudge, so it fires once. */
  tick(opening: boolean): Promise<void> {
    this.ticking ??= this.pass(opening)
      .catch((error: unknown) => this.deps.log.warn(`Orcling wake-ups failed: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => {
        this.ticking = null;
      });
    return this.ticking;
  }

  private async pass(opening: boolean): Promise<void> {
    const { db } = this.deps;
    if (this.deps.maintenance?.()) return;
    const now = this.deps.now?.() ?? Date.now();
    for (const orcling of orclings.list(db)) {
      const home = threads.get(db, orcling.threadId);
      if (!home || !orcling.wakes.length) continue;
      const due = dueWakes(orcling, orclings.wakeState(db, orcling.id), { now, opening, lastActivityAt: home.lastActivityAt });
      if (!due.length) continue;
      for (const { key } of due) orclings.markWakeChecked(db, orcling.id, key, now);
      // Busy with the person already, or about to be with a message they queued, it has no need to wake.
      if (this.deps.activity(home.id) !== "idle" || threadQueue.list(db, home.id).some((message) => message.state === "pending" || message.state === "delivering")) continue;
      this.deps.log.info(`Waking ${orcling.name}: ${due.map(({ key }) => key).join(", ")}`);
      await this.deps.threads
        .send(
          home.id,
          wakePrompt(
            due.map(({ reason }) => reason),
            now,
          ),
          null,
          { unprompted: true },
        )
        .catch((error: unknown) => {
          this.deps.log.warn(`${orcling.name} could not wake: ${error instanceof Error ? error.message : String(error)}`);
        });
    }
  }
}
