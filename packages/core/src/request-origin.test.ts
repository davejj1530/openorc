import { expect, it } from "vitest";
import { OWNER_DEVICE, usesHost } from "./request-origin.js";

it("counts phones and the Mac's own actions as use of the brain, never the Mac reading its threads, runs and tasks", () => {
  const mac = { kind: "phone" as const, deviceId: OWNER_DEVICE };
  expect(usesHost("threads.list", mac)).toBe(false);
  expect(usesHost("inbox.list", mac)).toBe(false);
  expect(usesHost("tasks.list", mac)).toBe(false);
  expect(usesHost("brain.memory.exchange", mac)).toBe(false);
  expect(usesHost("brain.backlog", mac)).toBe(false);
  expect(usesHost("brain.textGeneration", mac)).toBe(false);
  // Polled and read again after every change on the Mac, so reading never keeps the brain up.
  for (const read of ["events.page", "threads.get", "threads.messages", "runs.listForThread", "git.threadLog", "git.threadPushState", "tasks.comments.list"]) expect(usesHost(read, mac)).toBe(false);
  for (const action of ["threads.send", "runs.start", "approvals.resolve", "threads.snapshot"]) expect(usesHost(action, mac)).toBe(true);
  expect(usesHost("events.page", { kind: "phone", deviceId: "phone-1" })).toBe(true);
  expect(usesHost("threads.list", { kind: "phone", deviceId: "phone-1" })).toBe(true);
  expect(usesHost("threads.list", undefined)).toBe(true);
});
