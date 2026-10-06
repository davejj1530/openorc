import { EventEmitter } from "node:events";
import { execFile, type ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stopProcess, waitForProcessGroup } from "./process-lifetime.js";

vi.mock("node:child_process", async (original) => ({ ...(await original<typeof import("node:child_process")>()), execFile: vi.fn() }));

const error = (code: string) => Object.assign(new Error(`kill ${code}`), { code });
const child = () => Object.assign(new EventEmitter(), { pid: 987654, exitCode: null, signalCode: null, kill: vi.fn(() => true) }) as unknown as ChildProcess;
const platform = process.platform;
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", { value: platform });
});

it("ends the whole process tree on Windows, and the launcher itself when taskkill cannot", () => {
  vi.useFakeTimers();
  Object.defineProperty(process, "platform", { value: "win32" });
  const proc = child();
  stopProcess(proc);
  const [file, args, , done] = vi.mocked(execFile).mock.calls[0] as unknown as [string, string[], object, (error: Error | null) => void];
  expect(file).toMatch(/System32.taskkill\.exe$/);
  expect(args).toEqual(["/pid", "987654", "/T", "/F"]);
  expect(proc.kill).not.toHaveBeenCalled();
  done(new Error("Access is denied"));
  expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
});

describe.skipIf(process.platform === "win32")("process group teardown races", () => {
  it("accepts an EPERM signal race only after a fresh probe proves the group disappeared", async () => {
    vi.useFakeTimers();
    const proc = child();
    const kill = vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
      throw error(signal === 0 ? "ESRCH" : "EPERM");
    });
    proc.emit("close", 0); // close can precede a coordinator's explicit Stop.
    expect(() => stopProcess(proc)).not.toThrow();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(2000);
    expect(kill.mock.calls.filter(([, signal]) => signal !== 0)).toHaveLength(1);
    await expect(waitForProcessGroup(proc)).resolves.toBeUndefined();
    expect(proc.kill).not.toHaveBeenCalled();
  });

  it("keeps a live denied group fenced and allows the next stop to signal it again", () => {
    vi.useFakeTimers();
    const proc = child();
    let denied = true;
    const kill = vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
      if (signal !== 0 && denied) throw error("EPERM");
      return true;
    });
    expect(() => stopProcess(proc)).toThrow("kill EPERM");
    denied = false;
    stopProcess(proc);
    expect(kill.mock.calls.filter(([, signal]) => signal === "SIGTERM")).toHaveLength(2);
  });

  it("contains delayed kill failures without confirming closure and lets a later stop retry", async () => {
    vi.useFakeTimers();
    const proc = child();
    let exists = true;
    const kill = vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
      if (!exists) throw error("ESRCH");
      if (signal === "SIGKILL") throw error("EPERM");
      return true;
    });
    stopProcess(proc);
    expect(() => vi.advanceTimersByTime(2000)).not.toThrow();
    let closed = false;
    const closing = waitForProcessGroup(proc).then(() => {
      closed = true;
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(closed).toBe(false);
    stopProcess(proc);
    expect(kill.mock.calls.filter(([, signal]) => signal === "SIGTERM")).toHaveLength(2);
    exists = false;
    proc.emit("close", 0);
    await vi.advanceTimersByTimeAsync(25);
    await closing;
    expect(closed).toBe(true);
  });
});
