import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { hostedRunId, type ThreadCollaboration } from "@openorc/protocol";
import { NO_CLOUD_FILES } from "./cloud-policy.js";
import { CLOUD, cloudMac, ME, MARA, type CloudMac } from "./test-fixtures/cloud-mac.js";
import type { RemoteTestClient } from "./test-client.js";

/*
 * A phone that shares cloud threads writes in them as the person signed in on its Mac, with shared writing open on the
 * server. Each change reaches the server once, as the person's own window would send it, except that Stop, an answer and
 * a join carry the turn and the ask the phone saw: the phone's screen is always a moment behind the Mac.
 */

const FROM_PHONE = "This is not available from a phone.";
const settings = { agent: "claude", mode: "act", permissionMode: "trusted" } as const;
const ONE_PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

let at: CloudMac;
let phone: RemoteTestClient;
beforeAll(async () => {
  at = await cloudMac();
  at.stand.threadCollaboration.sharedWrites = true;
  at.stand.setSignIns(MARA, [{ agent: "claude" }]);
  phone = await at.phone(CLOUD);
}, 30_000);
afterAll(() => at.close());

const refusal = (work: Promise<unknown>) =>
  work.then(
    () => null,
    (error: Error) => error.message,
  );
/** The thread's collaboration as the phone reads it, once `ready` holds of it. */
async function together(threadId: string, ready: (state: ThreadCollaboration) => boolean): Promise<ThreadCollaboration> {
  let state: ThreadCollaboration | null = null;
  await vi.waitFor(
    async () => {
      const read = (await phone.request("threads.collaboration", { threadId })) as { supported: true; state: ThreadCollaboration } | { supported: false };
      expect(read.supported && ready(read.state)).toBe(true);
      state = read.supported ? read.state : null;
    },
    { timeout: 5_000 },
  );
  return state!;
}
const sentTo = (threadId: string) => at.stand.sent.filter((each) => each.threadId === threadId);
const stops = (threadId: string) => at.stand.requests.filter((request) => request.method === "POST" && request.path === `/hosted/threads/${threadId}/stop`).length;

/** Mara starts a turn in her thread from her own Mac. */
async function marasTurn(threadId: string, prompt: string) {
  await at.asMara((mara) => mara("runs.start", { threadId, ...settings, prompt }));
  return (await together(threadId, (state) => state.live?.sender?.name === "Mara Okafor")).live!;
}

it("joins a teammate's running turn it saw, on her sign-in and hours, as the person's own message", async () => {
  const threadId = at.cloud.threads.teammate;
  const live = await marasTurn(threadId, "Lay out the plans.");
  const before = sentTo(threadId).length;
  await phone.call("runs.send", { runId: hostedRunId(threadId), text: "Keep the annual toggle on top.", expectedTurnId: live.id });
  const sent = sentTo(threadId).slice(before);
  expect(sent).toHaveLength(1);
  expect(sent[0]!.body).toMatchObject({ text: "Keep the annual toggle on top.", expectedTurnId: live.id });
  expect((await together(threadId, () => true)).live?.sender?.name).toBe("Mara Okafor");
});

it("keeps a join that missed its turn as its author's own queued message, and never joins the turn that runs now", async () => {
  const threadId = at.cloud.threads.teammate;
  const before = sentTo(threadId).length;
  await phone.call("runs.send", { runId: hostedRunId(threadId), text: "This was for the turn that ended.", expectedTurnId: "turn-that-ended" });
  expect(sentTo(threadId).slice(before)).toHaveLength(1);
  const state = await together(threadId, (each) => each.queue.some((queued) => queued.author?.name === "Reader"));
  expect(state.live?.sender?.name).toBe("Mara Okafor");
  expect(state.queue.filter((queued) => queued.author?.name === "Reader")).toHaveLength(1);
});

it("stops only the turn it saw: a turn that changed is refused in the server's words, the one it saw stops", async () => {
  const threadId = at.cloud.threads.teammate;
  const runId = hostedRunId(threadId);
  const live = (await together(threadId, (state) => state.live !== null)).live!;
  const before = stops(threadId);
  expect(await refusal(phone.call("runs.interrupt", { runId, expectedTurnId: "turn-that-ended" }))).toBe("That turn ended. Check the thread before stopping again.");
  expect(await together(threadId, () => true)).toMatchObject({ live: { id: live.id } });
  await phone.call("runs.interrupt", { runId, expectedTurnId: live.id });
  expect(stops(threadId)).toBe(before + 2);
  await together(threadId, (state) => state.live === null || state.live.stopping);
});

