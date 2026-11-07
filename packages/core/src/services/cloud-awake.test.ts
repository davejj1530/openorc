import { expect, it, vi } from "vitest";
import type { Sandbox } from "@openorc/cloud";
import { CloudAwake } from "./cloud-awake.js";

const log = { info: () => undefined, warn: vi.fn(), error: () => undefined };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

it("keeps a VM awake while anything holds it, and lets it go once, a little after the last hold ends", async () => {
  const keepAwake = vi.fn(async () => undefined);
  const sandbox = { awayMs: 200, keepAwake } as unknown as Sandbox;
  const released = vi.fn();
  const awake = new CloudAwake({ released, log });

  const preparing = awake.hold("thread", sandbox);
  const agent = awake.hold("thread", sandbox);
  expect(keepAwake).toHaveBeenCalledTimes(1);
  await sleep(130);
  expect(keepAwake.mock.calls.length).toBeGreaterThanOrEqual(2);

  preparing();
  preparing();
  agent();
  expect(released).not.toHaveBeenCalled();
  await sleep(100);
  expect(released).toHaveBeenCalledOnce();
  expect(released).toHaveBeenCalledWith("thread");

  const calls = keepAwake.mock.calls.length;
  await sleep(130);
  expect(keepAwake).toHaveBeenCalledTimes(calls);
  awake.close();
});

it("keeps the VM when something holds it again before it is let go", async () => {
  const sandbox = { awayMs: 200, keepAwake: vi.fn(async () => undefined) } as unknown as Sandbox;
  const released = vi.fn();
  const awake = new CloudAwake({ released, log });
  awake.hold("thread", sandbox)();
  const next = awake.hold("thread", sandbox);
  await sleep(100);
  expect(released).not.toHaveBeenCalled();
  next();
  await sleep(100);
  expect(released).toHaveBeenCalledOnce();
  awake.close();
});

it("says once that a VM could not be kept awake, not at every try", async () => {
  const sandbox = { awayMs: 40, keepAwake: async () => Promise.reject(new Error("The plan's longest session is 45 minutes")) } as unknown as Sandbox;
  const awake = new CloudAwake({ released: () => undefined, log });
  const release = awake.hold("thread", sandbox);
  await sleep(100);
  expect(log.warn).toHaveBeenCalledOnce();
  expect(log.warn.mock.calls[0]?.[0]).toContain("45 minutes");
  release();
  awake.close();
});
