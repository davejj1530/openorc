import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHosted, type Hosted, type HostedDeps } from "./index.js";
import { hostDeps, newDevice, signInAs, type Device } from "./test-fixtures/host.js";
import { standIn, type StandIn } from "./testing/stand-in.js";

const ADA = "ada@example.com";
const BOB = "bob@example.com";
const pro = { pro: true, standing: "live", at: new Date(Date.now() + 86_400_000).toISOString(), monthlyLeftSeconds: 3600, packsLeftSeconds: 0 } as const;

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
  const { deps, browser } = hostDeps(stand, on, overrides);
  const hosted = createHosted(deps);
  hosts.push(hosted);
  await hosted.start();
  await signInAs(hosted, browser, email);
  return hosted;
}

/** Ada's team thread with shared writing open; Bob has no hours of his own unless `bobPays`. */
async function shared(bobPays = false) {
  const team = stand.addTeam("Altalogy", [ADA, BOB]);
  const project = stand.addProject(ADA, { name: "openorc", fullName: "altalogy/openorc" }, team);
  stand.setBilling(ADA, pro);
  stand.setSignIns(ADA, [{ agent: "claude" }]);
  if (bobPays) {
    stand.setBilling(BOB, pro);
    stand.setSignIns(BOB, [{ agent: "claude" }]);
  } else stand.setBilling(BOB, { pro: false });
  stand.threadCollaboration.sharedWrites = true;
  const thread = stand.addThread(ADA, { projectId: project, title: "Export the log" });
  const ada = await hostAs(ADA);
  const bob = await hostAs(BOB);
  await vi.waitFor(() => expect(ada.threads.holds({ thread }) && bob.threads.holds({ thread })).toBe(true));
  return { thread, ada, bob, runId: `hosted:${thread}` };
}

const row = async (hosted: Hosted, id: string) => (await hosted.threads.call("threads.get", { id }))!;
const live = async (hosted: Hosted, id: string, sender: string | null) =>
  vi.waitFor(async () => {
    await (hosted.threads as unknown as { refresh(): Promise<void> }).refresh();
    expect((await row(hosted, id)).owner?.collaboration?.live?.sender?.name ?? null).toBe(sender);
  });
