import type { Hosted } from "@openorc/hosted";
import { standIn, type StandIn } from "@openorc/hosted/testing";
import { hostedFileReference, hostedRunId, type RpcMethod, type ThreadCollaboration } from "@openorc/protocol";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

// Each test makes several trips to the stand-in over real HTTP and its socket; under the whole suite's load they take longer.
vi.setConfig({ testTimeout: 20_000 });
import { RoutedConnection, type MacLine } from "./routed-connection";
import { accountOn } from "./test-fixtures/stand-in-account";
import { cloudFileScope, uploadToCloud } from "./cloud-upload";

/*
 * With the Mac asleep, the phone writes in OpenOrc Cloud threads from its own session, as A4 proved it could through the
 * Mac: each change reaches the server once, Stop, an answer and a join carrying the turn and the ask the phone saw.
 */

const RILEY = "riley@example.com";
const MARA = "mara@example.com";
const settings = { agent: "claude", mode: "act", permissionMode: "trusted" } as const;
const paid = () => ({
  pro: true,
  standing: "live" as const,
  at: new Date(Date.now() + 86_400_000).toISOString(),
  monthlyLeftSeconds: 3600,
  packsLeftSeconds: 0,
  organizationAccess: { state: "active", reason: null, until: null, message: null } as const,
});

let stand: StandIn;
let riley: Hosted;
let mara: Hosted;
let phone: RoutedConnection;
let threads: { teammate: string; mine: string };
let alder: string;
const asleep: MacLine = {
  call: (() => Promise.reject(new Error("The phone is not connected to its Mac."))) as MacLine["call"],
  onPush: () => () => undefined,
  setFrameInterest: () => undefined,
  attached: false,
};

beforeAll(async () => {
  stand = await standIn({ signup: "open" });
  for (const who of [RILEY, MARA]) {
    stand.setBilling(who, paid());
    stand.setSignIns(who, [{ agent: "claude" }]);
  }
  stand.setPerson(MARA, { name: "Mara Okafor", image: null });
  stand.threadCollaboration.sharedWrites = true;
  const birch = stand.addTeam("Birch Studio", [MARA, RILEY]);
  alder = stand.addTeam("Alder Works", [RILEY]);
  const canvas = stand.addProject(MARA, { name: "canvas", fullName: "birch/canvas" }, birch);
  const kit = stand.addProject(RILEY, { name: "field-kit", fullName: "alder/field-kit" }, alder);
  threads = { teammate: stand.addThread(MARA, { projectId: canvas, title: "Pricing page layout" }), mine: stand.addThread(RILEY, { projectId: kit, title: "Offline tiles" }) };
  riley = await accountOn(stand, RILEY);
  mara = await accountOn(stand, MARA);
  phone = new RoutedConnection(asleep, { hosted: riley });
  // Both clients list the threads before either is written to: Mara starts her turn in hers from her own.
  await vi.waitFor(() => expect(riley.threads.holds({ thread: threads.teammate }) && riley.threads.holds({ thread: threads.mine }) && mara.threads.holds({ thread: threads.teammate })).toBe(true), {
    timeout: 10_000,
  });
}, 30_000);
afterAll(async () => {
  riley.close();
  mara.close();
  await stand.close();
});

const call = (method: string, params: unknown) => phone.call(method as RpcMethod, params as never) as Promise<unknown>;
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
      const read = (await call("threads.collaboration", { threadId })) as { supported: true; state: ThreadCollaboration } | { supported: false };
      expect(read.supported && ready(read.state)).toBe(true);
      state = read.supported ? read.state : null;
    },
    { timeout: 5_000 },
  );
  return state!;
}
const sentTo = (threadId: string) => stand.sent.filter((each) => each.threadId === threadId);
const stops = (threadId: string) => stand.requests.filter((request) => request.method === "POST" && request.path === `/hosted/threads/${threadId}/stop`).length;

it("joins a teammate's running turn it saw, as the person's own message, with the Mac asleep", async () => {
  const threadId = threads.teammate;
  await mara.threads.call("runs.start", { threadId, ...settings, prompt: "Lay out the plans." });
  const live = (await together(threadId, (state) => state.live?.sender?.name === "Mara Okafor")).live!;
  const before = sentTo(threadId).length;
  await call("runs.send", { runId: hostedRunId(threadId), text: "Keep the annual toggle on top.", expectedTurnId: live.id });
  const sent = sentTo(threadId).slice(before);
  expect(sent).toHaveLength(1);
  expect(sent[0]!.body).toMatchObject({ text: "Keep the annual toggle on top.", expectedTurnId: live.id });
});

it("stops only the turn it saw: a turn that changed is refused in the server's words, the one it saw stops", async () => {
  const threadId = threads.teammate;
  const runId = hostedRunId(threadId);
  const live = (await together(threadId, (state) => state.live !== null)).live!;
  const before = stops(threadId);
  expect(await refusal(call("runs.interrupt", { runId, expectedTurnId: "turn-that-ended" }))).toBe("That turn ended. Check the thread before stopping again.");
  await call("runs.interrupt", { runId, expectedTurnId: live.id });
  expect(stops(threadId)).toBe(before + 2);
});