it("answers only the ask it saw, in the phase it saw it", async () => {
  const threadId = at.cloud.threads.mine;
  const runId = hostedRunId(threadId);
  await phone.call("runs.start", { threadId, ...settings, prompt: "Cache the tiles per trip." });
  await together(threadId, (state) => state.live?.sender?.name === "Reader");
  const approvalId = at.stand.ask(threadId, { kind: "command", toolName: "Bash", input: { command: "pnpm tiles" }, detail: "Build the tiles" });
  const ask = (await together(threadId, (state) => state.ask?.id === approvalId)).ask!;
  expect(ask).toMatchObject({ state: "waiting", answer: "live" });
  const before = at.stand.answered.length;
  expect(await refusal(phone.call("approvals.resolve", { runId, approvalId, decision: "allow", expectedState: "parked", expectedTurnId: ask.turnId }))).toBe(
    "This request changed. Check it again before answering.",
  );
  await phone.call("approvals.resolve", { runId, approvalId, decision: "allow", expectedState: ask.state, expectedTurnId: ask.turnId });
  // Each answer reached the server once, with the phase the phone named: the first the server refused, the second it took.
  const answered = at.stand.answered.slice(before);
  expect(answered.map((each) => each.body["expectedState"])).toEqual(["parked", "waiting"]);
  expect(answered[1]).toMatchObject({ askId: approvalId, who: ME, body: { decision: "allow", expectedTurnId: ask.turnId } });
});

it("refuses a Stop or an answer that does not name what the phone saw, and the server hears nothing of it", async () => {
  const threadId = at.cloud.threads.mine;
  const runId = hostedRunId(threadId);
  const approvalId = at.stand.ask(threadId, { kind: "command", toolName: "Bash", input: { command: "pnpm lint" }, detail: "Lint" });
  await together(threadId, (state) => state.ask?.id === approvalId);
  const answered = at.stand.answered.length;
  const stopped = stops(threadId);
  expect(await refusal(phone.call("runs.interrupt", { runId }))).toBe(FROM_PHONE);
  expect(await refusal(phone.call("approvals.resolve", { runId, approvalId, decision: "allow" }))).toBe(FROM_PHONE);
  expect(await refusal(phone.call("approvals.resolve", { runId, approvalId, decision: "allow", expectedTurnId: "turn" }))).toBe(FROM_PHONE);
  expect(await refusal(phone.request("threads.sendQueued", { id: threadId, messageId: "message" }))).toBe(FROM_PHONE);
  expect({ answered: at.stand.answered.length, stopped: stops(threadId) }).toEqual({ answered, stopped });
});

it("refuses a phone's image for a cloud thread before the server hears of it, and keeps the Mac's own threads as they were", async () => {
  const threadId = at.cloud.threads.personal;
  const before = sentTo(threadId).length;
  const image = await phone.call("attachments.save", { name: "shot.png", mime: "image/png", dataBase64: ONE_PIXEL });
  expect(await refusal(phone.call("runs.start", { threadId, ...settings, prompt: "Look at this.", attachments: [image.path] }))).toBe(NO_CLOUD_FILES);
  expect(await refusal(phone.call("threads.queue", { id: threadId, text: "Look at this.", attachments: [image.path] }))).toBe(NO_CLOUD_FILES);
  expect(sentTo(threadId).length).toBe(before);
  // A Mac thread is the Mac's: an unbound Stop of a run it does not have does nothing, as before.
  expect(await phone.call("runs.interrupt", { runId: at.mac.runId })).toBeNull();
});

it("queues for after a running turn and takes its own waiting message back", async () => {
  const threadId = at.cloud.threads.teammate;
  await marasTurn(threadId, "Tighten the footer.");
  const queued = await phone.call("threads.queue", { id: threadId, text: "Then the header." });
  const mine = queued.find((each) => each.text === "Then the header.");
  expect(mine).toBeDefined();
  expect(sentTo(threadId).at(-1)!.body).toMatchObject({ text: "Then the header.", delivery: "after" });
  const left = await phone.call("threads.unqueue", { id: threadId, messageId: mine!.id });
  expect(left.some((each) => each.id === mine!.id)).toBe(false);
});

it("starts a cloud thread in a space's project, and keeps its own pin as the reader's", async () => {
  const [project] = await phone.call("spaces.projects", { spaceId: at.cloud.alder });
  const started = at.stand.started.length;
  const thread = await phone.call("threads.start", { projectId: project!.key, spaceId: at.cloud.alder, hosted: true, ...settings, prompt: "Draft the trip planner." });
  expect(at.stand.started.slice(started)).toEqual([expect.objectContaining({ space: at.cloud.alder })]);
  expect(thread.thread).toMatchObject({ owner: { brain: "hosted" } });
  await phone.call("threads.update", { id: at.cloud.threads.mine, patch: { pinned: true } });
  expect(await at.window("threads.get", { id: at.cloud.threads.mine })).toMatchObject({ pinnedAt: expect.any(Number) });
});

