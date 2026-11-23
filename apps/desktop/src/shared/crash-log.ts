import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { inspect } from "node:util";

/** The core's record of why it stopped, in the profile it runs with. Main adds what the core printed as it went. */
export const coreLogPath = (dataDir: string) => join(dataDir, "logs", "core.log");

/** A log past this size moves to `.1`, replacing the one there, so the two files stay small. */
const ROTATE_AT_BYTES = 1024 * 1024;

/**
 * Adds one entry to a crash log, written in full before this returns: whoever writes it may be about to end. Never
 * throws, so a log that cannot be written changes nothing about the crash it would have recorded.
 */
export function appendCrashLog(file: string, entry: string, now = new Date()): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    if ((statSync(file, { throwIfNoEntry: false })?.size ?? 0) > ROTATE_AT_BYTES) renameSync(file, `${file}.1`);
    appendFileSync(file, `[${now.toISOString()}] ${entry.trimEnd()}\n\n`);
  } catch {
    // Nowhere to write it: the crash goes on as it would have.
  }
}

/**
 * Writes down whatever is about to end this process uncaught, an unhandled rejection included, before it does. The
 * monitor only listens, so the process still ends as it would have, and main starts the core again.
 */
export function recordUncaughtErrors(file: string, target: Pick<NodeJS.Process, "on" | "pid"> = process): void {
  target.on("uncaughtExceptionMonitor", (error, origin) => {
    const what = origin === "unhandledRejection" ? "an unhandled promise rejection" : "an uncaught exception";
    appendCrashLog(file, `The core (pid ${target.pid}) is stopping on ${what}:\n${inspect(error, { depth: 4 })}`);
  });
}