it("answers only the ask it saw, in the phase it saw it", async () => {
  const threadId = threads.mine;
  const runId = hostedRunId(threadId);
  await call("runs.start", { threadId, ...settings, prompt: "Cache the tiles per trip." });
  await together(threadId, (state) => state.live !== null);
  const approvalId = stand.ask(threadId, { kind: "command", toolName: "Bash", input: { command: "pnpm tiles" }, detail: "Build the tiles" });
  const ask = (await together(threadId, (state) => state.ask?.id === approvalId)).ask!;
  const before = stand.answered.length;
  expect(await refusal(call("approvals.resolve", { runId, approvalId, decision: "allow", expectedState: "parked", expectedTurnId: ask.turnId }))).toBe(
    "This request changed. Check it again before answering.",
  );
  await call("approvals.resolve", { runId, approvalId, decision: "allow", expectedState: ask.state, expectedTurnId: ask.turnId });
  const answered = stand.answered.slice(before);
  expect(answered.map((each) => each.body["expectedState"])).toEqual(["parked", ask.state]);
  expect(answered[1]).toMatchObject({ askId: approvalId, who: RILEY, body: { decision: "allow", expectedTurnId: ask.turnId } });
});

it("queues for after a running turn and takes its own waiting message back", async () => {
  const threadId = threads.teammate;
  await mara.threads.call("runs.start", { threadId, ...settings, prompt: "Tighten the footer." }).catch(() => undefined);
  await together(threadId, (state) => state.live !== null);
  const queued = (await call("threads.queue", { id: threadId, text: "Then the header." })) as { id: string; text: string }[];
  const mine = queued.find((each) => each.text === "Then the header.");
  expect(mine).toBeDefined();
  expect(sentTo(threadId).at(-1)!.body).toMatchObject({ text: "Then the header.", delivery: "after" });
  const left = (await call("threads.unqueue", { id: threadId, messageId: mine!.id })) as { id: string }[];
  expect(left.some((each) => each.id === mine!.id)).toBe(false);
});

it("sends a waiting message now into the turn it saw, naming that turn as a message sent now does", async () => {
  const threadId = threads.teammate;
  await mara.threads.call("runs.start", { threadId, ...settings, prompt: "Tighten the spacing." }).catch(() => undefined);
  const live = (await together(threadId, (state) => state.live !== null)).live!;
  const queued = (await call("threads.queue", { id: threadId, text: "And the footer too." })) as { id: string; text: string }[];
  const mine = queued.find((each) => each.text === "And the footer too.")!;
  const before = sentTo(threadId).length;
  await call("threads.sendQueued", { id: threadId, messageId: mine.id, expectedTurnId: live.id });
  expect(sentTo(threadId).slice(before)).toEqual([expect.objectContaining({ body: expect.objectContaining({ text: "And the footer too.", expectedTurnId: live.id }) })]);
});

it("starts a cloud thread in a space's project and keeps its own pin as the reader's", async () => {
  const [project] = (await call("spaces.projects", { spaceId: alder })) as { key: string }[];
  const started = stand.started.length;
  const made = (await call("threads.start", { projectId: project!.key, spaceId: alder, hosted: true, ...settings, prompt: "Draft the trip planner." })) as { thread: { owner?: { brain: string } } };
  expect(stand.started.slice(started)).toEqual([expect.objectContaining({ space: alder })]);
  expect(made.thread).toMatchObject({ owner: { brain: "hosted" } });
  await call("threads.update", { id: threads.mine, patch: { pinned: true } });
  await vi.waitFor(async () => expect(await call("threads.get", { id: threads.mine })).toMatchObject({ pinnedAt: expect.any(Number) }));
});

it("renames, snoozes, resolves and marks unread a cloud thread from the phone's own session, as its menu does", async () => {
  const threadId = threads.mine;
  const until = Date.now() + 3_600_000;
  await call("threads.update", { id: threadId, patch: { title: "Offline map tiles per trip" } });
  await call("threads.update", { id: threadId, patch: { snoozedUntil: until } });
  await call("threads.update", { id: threadId, patch: { archived: true } });
  await call("threads.update", { id: threadId, patch: { seen: false } });
  await vi.waitFor(async () =>
    expect(await call("threads.get", { id: threadId })).toMatchObject({ title: "Offline map tiles per trip", snoozedUntil: expect.any(Number), archivedAt: expect.any(Number) }),
  );
  await call("threads.update", { id: threadId, patch: { archived: false, snoozedUntil: null } });
});