it("releases a turn a handoff holds, as the person's own window does: stops the command, the work, and retries the save", async () => {
  const { teammate, mine } = at.cloud.threads;
  at.stand.endTurn(teammate);
  at.stand.threadCollaboration.handoffs.set(teammate, { code: "handoff_command", responsible: MARA, commandIds: ["c1"] });
  await together(teammate, (state) => state.handoff?.commandIds[0] === "c1");
  await phone.call("threads.stopCommand", { id: teammate, commandId: "c1" });
  await together(teammate, (state) => state.handoff === null);
  await vi.waitFor(async () => {
    at.stand.endTurn(mine);
    expect((await together(mine, () => true)).live).toBeNull();
  });
  at.stand.threadCollaboration.handoffs.set(mine, { code: "handoff_unavailable", responsible: MARA, commandIds: [] });
  await together(mine, (state) => state.handoff?.stopWork === true);
  await phone.call("threads.stopWork", { threadId: mine });
  await together(mine, (state) => state.handoff === null);
  await phone.call("threads.retrySave", { threadId: teammate });
  expect(at.stand.requests.some((request) => request.path === `/hosted/threads/${teammate}/retry-save`)).toBe(true);
});

it("reads a teammate's note that tags the person through the Mac, and marks it read once seen", async () => {
  const threadId = at.cloud.threads.teammate;
  const id = crypto.randomUUID();
  const me = (await together(threadId, () => true)).viewer!;
  await at.asMara((mara) => mara("threads.postNote", { threadId, id, text: "@Riley can you check the footer?", mentions: [{ userId: me.id, start: 0, end: 6 }] }));
  expect((await together(threadId, (state) => state.mentions.unread)).mentions.firstUnreadNoteId).toBe(id);
  const page = await phone.call("threads.notes", { threadId, limit: 200 });
  expect(page.notes.find((note) => note.id === id)).toMatchObject({ mentionedYou: true, read: false, author: { name: "Mara Okafor" } });
  await phone.call("threads.readNotes", { threadId, ids: [id] });
  await together(threadId, (state) => !state.mentions.unread);
});

it("finds a teammate to tag and posts a note to them through the Mac, which starts no turn", async () => {
  const threadId = at.cloud.threads.teammate;
  const { people } = await phone.call("threads.people", { threadId, q: "Mar" });
  const mara = people.find((person) => person.name === "Mara Okafor")!;
  const before = sentTo(threadId).length;
  const id = crypto.randomUUID();
  const { note } = await phone.call("threads.postNote", { threadId, id, text: "@Mara Okafor the footer is done", mentions: [{ userId: mara.id, start: 0, end: 12 }] });
  expect(note).toMatchObject({ id, text: "@Mara Okafor the footer is done", mentions: [expect.objectContaining({ userId: mara.id, start: 0, end: 12 })] });
  expect(sentTo(threadId).length).toBe(before);
});

it("lets a phone read a cloud thread's work and ask for a commit, push or pull request, which the server decides", async () => {
  const threadId = at.cloud.threads.mine;
  const before = at.stand.requests.length;
  const asked = await Promise.all([
    refusal(phone.request("hosted.review.state", { threadId })),
    refusal(phone.request("hosted.review.changes", { threadId })),
    refusal(phone.request("hosted.review.commits", { threadId })),
    refusal(phone.request("hosted.review.action", { threadId, action: { kind: "push", id: crypto.randomUUID() } })),
  ]);
  expect(asked.filter((answer) => answer === FROM_PHONE)).toEqual([]);
  const paths = at.stand.requests.slice(before).map((request) => request.path.split("?")[0]);
  expect(paths).toEqual(expect.arrayContaining([expect.stringContaining(`/hosted/threads/${threadId}/`)]));
});

it("deletes a cloud thread from a phone, and never one of this Mac's", async () => {
  expect(await refusal(phone.request("threads.delete", { id: at.mac.threadId }))).toBe(FROM_PHONE);
  expect(await at.window("threads.get", { id: at.mac.threadId })).toMatchObject({ id: at.mac.threadId });
  const threadId = at.cloud.threads.personal;
  const before = at.stand.requests.length;
  await phone.request("threads.delete", { id: threadId });
  expect(at.stand.requests.slice(before)).toContainEqual(expect.objectContaining({ method: "DELETE", path: `/hosted/threads/${threadId}` }));
});
