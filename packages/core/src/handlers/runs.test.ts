import { runs, type Db } from "@openorc/db";
import { LiveInputUnavailable } from "@openorc/agents";
import type { Run } from "@openorc/protocol";
import { afterEach, expect, it, vi } from "vitest";
import { createRunsHandlers } from "./runs.js";

afterEach(() => vi.restoreAllMocks());

function sendHandler(error?: Error) {
  vi.spyOn(runs, "get").mockReturnValue({ id: "run-1", threadId: "thread-1" } as Run);
  const sent: string[] = [];
  const queued: unknown[][] = [];
  const handlers = createRunsHandlers({
    db: {} as Db,
    dataDir: "/tmp",
    runService: {
      send: async (_runId: string, text: string) => {
        if (error) throw error;
        sent.push(text);
      },
    } as never,
    threadService: {
      queue: (...args: unknown[]) => {
        queued.push(args);
        return [];
      },
    } as never,
  });
  return { send: handlers["runs.send"], sent, queued };
}

it("holds a message in the queue when the running turn can't take one now, such as while it waits on an approval", async () => {
  const run = sendHandler(new LiveInputUnavailable("Wait for the turn to finish."));
  await expect(run.send({ runId: "run-1", text: "Also check the docs.", attachments: ["/tmp/shot.png"] })).resolves.toBeNull();
  expect(run.queued).toEqual([["thread-1", "Also check the docs.", ["/tmp/shot.png"]]]);
});

it("sends into the turn when it can, and still reports a failure that waiting would not fix", async () => {
  const live = sendHandler();
  await live.send({ runId: "run-1", text: "Go on." });
  expect([live.sent, live.queued]).toEqual([["Go on."], []]);

  const resting = sendHandler(new Error("Provider connection failed."));
  await expect(resting.send({ runId: "run-1", text: "Hello" })).rejects.toThrow("Provider connection failed.");
  expect(resting.queued).toEqual([]);
});

it.each(["Cursor is disabled.", "Attachment could not be read.", "The provider disconnected after accepting input."])("does not hide a send failure in the queue: %s", async (message) => {
  const run = sendHandler(new Error(message));
  await expect(run.send({ runId: "run-1", text: "Hello" })).rejects.toThrow(message);
  expect(run.queued).toEqual([]);
});