const id = (n: number) => `user-00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("sending, queueing and Stop in a shared thread", () => {
  it("joins another person's running turn on its sender's hours, needing none of the joiner's own", async () => {
    const { thread, ada, bob, runId } = await shared();
    await ada.threads.call("runs.send", { runId, text: "Add a CSV export", messageId: id(1) });
    await live(bob, thread, "Ada");
    await bob.threads.call("runs.send", { runId, text: "Keep the date first", messageId: id(2) });
    const body = stand.sent.at(-1)!.body;
    expect(body["expectedTurnId"]).toBe((await row(bob, thread)).owner?.collaboration?.live?.id);
    await bob.threads.call("events.page", { runId, fromTurn: 0 });
    const read = await bob.threads.call("threads.authors", { threadId: thread });
    expect(read.authors[id(2)]).toMatchObject({ name: "Bob" });
    expect(read.senders[read.turnOf[id(2)]!]).toMatchObject({ name: "Ada" });
  });

  it("refuses an explicit Queue on the author's own hours, while joining stays open", async () => {
    const { thread, ada, bob, runId } = await shared();
    await ada.threads.call("runs.send", { runId, text: "Start", messageId: id(1) });
    await live(bob, thread, "Ada");
    await expect(bob.threads.call("threads.queue", { id: thread, text: "After her turn", requestKey: id(3) })).rejects.toThrow();
    await expect(bob.threads.call("runs.send", { runId, text: "Now", messageId: id(4) })).resolves.toBeNull();
  });

  it("keeps a Send now whose turn ended as its author's own, never starting it on the previous sender", async () => {
    const { thread, ada, bob, runId } = await shared();
    await ada.threads.call("runs.send", { runId, text: "Start", messageId: id(1) });
    await live(bob, thread, "Ada");
    stand.endTurn(thread);
    await bob.threads.call("runs.send", { runId, text: "Late", messageId: id(5) }).catch(() => undefined);
    await vi.waitFor(async () => expect((await row(ada, thread)).queued.find((each) => each.id === id(5).slice(5))?.error).toBeTruthy());
    expect((await row(ada, thread)).activity).toBe("idle");
  });

  it("stops only the turn it saw: the stopper's waiting messages go, everyone else's pause for their author to start", async () => {
    const { thread, ada, bob, runId } = await shared(true);
    await ada.threads.call("runs.send", { runId, text: "Start", messageId: id(1) });
    await live(bob, thread, "Ada");
    await ada.threads.call("threads.queue", { id: thread, text: "Ada next", requestKey: id(6) });
    await bob.threads.call("threads.queue", { id: thread, text: "Bob next", requestKey: id(7) });
    await live(bob, thread, "Ada");
    await bob.threads.call("runs.interrupt", { runId });
    expect(stand.requests.some((request) => request.path.endsWith("/stop"))).toBe(true);
    await live(ada, thread, null);
    const adas = (await row(ada, thread)).owner!.collaboration!.queue;
    expect(adas.map((each) => [each.author?.name, each.paused, each.canStart])).toEqual([["Ada", true, true]]);
    await expect(bob.threads.call("threads.startQueued", { threadId: thread, messageId: id(6).slice(5) })).rejects.toThrow("Only the sender can change this queued message.");
    await ada.threads.call("threads.startQueued", { threadId: thread, messageId: id(6).slice(5) });
    await live(bob, thread, "Ada");
  });

  it("refuses a Stop aimed at a turn that has changed, in the server's words", async () => {
    // Bob's list stops moving, so his window still shows the first turn when Ada's next one runs.
    let frozen: string | null = null;
    let last: string | null = null;
    const listed = (input: unknown) => new URL(String(input)).pathname === "/hosted/threads";
    stand.threadCollaboration.sharedWrites = true;
    const bobFetch: typeof fetch = async (input, init) => {
      const read = listed(input) && (!init?.method || init.method === "GET");
      if (read && frozen) return new Response(frozen, { status: 200, headers: { "content-type": "application/json" } });
      const answer = await fetch(input, init);
      if (read) last = await answer.clone().text();
      return answer;
    };
    const team = stand.addTeam("Altalogy", [ADA, BOB]);
    const project = stand.addProject(ADA, { name: "openorc", fullName: "altalogy/openorc" }, team);
    for (const email of [ADA, BOB]) {
      stand.setBilling(email, pro);
      stand.setSignIns(email, [{ agent: "claude" }]);
    }
    const thread = stand.addThread(ADA, { projectId: project, title: "Export the log" });
    const ada = await hostAs(ADA);
    const bob = await hostAs(BOB, { fetch: bobFetch });
    const runId = `hosted:${thread}`;
    await vi.waitFor(() => expect(bob.threads.holds({ thread })).toBe(true));
    await ada.threads.call("runs.send", { runId, text: "Start", messageId: id(1) });
    await live(bob, thread, "Ada");
    frozen = last;
    stand.endTurn(thread);
    await ada.threads.call("runs.send", { runId, text: "Again", messageId: id(8) });
    await expect(bob.threads.call("runs.interrupt", { runId })).rejects.toThrow("That turn ended. Check the thread before stopping again.");
  });

  it("asks the server to save the thread's work again", async () => {
    const { thread, bob } = await shared();
    await bob.threads.call("threads.retrySave", { threadId: thread });
    expect(stand.threadCollaboration && stand.requests.some((request) => request.path.endsWith("/retry-save"))).toBe(true);
  });
});

describe("while only joining is open (the slice before handoff)", () => {
  async function joinOnly() {
    const made = await shared();
    stand.threadCollaboration.joinOnly = true;
    return made;
  }
  const words = "Only Ada can run the agent in this cloud thread for now.";

  it("reads a teammate's rights as the server tells them: join while a turn runs, nothing else", async () => {
    const { thread, ada, bob, runId } = await joinOnly();
    await (bob.threads as unknown as { refresh(): Promise<void> }).refresh();
    expect((await row(bob, thread)).owner?.collaboration).toMatchObject({ canWrite: true, send: "blocked", canStop: false, handoff: { code: "handoff_unavailable", message: words } });
    await ada.threads.call("runs.send", { runId, text: "Start", messageId: id(1) });
    await live(bob, thread, "Ada");
    expect((await row(bob, thread)).owner?.collaboration).toMatchObject({ canWrite: true, send: "now", canStop: false, handoff: { message: words } });
    await live(ada, thread, "Ada");
    expect((await row(ada, thread)).owner?.collaboration).toMatchObject({ canWrite: true, send: "now", canStop: true, handoff: null });
  });

  it("joins the running turn, and refuses a teammate's idle send and Queue in the block's words, storing nothing", async () => {
    const { thread, ada, bob, runId } = await joinOnly();
    await expect(bob.threads.call("runs.start", { threadId: thread, prompt: "Idle", agent: "claude", mode: "act", permissionMode: "trusted", messageId: id(2) })).rejects.toThrow(words);
    await ada.threads.call("runs.send", { runId, text: "Start", messageId: id(1) });
    await live(bob, thread, "Ada");
    await expect(bob.threads.call("threads.queue", { id: thread, text: "Later", requestKey: id(3) })).rejects.toThrow(words);
    await expect(bob.threads.call("runs.send", { runId, text: "Join", messageId: id(4) })).resolves.toBeNull();
    expect((await row(ada, thread)).queued).toEqual([]);
  });

  it("keeps a join that missed its turn paused for its author, who may remove it but not start it", async () => {
    let frozen: string | null = null;
    let last: string | null = null;
    const listed = (input: unknown) => new URL(String(input)).pathname === "/hosted/threads";
    const team = stand.addTeam("Altalogy", [ADA, BOB]);
    const project = stand.addProject(ADA, { name: "openorc", fullName: "altalogy/openorc" }, team);
    stand.setBilling(ADA, pro);
    stand.setSignIns(ADA, [{ agent: "claude" }]);
    stand.threadCollaboration.sharedWrites = true;
    stand.threadCollaboration.joinOnly = true;
    const thread = stand.addThread(ADA, { projectId: project, title: "Export the log" });
    const ada = await hostAs(ADA);
    const bob = await hostAs(BOB, {
      fetch: async (input, init) => {
        const read = listed(input) && (!init?.method || init.method === "GET");
        if (read && frozen) return new Response(frozen, { status: 200, headers: { "content-type": "application/json" } });
        const answer = await fetch(input, init);
        if (read) last = await answer.clone().text();
        return answer;
      },
    });
    const runId = `hosted:${thread}`;
    await vi.waitFor(() => expect(bob.threads.holds({ thread })).toBe(true));
    await ada.threads.call("runs.send", { runId, text: "Start", messageId: id(1) });
    await live(bob, thread, "Ada");
    frozen = last;
    stand.endTurn(thread);
    await bob.threads.call("runs.send", { runId, text: "Late", messageId: id(5) });
    frozen = null;
    await vi.waitFor(async () => {
      await (bob.threads as unknown as { refresh(): Promise<void> }).refresh();
      expect((await row(bob, thread)).owner?.collaboration?.queue).toEqual([expect.objectContaining({ messageId: id(5).slice(5), paused: true, canStart: false, canRemove: true })]);
    });
    expect((await row(bob, thread)).activity).toBe("idle");
    expect((await row(bob, thread)).queued.map((each) => each.id)).toEqual([id(5).slice(5)]);
    await expect(bob.threads.call("threads.startQueued", { threadId: thread, messageId: id(5).slice(5) })).rejects.toThrow(words);
    await expect(ada.threads.call("threads.unqueue", { id: thread, messageId: id(5).slice(5) })).rejects.toThrow("Only the sender can change this queued message.");
    await bob.threads.call("threads.unqueue", { id: thread, messageId: id(5).slice(5) });
    expect((await row(bob, thread)).queued).toEqual([]);
  });
});
