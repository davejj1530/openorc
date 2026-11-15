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

  it("says once who stopped another person's turn, and nothing when a sender stops their own", async () => {
    const lines = async (hosted: Hosted) =>
      (await hosted.threads.call("events.page", { runId, fromTurn: 0 })).events.flatMap((event) => (event.type === "message.completed" && event.role === "system" ? [event.text] : []));
    const { thread, ada, bob, runId } = await shared(true);
    await ada.threads.call("runs.send", { runId, text: "Start", messageId: id(1) });
    await live(bob, thread, "Ada");
    await bob.threads.call("runs.interrupt", { runId });
    await live(ada, thread, null);
    expect(await lines(ada)).toEqual(["Bob stopped Ada's turn."]);
    await ada.threads.call("runs.send", { runId, text: "Again", messageId: id(2) });
    await live(ada, thread, "Ada");
    await ada.threads.call("runs.interrupt", { runId });
    await live(ada, thread, null);
    expect(await lines(ada)).toEqual(["Bob stopped Ada's turn."]);
  });

  it("while a teammate stops a turn, pauses what anyone else sends for its author and runs the stopper's own after it", async () => {
    stand.threadCollaboration.holdStops = true;
    const { thread, ada, bob, runId } = await shared(true);
    await ada.threads.call("runs.send", { runId, text: "Start", messageId: id(1) });
    await live(bob, thread, "Ada");
    await bob.threads.call("runs.interrupt", { runId });
    await ada.threads.call("threads.queue", { id: thread, text: "Ada after", requestKey: id(2) });
    await bob.threads.call("threads.queue", { id: thread, text: "Bob after", requestKey: id(3) });
    const queued = async (hosted: Hosted, n: number) => (await row(hosted, thread)).owner!.collaboration!.queue.find((each) => each.messageId === id(n).slice(5));
    expect(await queued(ada, 2)).toMatchObject({ paused: true, pause: { kind: "stop", message: "Bob stopped the turn this was waiting for." } });
    expect(await queued(bob, 3)).toMatchObject({ paused: false });
    stand.endTurn(thread, "cancelled");
    await live(bob, thread, "Bob");
  });

  it("binds a phone's Stop and Send now to the turn its screen showed, though this Mac's row has moved on", async () => {
    const { thread, ada, bob, runId } = await shared(true);
    await ada.threads.call("runs.send", { runId, text: "Start", messageId: id(1) });
    await live(bob, thread, "Ada");
    const seen = (await row(bob, thread)).owner!.collaboration!.live!.id;
    stand.endTurn(thread);
    await ada.threads.call("runs.send", { runId, text: "Again", messageId: id(8) });
    await vi.waitFor(async () => {
      await (bob.threads as unknown as { refresh(): Promise<void> }).refresh();
      expect((await row(bob, thread)).owner?.collaboration?.live?.id).not.toBe(seen);
    });
    await expect(bob.threads.call("runs.interrupt", { runId, expectedTurnId: seen })).rejects.toThrow("That turn ended. Check the thread before stopping again.");
    await bob.threads.call("runs.send", { runId, text: "Late from the phone", messageId: id(9), expectedTurnId: seen }).catch(() => undefined);
    await live(bob, thread, "Ada");
    const late = stand.sent.find((each) => each.threadId === thread && (each.body as { text?: string }).text === "Late from the phone");
    expect((late?.body as { expectedTurnId?: string } | undefined)?.expectedTurnId).toBe(seen);
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

describe("a teammate's own turn once handoff opens", () => {
  const collaborationOf = async (hosted: Hosted, thread: string) => {
    await (hosted.threads as unknown as { refresh(): Promise<void> }).refresh();
    return (await row(hosted, thread)).owner?.collaboration;
  };
  const start = (threadId: string, n: number) => ({ threadId, prompt: "Mine", agent: "claude", mode: "act", permissionMode: "trusted", messageId: id(n) }) as const;

  it("starts a teammate's own turn when nothing runs, on their own sign-in and hours", async () => {
    const { thread, ada, bob, runId } = await shared(true);
    await ada.threads.call("runs.send", { runId, text: "Start", messageId: id(1) });
    stand.endTurn(thread);
    await bob.threads.call("runs.start", start(thread, 2));
    await live(ada, thread, "Bob");
  });

  it("holds a teammate's new turn behind the previous sender's command, which the teammate may stop", async () => {
    const { thread, ada, bob, runId } = await shared(true);
    stand.threadCollaboration.handoffs.set(thread, { code: "handoff_command", responsible: ADA, commandIds: ["c1"] });
    const words = "Ada's command is still running. Stop it before starting your turn.";
    expect(await collaborationOf(bob, thread)).toMatchObject({ send: "blocked", handoff: { code: "handoff_command", message: words, commandIds: ["c1"], retrySave: false } });
    // The previous sender's own command holds only someone else's turn.
    expect(await collaborationOf(ada, thread)).toMatchObject({ send: "now", handoff: null });
    await expect(bob.threads.call("runs.start", start(thread, 2))).rejects.toThrow(words);
    expect((await row(ada, thread)).queued).toEqual([]);
    await ada.threads.call("runs.send", { runId, text: "Mine", messageId: id(3) });
    await live(bob, thread, "Ada");
    // A running turn takes the teammate's message: no handoff holds a join.
    await expect(bob.threads.call("runs.send", { runId, text: "Join", messageId: id(4) })).resolves.toBeNull();
    stand.endTurn(thread);
    await bob.threads.call("threads.stopCommand", { id: thread, commandId: "c1" });
    expect(await collaborationOf(bob, thread)).toMatchObject({ send: "now", handoff: null });
    await bob.threads.call("runs.start", start(thread, 5));
    await live(ada, thread, "Bob");
  });

  it("pauses a teammate's message whose handoff fails, for them to start once the save is retried", async () => {
    const { thread, ada, bob, runId } = await shared(true);
    await ada.threads.call("runs.send", { runId, text: "Start", messageId: id(1) });
    stand.endTurn(thread);
    stand.threadCollaboration.failNextHandoff = "handoff_save";
    await bob.threads.call("runs.start", start(thread, 2));
    const words = "The thread's work could not be saved. Ada can retry the save.";
    await vi.waitFor(async () => expect(await collaborationOf(bob, thread)).toMatchObject({ live: null, send: "blocked", handoff: { code: "handoff_save", message: words, retrySave: false } }));
    expect((await collaborationOf(bob, thread))?.queue).toEqual([expect.objectContaining({ paused: true, canStart: false, pause: { kind: "handoff", message: words }, task: null })]);
    // Why it waits is its author's to read.
    expect((await collaborationOf(ada, thread))?.queue).toEqual([expect.objectContaining({ paused: true, pause: null, task: null })]);
    // Bob has nothing to press, so the server gives him a note that tags Ada; Ada, who can retry, gets none.
    expect((await collaborationOf(bob, thread))?.handoff?.note).toEqual({
      to: expect.objectContaining({ name: "Ada" }),
      text: "@Ada the thread's work could not be saved. Can you retry the save?",
      mention: { start: 0, end: 4 },
    });
    const [paused] = (await row(bob, thread)).queued;
    expect(await collaborationOf(ada, thread)).toMatchObject({ handoff: { code: "handoff_save", retrySave: true, note: null } });
    await ada.threads.call("threads.retrySave", { threadId: thread });
    // The save is back; the paused message waits for its author, never started by the retry.
    expect(await collaborationOf(bob, thread)).toMatchObject({ handoff: null, live: null, queue: [expect.objectContaining({ paused: true, canStart: true })] });
    await bob.threads.call("threads.startQueued", { threadId: thread, messageId: paused!.id });
    await live(ada, thread, "Bob");
  });
});

describe("answering another sender's ask, bound to the phase the reader saw", () => {
  const command = { kind: "command", toolName: "Bash", input: { command: "pnpm test" }, detail: "Bash: pnpm test" };
  const answerOf = (askId: string) => stand.answered.filter((answer) => answer.askId === askId).map((answer) => answer.body);
  async function asked() {
    const made = await shared(true);
    await made.ada.threads.call("runs.send", { runId: made.runId, text: "Start", messageId: id(1) });
    await live(made.bob, made.thread, "Ada");
    return { ...made, ask: stand.ask(made.thread, command) };
  }
  const parked = async (hosted: Hosted, thread: string) =>
    vi.waitFor(async () => {
      await (hosted.threads as unknown as { refresh(): Promise<void> }).refresh();
      expect((await row(hosted, thread)).owner?.collaboration?.ask?.state).toBe("parked");
    });

  it("leaves a live ask to its turn's sender, and answers it parked as the answerer's own turn", async () => {
    const { thread, bob, runId, ask } = await asked();
    await vi.waitFor(async () => {
      await (bob.threads as unknown as { refresh(): Promise<void> }).refresh();
      expect((await row(bob, thread)).owner?.collaboration?.ask?.state).toBe("waiting");
    });
    await expect(bob.threads.call("approvals.resolve", { runId, approvalId: ask, decision: "allow" })).rejects.toThrow("Ada can answer while this turn is running.");
    stand.endTurn(thread);
    await parked(bob, thread);
    await bob.threads.call("approvals.resolve", { runId, approvalId: ask, decision: "allow" });
    expect(answerOf(ask).at(-1)).toMatchObject({ decision: "allow", expectedState: "parked", expectedTurnId: expect.any(String) });
    await live(bob, thread, "Bob");
  });

  it("closes a parked ask with a bare deny for nothing, and starts the answerer's turn with their words in the same answer", async () => {
    const { thread, bob, runId, ask } = await asked();
    const next = stand.ask(thread, command);
    stand.endTurn(thread);
    await parked(bob, thread);
    await bob.threads.call("approvals.resolve", { runId, approvalId: ask, decision: "deny" });
    expect((await row(bob, thread)).activity).not.toBe("running");
    await vi.waitFor(async () => {
      await (bob.threads as unknown as { refresh(): Promise<void> }).refresh();
      expect((await row(bob, thread)).owner?.collaboration?.ask).toMatchObject({ id: next, state: "parked" });
    });
    await bob.threads.call("approvals.resolve", { runId, approvalId: next, decision: "deny", note: "Run only the export tests" });
    expect(answerOf(next).at(-1)).toMatchObject({ decision: "deny", message: "Run only the export tests", expectedState: "parked" });
    // The words went with the answer, never as a message of their own.
    expect(stand.sent.map((sent) => sent.body["text"])).not.toContain("Run only the export tests");
    await live(bob, thread, "Bob");
  });

  it("answers with the phase a phone saw, though this Mac's row has moved on", async () => {
    const { thread, bob, runId, ask } = await asked();
    const seen = await vi.waitFor(async () => {
      await (bob.threads as unknown as { refresh(): Promise<void> }).refresh();
      const read = (await row(bob, thread)).owner?.collaboration?.ask;
      expect(read?.state).toBe("waiting");
      return read!;
    });
    stand.endTurn(thread);
    await parked(bob, thread);
    await expect(bob.threads.call("approvals.resolve", { runId, approvalId: ask, decision: "allow", expectedState: "waiting", expectedTurnId: seen.turnId })).rejects.toThrow(
      "This request changed. Check it again before answering.",
    );
    expect(answerOf(ask).at(-1)).toMatchObject({ expectedState: "waiting", expectedTurnId: seen.turnId });
  });

  it("refuses an answer whose ask changed since the reader saw it, in the server's words", async () => {
    let frozen: string | null = null;
    let last: string | null = null;
    const listed = (input: unknown) => new URL(String(input)).pathname === "/hosted/threads";
    stand.threadCollaboration.sharedWrites = true;
    const team = stand.addTeam("Altalogy", [ADA, BOB]);
    const project = stand.addProject(ADA, { name: "openorc", fullName: "altalogy/openorc" }, team);
    for (const email of [ADA, BOB]) {
      stand.setBilling(email, pro);
      stand.setSignIns(email, [{ agent: "claude" }]);
    }
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
    const ask = stand.ask(thread, command);
    await vi.waitFor(async () => {
      await (bob.threads as unknown as { refresh(): Promise<void> }).refresh();
      expect((await row(bob, thread)).owner?.collaboration?.ask?.state).toBe("waiting");
    });
    frozen = last;
    stand.endTurn(thread);
    await expect(bob.threads.call("approvals.resolve", { runId, approvalId: ask, decision: "allow" })).rejects.toThrow("This request changed. Check it again before answering.");
    expect(answerOf(ask).at(-1)).toMatchObject({ expectedState: "waiting" });
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
