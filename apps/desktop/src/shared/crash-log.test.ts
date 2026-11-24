import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { appendCrashLog, coreLogPath, recordUncaughtErrors } from "./crash-log";

const made: string[] = [];
const profile = () => {
  const dir = mkdtempSync(join(tmpdir(), "openorc-crash-log-"));
  made.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it("adds timed entries to the profile's core log, making its folder", () => {
  const file = coreLogPath(profile());
  appendCrashLog(file, "first\n", new Date("2026-11-24T04:22:12.000Z"));
  appendCrashLog(file, "second", new Date("2026-11-24T04:22:13.000Z"));
  expect(readFileSync(file, "utf8")).toBe("[2026-11-24T04:22:12.000Z] first\n\n[2026-11-24T04:22:13.000Z] second\n\n");
});

it("moves a log past its size aside, keeping one older file", () => {
  const file = coreLogPath(profile());
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, "x".repeat(1024 * 1024 + 1));
  appendCrashLog(file, "fresh", new Date(0));
  expect(readFileSync(file, "utf8")).toBe("[1970-01-01T00:00:00.000Z] fresh\n\n");
  expect(readFileSync(`${file}.1`, "utf8")).toHaveLength(1024 * 1024 + 1);
});

it("never throws when the log cannot be written", () => {
  const dir = profile();
  // A file where the logs folder should be.
  writeFileSync(join(dir, "logs"), "");
  expect(() => appendCrashLog(coreLogPath(dir), "lost")).not.toThrow();
});

it("writes down an uncaught exception and an unhandled rejection as the process ends on them", () => {
  const file = coreLogPath(profile());
  const process = Object.assign(new EventEmitter(), { pid: 64177 });
  recordUncaughtErrors(file, process as unknown as NodeJS.Process);
  expect(existsSync(file)).toBe(false);
  process.emit("uncaughtExceptionMonitor", new TypeError("Cannot read properties of undefined (reading 'kill')"), "uncaughtException");
  process.emit("uncaughtExceptionMonitor", new Error("spawn gh ENOENT"), "unhandledRejection");
  const log = readFileSync(file, "utf8");
  expect(log).toContain("The core (pid 64177) is stopping on an uncaught exception:\nTypeError: Cannot read properties of undefined (reading 'kill')\n    at ");
  expect(log).toContain("The core (pid 64177) is stopping on an unhandled promise rejection:\nError: spawn gh ENOENT");
});
