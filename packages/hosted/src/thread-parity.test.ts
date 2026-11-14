import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHosted, type Hosted } from "./index.js";
import { hostDeps, newDevice, signInAs } from "./test-fixtures/host.js";
import { standIn, type StandIn } from "./testing/stand-in.js";

const email = "reader@example.com";
let stand: StandIn;
let hosted: Hosted;
let id: string;
let reads: string[];
let readFailure: boolean;
beforeEach(async () => {
  stand = await standIn({ signup: "open" });
  id = stand.addThread(email, { title: "Example", projectId: null });
  reads = [];
  readFailure = false;
  const { deps, browser } = hostDeps(stand, newDevice(), {
    fetch: async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/events")) {
        reads.push(url.pathname + url.search);
        if (readFailure) return Response.json({ message: "The history could not be read." }, { status: 503 });
      }
      return fetch(input, init);
    },
  });
  hosted = createHosted(deps);
  await hosted.start();
  await signInAs(hosted, browser, email);
  await vi.waitFor(() => expect(hosted.threads.holds({ thread: id })).toBe(true));
});
afterEach(async () => {
  hosted.close();
  await stand.close();
});

it.each([
  ["threads.messages", "Searching this cloud thread's full history isn't available yet."],
  ["threads.plans", "Saved plans aren't available in this cloud thread yet."],
  ["threads.checkpoints", "Restoring a cloud checkpoint isn't available yet."],
  ["threads.compact", "Manual compaction isn't available for this cloud thread yet."],
  ["threads.fork", "Forking a cloud thread isn't available yet."],
] as const)("refuses %s with its specific reason instead of a false empty or generic refusal", async (method, reason) => {
  await expect(hosted.threads.call(method, { id })).rejects.toThrow(reason);
});

it.each([
  ["review.comments.list", "Review comments aren't available in this cloud thread yet."],
  ["orclings.reactions", "Reactions aren't available in this cloud thread yet."],
  ["git.threadLog", "Commit history isn't available in this cloud thread yet."],
  ["instructions.list", "Editing this cloud workspace's instructions isn't available yet."],
] as const)("does not claim unsupported %s is empty or local", async (method, reason) => {
  await expect(hosted.threads.call(method, { threadId: id })).rejects.toThrow(reason);
});

it("refuses full output without substituting a Mac tool result", async () => {
  await expect(hosted.threads.call("events.toolOutput", { runId: `hosted:${id}`, toolCallId: "tool-1" })).rejects.toThrow("The full tool output isn't available for this cloud thread.");
});

it("reads the latest completed message from a bounded authorized event page and reuses its head", async () => {
  stand.append(id, [{ type: "message.completed", ts: 50, role: "assistant", messageId: "reply-1", text: "A saved reply" }]);
  hosted.awoke();
  await vi.waitFor(async () => expect(await hosted.threads.call("threads.lastMessage", { id })).toMatchObject({ id: "reply-1", text: "A saved reply", role: "assistant", createdAt: 50 }));
  reads.length = 0;
  await hosted.threads.call("threads.lastMessage", { id });
  await hosted.threads.call("threads.lastMessage", { id });
  expect(reads).toEqual([]);
  stand.append(id, [{ type: "message.completed", ts: 60, role: "assistant", messageId: "reply-2", text: "The next saved reply" }]);
  hosted.awoke();
  await vi.waitFor(async () => expect(await hosted.threads.call("threads.lastMessage", { id })).toMatchObject({ id: "reply-2" }));
  expect(reads.every((path) => path.includes("before=") && path.includes("limit="))).toBe(true);
});

it("does not turn a failed last-message read into no message", async () => {
  stand.append(id, [{ type: "message.completed", ts: 50, role: "assistant", messageId: "reply-1", text: "A saved reply" }]);
  readFailure = true;
  await expect(hosted.threads.call("threads.lastMessage", { id })).rejects.toThrow("The history could not be read.");
});

it("keeps a new thread's legitimate empty preview", async () => {
  expect(await hosted.threads.call("threads.lastMessage", { id })).toBeNull();
});
