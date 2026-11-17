import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHosted, type Hosted } from "./index.js";
import { hostDeps, newDevice, signInAs, type Device } from "./test-fixtures/host.js";
import { standIn, type StandIn } from "./testing/stand-in.js";

const ADA = "ada@example.com";
const BOB = "bob@example.com";
const CY = "cy@example.com";
const pro = { pro: true, standing: "live", at: new Date(Date.now() + 86_400_000).toISOString(), monthlyLeftSeconds: 3600, packsLeftSeconds: 0 } as const;
const noteId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

let stand: StandIn;
let device: Device;
const hosts: Hosted[] = [];

beforeEach(async () => {
  stand = await standIn({ signup: "open" });
  device = newDevice();
  device.projects = [{ id: "mac-openorc", remote: "git@github.com:Altalogy/openorc.git" }];
});

afterEach(async () => {
  for (const hosted of hosts.splice(0)) hosted.close();
  await stand.close();
});

async function hostAs(email: string) {
  const on = newDevice();
  on.projects = device.projects;
  const { deps, browser } = hostDeps(stand, on);
  const hosted = createHosted(deps);
  hosts.push(hosted);
  await hosted.start();
  await signInAs(hosted, browser, email);
  return hosted;
}

/** Ada's team thread with notes open; Cy was on the team and has left it. */
async function shared() {
  const team = stand.addTeam("Altalogy", [ADA, BOB, CY]);
  stand.spaces.removeMember(team, CY);
  const project = stand.addProject(ADA, { name: "openorc", fullName: "altalogy/openorc" }, team);
  stand.setBilling(ADA, pro);
  stand.setSignIns(ADA, [{ agent: "claude" }]);
  stand.threadCollaboration.sharedWrites = true;
  const thread = stand.addThread(ADA, { projectId: project, title: "Export the log" });
  const ada = await hostAs(ADA);
  const bob = await hostAs(BOB);
  await vi.waitFor(() => expect(ada.threads.holds({ thread }) && bob.threads.holds({ thread })).toBe(true));
  return { thread, ada, bob, project, team };
}

const adaTag = (text: string) => ({ text: `@Ada ${text}`, mentions: [{ userId: "user-ada@example.com", start: 0, end: 4 }] });

describe("a thread's notes", () => {
  it("posts a note that tags a teammate, which every reader pages, and starts nothing", async () => {
    const { thread, ada, bob } = await shared();
    const posted = await bob.threads.call("threads.postNote", { threadId: thread, id: noteId(1), ...adaTag("can you check the column order?") });
    expect(posted.note).toMatchObject({
      id: noteId(1),
      seq: 1,
      author: { name: "Bob" },
      text: "@Ada can you check the column order?",
      mentions: [{ person: { name: "Ada" }, start: 0, end: 4 }],
      replyTo: null,
    });
    const page = await ada.threads.call("threads.notes", { threadId: thread });
    expect(page).toMatchObject({ head: 1, hasBefore: false, hasAfter: false, notes: [{ id: noteId(1), mentionedYou: true }] });
    expect((await bob.threads.call("threads.notes", { threadId: thread })).notes[0]).toMatchObject({ mentionedYou: false });
    // A note is never a message to the agent: nothing was sent, readied or started.
    expect([stand.sent, stand.readies]).toEqual([[], []]);
    expect((await bob.threads.call("threads.get", { id: thread }))?.activity).toBe("idle");
  });

  it("answers the same note again for the same id, and refuses an id that names another note", async () => {
    const { thread, bob } = await shared();
    await bob.threads.call("threads.postNote", { threadId: thread, id: noteId(1), ...adaTag("first") });
    expect((await bob.threads.call("threads.postNote", { threadId: thread, id: noteId(1), ...adaTag("first") })).note.seq).toBe(1);
    await expect(bob.threads.call("threads.postNote", { threadId: thread, id: noteId(1), ...adaTag("changed") })).rejects.toThrow("That note id belongs to another note.");
  });

  it("refuses a tag of someone no longer in the organization, and tags that do not name a person, in the server's words", async () => {
    const { thread, bob } = await shared();
    const cy = { text: "@Cy look", mentions: [{ userId: "user-cy@example.com", start: 0, end: 3 }] };
    await expect(bob.threads.call("threads.postNote", { threadId: thread, id: noteId(2), ...cy })).rejects.toThrow("Someone you tagged no longer has access to this project. Choose the people again.");
    const outside = { text: "@Ada", mentions: [{ userId: "user-ada@example.com", start: 2, end: 9 }] };
    await expect(bob.threads.call("threads.postNote", { threadId: thread, id: noteId(3), ...outside })).rejects.toThrow("Choose the people to tag again.");
    expect((await bob.threads.call("threads.notes", { threadId: thread })).notes).toEqual([]);
  });

  it("pages notes before and after a seq, and around one note", async () => {
    const { thread, ada, bob } = await shared();
    for (let n = 1; n <= 5; n++) await bob.threads.call("threads.postNote", { threadId: thread, id: noteId(n), ...adaTag(`note ${n}`) });
    expect((await ada.threads.call("threads.notes", { threadId: thread, limit: 2 })).notes.map((note) => note.seq)).toEqual([4, 5]);
    expect(await ada.threads.call("threads.notes", { threadId: thread, before: 4, limit: 2 })).toMatchObject({ hasBefore: true, hasAfter: true, notes: [{ seq: 2 }, { seq: 3 }] });
    expect((await ada.threads.call("threads.notes", { threadId: thread, after: 3 })).notes.map((note) => note.seq)).toEqual([4, 5]);
    expect((await ada.threads.call("threads.notes", { threadId: thread, around: noteId(3), limit: 3 })).notes.map((note) => note.seq)).toEqual([2, 3, 4]);
    // Near an end of the thread the page is still the page's length, as the server fills it.
    expect((await ada.threads.call("threads.notes", { threadId: thread, around: noteId(5), limit: 3 })).notes.map((note) => note.seq)).toEqual([3, 4, 5]);
    await expect(ada.threads.call("threads.notes", { threadId: thread, around: noteId(9) })).rejects.toThrow("That note isn't here.");
  });

  it("posts a reply to a note in the same thread, and refuses one to a note that is not here", async () => {
    const { thread, ada, bob } = await shared();
    await bob.threads.call("threads.postNote", { threadId: thread, id: noteId(1), ...adaTag("first") });
    const bobTag = { text: "@Bob done", mentions: [{ userId: "user-bob@example.com", start: 0, end: 4 }] };
    expect((await ada.threads.call("threads.postNote", { threadId: thread, id: noteId(2), ...bobTag, replyTo: noteId(1) })).note.replyTo).toBe(noteId(1));
    await expect(ada.threads.call("threads.postNote", { threadId: thread, id: noteId(3), ...bobTag, replyTo: noteId(9) })).rejects.toThrow("That note isn't here.");
  });
});

