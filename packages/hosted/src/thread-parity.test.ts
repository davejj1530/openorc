import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHosted, type Hosted } from "./index.js";
import { hostDeps, newDevice, signInAs } from "./test-fixtures/host.js";
import { standIn, type StandIn } from "./testing/stand-in.js";
import { wireThreadDetail } from "./wire.js";

const email = "reader@example.com";
let stand: StandIn;
let hosted: Hosted;
let id: string;
let reads: string[];
let readFailure: boolean;
let oldDetail: boolean;
beforeEach(async () => {
  stand = await standIn({ signup: "open" });
  id = stand.addThread(email, { title: "Example", projectId: null });
  reads = [];
  readFailure = false;
  oldDetail = false;
  const { deps, browser } = hostDeps(stand, newDevice(), {
    fetch: async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/events")) {
        reads.push(url.pathname + url.search);
        if (Number(url.searchParams.get("before")) > 2147483647) return Response.json({ message: "The event cursor is out of range." }, { status: 500 });
        if (readFailure) return Response.json({ message: "The history could not be read." }, { status: 503 });
      }
      if (oldDetail && url.pathname === `/hosted/threads/${id}`) return Response.json(wireThreadDetail.parse(await (await fetch(input, init)).json()));
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

it("compacts through the server as the asker's own turn, the same request asked again being the same compaction", async () => {
  const requestKey = crypto.randomUUID();
  await expect(hosted.threads.call("threads.compact", { id, requestKey })).resolves.toBeNull();
  await hosted.threads.call("threads.compact", { id, requestKey });
  expect(stand.compactions).toEqual([expect.objectContaining({ threadId: id, body: { id: requestKey } }), expect.objectContaining({ threadId: id, body: { id: requestKey } })]);
  await vi.waitFor(async () => expect(await hosted.threads.call("threads.get", { id })).toMatchObject({ activity: "running" }));
  // A turn runs: the server refuses another compaction in the Mac's words.
  await expect(hosted.threads.call("threads.compact", { id })).rejects.toThrow("Wait for the current turn to finish before compacting.");
});

it("reads a tool call's whole output from a server that serves it", async () => {
  stand.threadFiles.capabilities = { toolOutput: { available: true } };
  const whole = "line of output\n".repeat(5_000);
  stand.append(id, [{ type: "tool.completed", ts: 40, toolCallId: "tool-1", output: whole }]);
  await expect(hosted.threads.call("events.toolOutput", { runId: `hosted:${id}`, toolCallId: "tool-1" })).resolves.toEqual({ output: whole });
  await expect(hosted.threads.call("events.toolOutput", { runId: `hosted:${id}`, toolCallId: "never-ended" })).resolves.toEqual({ output: null });
});

it("refuses full output from a server that does not serve it, without substituting a Mac tool result", async () => {
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

it("explains an older server's missing turn-change route without exposing an endpoint", async () => {
  await expect(hosted.threads.call("hosted.review.turn", { threadId: id, turnId: "saved-turn" })).rejects.toThrow("Saved changes aren't available in this cloud thread yet.");
});

it("explains an older thread detail without publishing facts", async () => {
  oldDetail = true;
  await expect(hosted.threads.call("hosted.review.state", { threadId: id })).rejects.toThrow("Publishing isn't available in this cloud thread yet.");
});
