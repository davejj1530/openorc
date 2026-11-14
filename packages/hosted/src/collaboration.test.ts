import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHosted, type Hosted } from "./index.js";
import { hostDeps, newDevice, signInAs, type Device } from "./test-fixtures/host.js";
import { standIn, type StandIn } from "./testing/stand-in.js";
import type { HostedDeps } from "./index.js";

const ADA = "ada@example.com";
const BOB = "bob@example.com";

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

async function hostAs(email: string, overrides: Partial<HostedDeps> = {}) {
  const on = newDevice();
  on.projects = device.projects;
  const { deps, seen, browser } = hostDeps(stand, on, overrides);
  const hosted = createHosted(deps);
  hosts.push(hosted);
  await hosted.start();
  await signInAs(hosted, browser, email);
  return { hosted, seen };
}

const pro = { pro: true, standing: "live", at: new Date(Date.now() + 86_400_000).toISOString(), monthlyLeftSeconds: 3600, packsLeftSeconds: 0 } as const;

/** A team thread Ada started, with Bob in her team, both able to start turns. */
function teamThread(title = "Export the log") {
  const team = stand.addTeam("Altalogy", [ADA, BOB]);
  const project = stand.addProject(ADA, { name: "openorc", fullName: "altalogy/openorc" }, team);
  for (const email of [ADA, BOB]) {
    stand.setBilling(email, pro);
    stand.setSignIns(email, [{ agent: "claude" }]);
  }
  return { team, project, thread: stand.addThread(ADA, { projectId: project, title }) };
}

const summary = async (hosted: Hosted, id: string) => (await hosted.threads.call("threads.get", { id }))!;