describe("reading a thread's notes", () => {
  const mentions = async (hosted: Hosted, thread: string) => {
    const read = await hosted.threads.call("threads.collaboration", { threadId: thread });
    return read.supported ? read.state.mentions : null;
  };

  it("marks read only the notes the reader saw, keeps an earlier one unread, and the thread's mention and the space's follow", async () => {
    const { thread, ada, bob, team } = await shared();
    for (let n = 1; n <= 2; n++) await bob.threads.call("threads.postNote", { threadId: thread, id: noteId(n), ...adaTag(`note ${n}`) });
    expect(await mentions(ada, thread)).toEqual({ unread: true, firstUnreadNoteId: noteId(1) });
    expect(await ada.spaces.mentions()).toEqual({ spaceIds: [team] });
    expect(await mentions(bob, thread)).toEqual({ unread: false, firstUnreadNoteId: null });
    expect((await bob.threads.call("threads.notes", { threadId: thread })).notes.map((note) => note.read)).toEqual([true, true]);

    await ada.threads.call("threads.readNotes", { threadId: thread, ids: [noteId(2)] });
    expect((await ada.threads.call("threads.notes", { threadId: thread })).notes.map((note) => note.read)).toEqual([false, true]);
    expect(await mentions(ada, thread)).toEqual({ unread: true, firstUnreadNoteId: noteId(1) });

    await ada.threads.call("threads.readNotes", { threadId: thread, ids: [noteId(1), noteId(2)] });
    expect(await mentions(ada, thread)).toEqual({ unread: false, firstUnreadNoteId: null });
    expect(await ada.spaces.mentions()).toEqual({ spaceIds: [] });
    await expect(ada.threads.call("threads.readNotes", { threadId: thread, ids: [noteId(9)] })).rejects.toThrow("That note isn't here.");
  });

  it("asks a server that predates mentions once, and names no space, until the session is a new one", async () => {
    await shared();
    stand.threadCollaboration.mentionSpaces = false;
    const on = newDevice();
    on.projects = device.projects;
    const { deps, browser } = hostDeps(stand, on);
    const ada = createHosted(deps);
    hosts.push(ada);
    await ada.start();
    await signInAs(ada, browser, ADA);
    const asked = () => stand.requests.filter((request) => request.path === "/hosted/mentions").length;
    expect(await ada.spaces.mentions()).toEqual({ spaceIds: [] });
    expect(await ada.spaces.mentions()).toEqual({ spaceIds: [] });
    expect(asked()).toBe(1);
    await ada.account.signOut();
    await signInAs(ada, browser, ADA);
    await vi.waitFor(() => expect(ada.spaces.status().state).toBe("ready"));
    await ada.spaces.mentions();
    expect(asked()).toBe(2);
  });
});

it("finds a teammate's note in the palette's search, with its author, opening at the turn it follows", async () => {
  const { thread, ada, bob } = await shared();
  await bob.threads.call("threads.postNote", { threadId: thread, id: noteId(9), ...adaTag("keep the comparison table under them.") });
  const hits = await ada.threads.search!(ada.threads.row!(thread).space, { query: "comparison table" });
  expect(hits).toEqual([
    expect.objectContaining({
      threadId: thread,
      role: "note",
      messageId: noteId(9),
      turn: 0,
      snippet: "@Ada keep the comparison table under them.",
      member: { key: "user-bob@example.com", name: expect.any(String) },
    }),
  ]);
});
