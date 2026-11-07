import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Db } from "@openorc/db";
import type { CloudSandbox } from "@openorc/protocol";
import { CloudSandboxes, type BrainSandboxes } from "./cloud-sandboxes.js";

let db: Db;
beforeEach(() => {
  db = Db.memory();
});
afterEach(() => db.close());

const runs = { threadActivity: () => "idle" as const, liveRunForThread: () => null, closeAndWait: async () => undefined };
const mine = { name: "openorc-mac", provider: "vercel" as const, threadId: null, state: "stopped" as const, awakeSince: null, awakeMs: 60_000, vcpus: 2, memoryMb: 4096, costUsd: 0.01, createdAt: 1 };
const theirs: CloudSandbox = {
  name: "openorc-brain",
  provider: "agent37",
  thread: { id: "b1", title: "Started on the phone" },
  state: "running",
  awakeSince: 5,
  awakeMs: 0,
  vcpus: 2,
  memoryMb: 4096,
  costUsd: 0.02,
  working: false,
  createdAt: 2,
};

function sandboxes(brain: BrainSandboxes | null) {
  const cloud = { sandboxes: async () => [mine], removeSandbox: vi.fn(async () => undefined) };
  return { list: new CloudSandboxes(db, cloud as never, runs, () => brain), cloud };
}

it("lists the cloud brain's sandboxes beside this Mac's, marked as the brain's, and has the brain delete its own", async () => {
  const brain = { list: async () => [theirs], remove: vi.fn(async () => undefined) };
  const { list, cloud } = sandboxes(brain);
  const listed = await list.list();
  expect(listed.map((sandbox) => [sandbox.name, sandbox.brain ?? false])).toEqual([
    ["openorc-brain", true],
    ["openorc-mac", false],
  ]);
  await list.remove("openorc-brain");
  expect(brain.remove).toHaveBeenCalledWith("openorc-brain");
  expect(cloud.removeSandbox).not.toHaveBeenCalled();
  await list.remove("openorc-mac");
  expect(cloud.removeSandbox).toHaveBeenCalledWith("vercel", "openorc-mac");
  expect(brain.remove).toHaveBeenCalledTimes(1);
});

it("lists this Mac's alone while the brain is asleep, not set up, or refuses on an older build", async () => {
  for (const brain of [null, { list: async () => Promise.reject(new Error("This is not available from a phone.")), remove: async () => undefined }]) {
    expect((await sandboxes(brain).list.list()).map((sandbox) => sandbox.name)).toEqual(["openorc-mac"]);
  }
});
