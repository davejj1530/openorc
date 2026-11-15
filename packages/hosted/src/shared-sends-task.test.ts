import { expect, it } from "vitest";
import { startQueued, type QueuedStart } from "./shared-sends.js";
import type { Calls } from "./sends.js";
import type { WireThread } from "./wire.js";

/** One thread's row with Bob's paused message, and every request the client makes, answered as the server would. */
function bobsThread(queued: { task: { id: string; ifRevision: number } | null; pause: { kind: string; message: string } | null }, revision = 9) {
  const asked: { path: string; body: unknown }[] = [];
  const row = {
    id: "t1",
    settings: { agent: "claude", model: null },
    collaboration: { queue: [{ messageId: "m1", author: null, paused: true, canEdit: true, canRemove: true, canStart: true, ...queued }] },
  } as unknown as WireThread;
  const calls = {
    row: () => row,
    on: () => ({
      request: async (route: { path: string }, body?: unknown) => {
        asked.push({ path: route.path, body });
        if (route.path === "/tasks/task-1") return { task: { id: "task-1", revision } };
        return { sent: true, message: { id: "m1" } };
      },
    }),
    refresh: async () => undefined,
  } as unknown as Calls;
  return { calls: { ...calls, starts: new Map<string, QueuedStart>() }, asked };
}

it("starts a message paused for a changed task on the revision the task has now, keeping its request id", async () => {
  const { calls, asked } = bobsThread({ task: { id: "task-1", ifRevision: 7 }, pause: { kind: "task", message: "This task changed." } });
  await startQueued(calls, { threadId: "t1", messageId: "m1" });
  const start = asked.find((each) => each.path.endsWith("/start"));
  expect(start?.body).toEqual({ requestId: expect.any(String), task: { id: "task-1", ifRevision: 9 } });
});

it("starts any other paused message with its request id alone, reading no task", async () => {
  const { calls, asked } = bobsThread({ task: { id: "task-1", ifRevision: 7 }, pause: { kind: "join", message: "The turn this was sent to has ended." } });
  await startQueued(calls, { threadId: "t1", messageId: "m1" });
  expect(asked.map((each) => each.path)).toEqual([expect.stringMatching(/\/messages\/m1\/start$/)]);
  expect(asked[0]!.body).toEqual({ requestId: expect.any(String) });
});