it("sends a file from the phone with a message to a cloud thread, through its own session, and its path into the log", async () => {
  stand.threadFiles.capabilities = { files: { available: true } };
  const threadId = threads.mine;
  const scope = cloudFileScope(riley, { threadId })!;
  expect(scope.destination).toMatchObject({ kind: "hosted", threadId });
  const bytes = new TextEncoder().encode("Pinned notes stay on top.");
  const path = await uploadToCloud(riley, scope, { name: "notes.txt", source: { bytes: bytes.length, read: async (offset, length) => bytes.subarray(offset, offset + length) } });
  expect(hostedFileReference(path)).toMatchObject({ name: "notes.txt" });
  const before = sentTo(threadId).length;
  await call("threads.queue", { id: threadId, text: "Look at this.", attachments: [path] });
  expect(sentTo(threadId).slice(before)).toEqual([expect.objectContaining({ body: expect.objectContaining({ text: "Look at this.", fileIds: [hostedFileReference(path)!.id] }) })]);
});

it("refuses a file of the Mac's for a cloud thread in words before the server takes a message, and says the server's own words while files are off", async () => {
  const threadId = threads.mine;
  const before = sentTo(threadId).length;
  const image = ["/Users/riley/Library/OpenOrc/attachments/shot.png"];
  stand.threadFiles.capabilities = { files: { available: true } };
  expect(await refusal(call("threads.queue", { id: threadId, text: "Look at this.", attachments: image }))).toBe("This file isn't available in this space.");
  stand.threadFiles.capabilities = { files: { available: false, reason: "Files can't be sent to OpenOrc Cloud yet." } };
  expect(await refusal(call("runs.send", { runId: hostedRunId(threadId), text: "Look.", attachments: image }))).toBe("Files can't be sent to OpenOrc Cloud yet.");
  expect(sentTo(threadId).length).toBe(before);
});

it("releases a turn a handoff holds from the phone's own session: stops the command, the work, and retries the save", async () => {
  const [teammate, mine] = [threads.teammate, threads.mine];
  stand.endTurn(teammate);
  stand.threadCollaboration.handoffs.set(teammate, { code: "handoff_command", responsible: MARA, commandIds: ["c1"] });
  expect((await together(teammate, (state) => state.handoff !== null)).handoff).toMatchObject({ commandIds: ["c1"] });
  await call("threads.stopCommand", { id: teammate, commandId: "c1" });
  await together(teammate, (state) => state.handoff === null);
  // Work a teammate's turn left reporting back is stopped by one of the thread's people: here its starter.
  // Every turn sent to it before has ended: a queued message runs as a turn of its own once the one before it ends.
  await vi.waitFor(async () => {
    stand.endTurn(mine);
    expect((await together(mine, () => true)).live).toBeNull();
  });
  stand.threadCollaboration.handoffs.set(mine, { code: "handoff_unavailable", responsible: MARA, commandIds: [] });
  expect((await together(mine, (state) => state.handoff !== null)).handoff).toMatchObject({ stopWork: true });
  await call("threads.stopWork", { threadId: mine });
  await together(mine, (state) => state.handoff === null);
  await call("threads.retrySave", { threadId: teammate });
  expect(stand.requests.some((request) => request.path === `/hosted/threads/${teammate}/retry-save`)).toBe(true);
});

it("reads a teammate's note that tags the person from the phone's own session, and marks it read once seen", async () => {
  const threadId = threads.teammate;
  const id = crypto.randomUUID();
  await mara.threads.call("threads.postNote", { threadId, id, text: "@Riley can you check the annual toggle?", mentions: [{ userId: `user-${RILEY}`, start: 0, end: 6 }] });
  expect((await together(threadId, (state) => state.mentions.unread)).mentions.firstUnreadNoteId).toBe(id);
  const page = (await call("threads.notes", { threadId, limit: 200 })) as { notes: { id: string; mentionedYou: boolean; read: boolean }[] };
  expect(page.notes.find((note) => note.id === id)).toMatchObject({ mentionedYou: true, read: false });
  await call("threads.readNotes", { threadId, ids: [id] });
  await together(threadId, (state) => !state.mentions.unread);
});

it("finds a teammate to tag and posts a note to them from the phone's own session, which starts no turn", async () => {
  const threadId = threads.teammate;
  const people = (await call("threads.people", { threadId, q: "Mar" })) as { people: { id: string; name: string }[] };
  const maraPerson = people.people.find((person) => person.name === "Mara Okafor")!;
  expect(maraPerson).toBeDefined();
  const before = sentTo(threadId).length;
  const id = crypto.randomUUID();
  const posted = (await call("threads.postNote", { threadId, id, text: "@Mara Okafor the toggle is on top", mentions: [{ userId: maraPerson.id, start: 0, end: 12 }] })) as { note: { id: string } };
  expect(posted.note.id).toBe(id);
  await vi.waitFor(async () =>
    expect(((await mara.threads.call("threads.notes", { threadId, limit: 200 })) as { notes: { id: string; mentionedYou: boolean }[] }).notes).toContainEqual(
      expect.objectContaining({ id, mentionedYou: true }),
    ),
  );
  expect(sentTo(threadId).length).toBe(before);
});