describe("working together: what the server says", () => {
  it("carries the reader, the creator and the live sender apart, with the server's closed capability", async () => {
    const team = stand.addTeam("Altalogy", [ADA, BOB]);
    const project = stand.addProject(ADA, { name: "openorc", fullName: "altalogy/openorc" }, team);
    const thread = stand.addThread(ADA, { projectId: project, title: "Export the log", status: "working" });
    const { hosted: bob } = await hostAs(BOB);
    const { hosted: ada } = await hostAs(ADA);
    await vi.waitFor(() => expect(bob.threads.holds({ thread }) && ada.threads.holds({ thread })).toBe(true));
    const bobs = await summary(bob, thread);
    expect(bobs.owner?.startedBy).toEqual({ name: "Ada", image: null });
    expect(bobs.owner?.collaboration).toMatchObject({
      viewer: { name: "Bob" },
      canWrite: false,
      send: "blocked",
      canStop: false,
      canPostNote: false,
      live: { sender: { name: "Ada" }, stopping: false },
    });
    expect(typeof bobs.owner?.collaboration?.live?.startedAt).toBe("number");
    const adas = await summary(ada, thread);
    expect(adas.owner?.startedBy).toBeUndefined();
    expect(adas.owner?.collaboration).toMatchObject({ viewer: { name: "Ada" }, live: { sender: { name: "Ada" } } });
    expect(await bob.threads.call("threads.collaboration", { threadId: thread })).toEqual({ supported: true, state: bobs.owner!.collaboration });
  });

  it("names each turn's sender and each message's author from the log, never the payer of the moment", async () => {
    const { thread } = teamThread();
    stand.threadCollaboration.sharedWrites = true;
    const { hosted: ada } = await hostAs(ADA);
    const { hosted: bob, seen } = await hostAs(BOB);
    await vi.waitFor(() => expect(bob.threads.holds({ thread }) && ada.threads.holds({ thread })).toBe(true));
    const runId = `hosted:${thread}`;
    await ada.threads.call("runs.send", { runId, text: "Add a CSV export", messageId: "user-00000000-0000-4000-8000-00000000000a" });
    await bob.threads.call("runs.send", { runId, text: "Keep the date first", messageId: "user-00000000-0000-4000-8000-00000000000b" });
    stand.append(thread, [{ type: "message.completed", ts: 3, messageId: "reply-1", role: "assistant", text: "The date stays first." }]);
    stand.endTurn(thread);
    await bob.threads.call("runs.send", { runId, text: "Name the file", messageId: "user-00000000-0000-4000-8000-00000000000c" });
    stand.append(thread, [{ type: "message.completed", ts: 5, messageId: "reply-2", role: "assistant", text: "Named." }]);
    await bob.threads.call("events.page", { runId, fromTurn: 0 });
    const read = await bob.threads.call("threads.authors", { threadId: thread });
    const first = read.turnOf["reply-1"]!;
    const second = read.turnOf["reply-2"]!;
    expect(first).not.toBe(second);
    expect(read.turnOf["user-00000000-0000-4000-8000-00000000000b"]).toBe(first);
    expect(read.senders[first]).toMatchObject({ name: "Ada" });
    expect(read.senders[second]).toMatchObject({ name: "Bob" });
    expect(read.authors).toMatchObject({
      "user-00000000-0000-4000-8000-00000000000a": { name: "Ada" },
      "user-00000000-0000-4000-8000-00000000000b": { name: "Bob" },
      "user-00000000-0000-4000-8000-00000000000c": { name: "Bob" },
    });
    expect(read.viewer).toMatchObject({ name: "Bob" });
    // What it read once it keeps: a second read asks the server nothing more.
    const asked = stand.requests.filter((request) => request.path.endsWith("/turn-senders")).length;
    await bob.threads.call("threads.authors", { threadId: thread });
    expect(stand.requests.filter((request) => request.path.endsWith("/turn-senders")).length).toBe(asked);
    // A turn arriving as a frame tells the window to read its sender.
    expect((seen.pushes as { type: string; keys?: string[] }[]).some((push) => push.type === "invalidate" && push.keys?.includes(`authors:${thread}`))).toBe(true);
  });

  it("reads a former member as no one, and one sender read failing as a failure", async () => {
    const { thread } = teamThread();
    stand.threadCollaboration.sharedWrites = true;
    let failing = false;
    const { hosted: ada } = await hostAs(ADA, {
      fetch: async (input, init) =>
        failing && String(input).includes("/turn-senders") ? new Response(JSON.stringify({ message: "Try again.", statusCode: 503 }), { status: 503 }) : fetch(input, init),
    });
    await vi.waitFor(() => expect(ada.threads.holds({ thread })).toBe(true));
    const runId = `hosted:${thread}`;
    await ada.threads.call("runs.send", { runId, text: "Start", messageId: "user-00000000-0000-4000-8000-0000000000a1" });
    stand.endTurn(thread);
    await vi.waitFor(async () => expect((await summary(ada, thread)).owner?.collaboration?.live).toBeNull());
    await ada.threads.call("events.page", { runId, fromTurn: 0 });
    failing = true;
    await expect(ada.threads.call("threads.authors", { threadId: thread })).rejects.toThrow("Try again.");
    failing = false;
    stand.threadCollaboration.gone.add(ADA);
    const read = await ada.threads.call("threads.authors", { threadId: thread });
    const turn = read.turnOf["user-00000000-0000-4000-8000-0000000000a1"]!;
    expect(read.senders[turn]).toBeNull();
  });

  it("keeps an older server's teammate view: no collaboration, unsupported, no names and no reads of them", async () => {
    const { thread } = teamThread();
    stand.threadCollaboration.served = false;
    const { hosted: bob } = await hostAs(BOB);
    await vi.waitFor(() => expect(bob.threads.holds({ thread })).toBe(true));
    expect((await summary(bob, thread)).owner?.collaboration).toBeUndefined();
    expect(await bob.threads.call("threads.collaboration", { threadId: thread })).toEqual({ supported: false });
    expect(await bob.threads.call("threads.authors", { threadId: thread })).toEqual({ viewer: null, turnOf: {}, senders: {}, authors: {} });
    expect(stand.requests.some((request) => request.path.endsWith("/turn-senders") || request.path.endsWith("/people"))).toBe(false);
  });

  it("refuses the probe for a thread the server no longer has, rather than calling it unsupported", async () => {
    const { thread } = teamThread();
    const { hosted: bob } = await hostAs(BOB, {
      fetch: async (input, init) =>
        String(input).endsWith("/collaboration") ? new Response(JSON.stringify({ message: "That thread isn't here.", statusCode: 404 }), { status: 404 }) : fetch(input, init),
    });
    await vi.waitFor(() => expect(bob.threads.holds({ thread })).toBe(true));
    await expect(bob.threads.call("threads.collaboration", { threadId: thread })).rejects.toThrow("That thread isn't here.");
  });

  it("lists who can be tagged, telling apart people of one name by address only", async () => {
    const team = stand.addTeam("Altalogy", [ADA, BOB, "ada@elsewhere.example.com"]);
    const project = stand.addProject(ADA, { name: "openorc", fullName: "altalogy/openorc" }, team);
    const thread = stand.addThread(ADA, { projectId: project, title: "Names" });
    const { hosted: bob } = await hostAs(BOB);
    await vi.waitFor(() => expect(bob.threads.holds({ thread })).toBe(true));
    const { people } = await bob.threads.call("threads.people", { threadId: thread });
    expect(people.map((each) => [each.name, each.address]).sort()).toEqual([
      ["Ada", "ada@elsewhere.example.com"],
      ["Ada", "ada@example.com"],
      ["Bob", null],
    ]);
    expect((await bob.threads.call("threads.people", { threadId: thread, q: "bo" })).people.map((each) => each.name)).toEqual(["Bob"]);
  });

  it("answers nothing about a thread once the account signs out", async () => {
    const { thread } = teamThread();
    stand.threadCollaboration.sharedWrites = true;
    const { hosted: ada } = await hostAs(ADA);
    await vi.waitFor(() => expect(ada.threads.holds({ thread })).toBe(true));
    await ada.threads.call("runs.send", { runId: `hosted:${thread}`, text: "Start", messageId: "user-00000000-0000-4000-8000-0000000000b1" });
    await ada.threads.call("events.page", { runId: `hosted:${thread}`, fromTurn: 0 });
    expect(Object.keys((await ada.threads.call("threads.authors", { threadId: thread })).authors)).toHaveLength(1);
    await ada.account.signOut();
    expect(ada.threads.holds({ thread })).toBe(false);
    await expect(ada.threads.call("threads.authors", { threadId: thread })).rejects.toThrow();
  });
});
