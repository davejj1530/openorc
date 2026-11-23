import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { keepCoreOutput } from "./core-output";

const made: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function printingCore() {
  const dir = mkdtempSync(join(tmpdir(), "openorc-core-output-"));
  made.push(dir);
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
  const echoed: string[] = [];
  const file = join(dir, "logs", "core.log");
  keepCoreOutput(child, file, { out: (text) => echoed.push(text), err: (text) => echoed.push(text) });
  return { child, echoed, file };
}

const flushed = () => new Promise((resolve) => setImmediate(resolve));

it("passes on what the core prints, and writes its last words and exit code once its output closes after a failure", async () => {
  const { child, echoed, file } = printingCore();
  child.stdout.write("[core] up, pid 64177\n");
  child.stderr.write("FATAL ERROR: Reached heap limit\n");
  await flushed();
  expect(echoed).toEqual(["[core] [core] up, pid 64177\n", "[core!] FATAL ERROR: Reached heap limit\n"]);
  child.emit("exit", 133);
  child.stderr.write("last line after the exit\n");
  child.stderr.end();
  await flushed();
  await flushed();
  const log = readFileSync(file, "utf8");
  expect(log).toContain("The core exited with code 133. The last it printed:\n[core] up, pid 64177\nFATAL ERROR: Reached heap limit\nlast line after the exit");
});

it("writes the log without waiting long for output that never closes", () => {
  vi.useFakeTimers();
  const { child, file } = printingCore();
  child.emit("exit", 5);
  expect(existsSync(file)).toBe(false);
  vi.advanceTimersByTime(1_000);
  expect(readFileSync(file, "utf8")).toContain("The core exited with code 5. It printed nothing.");
});

it("writes nothing for a core that closed cleanly", async () => {
  const { child, file } = printingCore();
  child.stderr.write("shutting down\n");
  child.emit("exit", 0);
  child.stderr.end();
  await flushed();
  expect(existsSync(file)).toBe(false);
});
