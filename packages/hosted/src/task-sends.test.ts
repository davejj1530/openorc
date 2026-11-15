import { hostedRunId } from "@openorc/protocol";
import { afterEach, expect, it, vi } from "vitest";
import { taskClient } from "./test-fixtures/task-client.js";
import { standIn, type StandIn } from "./testing/stand-in.js";

const email = "person@example.com";
let stand: StandIn;
let close = () => {};
afterEach(async () => {
  close();
  await stand?.close();
});

it.each(["start", "send", "queue"] as const)("%s retains the task's seen revision and message identity on the ordinary send", async (kind) => {
  stand = await standIn({ signup: "open" });
  stand.setBilling(email, { pro: true, standing: "live", at: new Date(Date.now() + 20 * 86_400_000).toISOString(), monthlyLeftSeconds: 3600, packsLeftSeconds: 0 });
  stand.setSignIns(email, [{ agent: "claude" }]);
  const projectId = stand.addProject(email, { name: "Fixture project", fullName: "example/fixture" });
  const threadId = stand.addThread(email, { projectId, title: "A prepared task", status: kind === "start" ? "idle" : "working" });
  const current = await taskClient(stand, email, { organization: true, execution: true, personal: false });
  close = current.close;
  // The client sends to a thread it holds; under load its first read of the rows can still be on the way.
  await vi.waitFor(() => expect(current.hosted.threads.holds({ thread: threadId })).toBe(true));
  const requestId = crypto.randomUUID();
  const task = { id: "saved-task", ifRevision: 7 };
  if (kind === "start")
    await current.hosted.threads.call("runs.start", { threadId, agent: "claude", model: "model-one", mode: "act", permissionMode: "review", prompt: "My task words", messageId: requestId, task });
  else if (kind === "send") await current.hosted.threads.call("runs.send", { runId: hostedRunId(threadId), text: "My task words", messageId: requestId, task });
  else await current.hosted.threads.call("threads.queue", { id: threadId, text: "My task words", requestKey: requestId, task });
  expect(stand.sent.at(-1)?.body).toMatchObject({ id: requestId, text: "My task words", task, ...(kind === "queue" ? { delivery: "after" } : {}) });
});
