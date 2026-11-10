import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { listEvents, orclingMessages, runs, threads } from "@openorc/db";
import { CodexAdapter, RunHandle } from "@openorc/agents";
import { defaultOrclingLook, WORKSPACE_ID, type OrclingDraft } from "@openorc/protocol";
import { createOrclingHost } from "../mcp-host/orcling.js";
import { guardContext } from "../remote/policy.js";
import { OpenOrc } from "../openorc.js";
import { GROUP_TURNS, ORCLING_MESSAGE_CHAIN, namedIn } from "./orcling-talk.js";

let root: string | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

const draft = (name: string): OrclingDraft => ({ name, look: defaultOrclingLook, settings: { agent: "codex", model: "fixture", effort: null, fastMode: false }, permission: "allow" });
const turn = { agent: "codex" as const, model: "fixture", effort: undefined, attachments: undefined, mode: "act" as const, permissionMode: "autonomous" as const };

/**
 * A core whose Codex processes answer as the Orcling their instructions name: each Orcling's next scripted reply, or
 * nothing. Every input is kept with who read it and what it was told on launch.
 */
async function fixture() {
  root = await mkdtemp(join(tmpdir(), "openorc-orcling-talk-"));
  const replies = new Map<string, string[]>();
  const heard: { who: string; input: string; handoff: string }[] = [];
  let turns = 0;
  vi.spyOn(CodexAdapter.prototype, "start").mockImplementation((spec) => {
    const who = /^# You are (.+)$/m.exec(spec.systemPromptAppendix ?? "")?.[1] ?? "agent";
    let finish!: (code: number) => void;
    const done = new Promise<number>((resolve) => (finish = resolve));
    const answer = (input: string) => {
      heard.push({ who, input, handoff: spec.systemPromptAppendix ?? "" });
      setTimeout(() => {
        const text = replies.get(who)?.shift() ?? "";
        turns += 1;
        if (text) handle.emit("event", { type: "message.completed", runId: spec.runId, ts: Date.now(), messageId: `reply-${turns}`, role: "assistant", text });
        handle.emit("event", { type: "turn.completed", runId: spec.runId, ts: Date.now(), turnId: `turn-${turns}`, status: "success", durationMs: 1 });
      }, 0);
    };
    const handle = new RunHandle(spec.runId, { send: async (text) => answer(text), interrupt() {}, close: () => finish(0), done });
    setTimeout(() => {
      handle.emit("event", { type: "session.started", runId: spec.runId, ts: Date.now(), agent: "codex", externalSessionId: `session-${spec.runId}`, model: "fixture" });
      answer(spec.prompt);
    }, 0);
    return handle;
  });
  const core = await OpenOrc.create({ dataDir: join(root, "data"), ephemeral: true, transport: { push() {} } });
  const environment = core.environment.current();
  vi.spyOn(core.environment, "current").mockReturnValue({ ...environment, binaries: { ...environment.binaries, codex: "/fixture/codex" } });
  vi.spyOn(core.memory, "onRunFinished").mockImplementation(() => {});
  vi.spyOn(core.textGeneration, "title").mockResolvedValue(null);
  const say = (who: string, ...texts: string[]) => replies.set(who, [...(replies.get(who) ?? []), ...texts]);
  const settled = async (threadId: string, count: number) => {
    await vi.waitFor(() => expect(turns).toBe(count), { timeout: 5000 });
    await vi.waitFor(() => expect(core.threads.get(threadId)?.activity).toBe("idle"));
  };
  const host = () =>
    createOrclingHost({
      db: core.db,
      orclings: core.orclings,
      memory: core.memory,
      runs: core.runs,
      threads: core.threads,
      settings: core.settings,
      send: async () => ({ delivered: false, message: "Not used here." }),
      planLimits: async () => [],
      guard: guardContext(core.db, root!),
      call: (method, params) => core.handle({ type: "rpc", id: 0, method, params }).then((reply) => (reply.type === "rpc.result" ? reply.result : Promise.reject(new Error(reply.message)))),
      invalidate: () => {},
    }).orcling!;
  const said = (threadId: string) =>
    runs
      .listForThread(core.db, threadId)
      .flatMap((run) => listEvents(core.db, run.id, { kinds: ["message.completed"] }).flatMap((event) => (event.type === "message.completed" ? [`${event.role}: ${event.text}`] : [])));
  return { core, say, heard, settled, host, said, turns: () => turns };
}

it("names Orclings by name or @mention, in the order a message names them", () => {
  const pip = { id: "pip", name: "Pip" };
  const bo = { id: "bo", name: "Bo" };
  expect(namedIn("@bo can you check? Pip already did", [pip, bo])).toEqual(["bo", "pip"]);
  expect(namedIn("bonjour, piper", [pip, bo])).toEqual([]);
});

it("delivers a direct message into the other Orcling's own chat as the sender's, quietly unless it answers the person", async () => {
  const { core, say, heard, settled, host, said } = await fixture();
  try {
    const pip = await core.orclings.create(draft("Pip"));
    const bo = await core.orclings.create(draft("Bo"));
    say("Pip", "on it");
    await core.threads.continueThread(pip.threadId, { ...turn, prompt: "ask Bo about the review" });
    await settled(pip.threadId, 1);
    const pipRun = runs.listForThread(core.db, pip.threadId)[0]!;

    expect(JSON.parse(await host().orclings(pipRun.id))).toEqual({ orclings: [{ name: "Bo", busy: false }], groups: [] });
    expect(await host().message(pipRun.id, { to: "bo", text: "is the review done?" })).toContain('"delivered":true');
    await settled(bo.threadId, 2);

    expect(heard.at(-1)).toMatchObject({ who: "Bo" });
    expect(heard.at(-1)!.input).toMatch(/^\(OpenOrc: the next message is from Pip, another of the person's Orclings/);
    expect(heard.at(-1)!.input).toMatch(/is the review done\?$/);
    expect(said(bo.threadId)).toEqual(["system: is the review done?"]);
    expect(orclingMessages.list(core.db, bo.threadId)).toMatchObject([{ fromOrclingId: pip.id, toOrclingId: bo.id }]);
    // Bo said nothing to the person, so its chat is not marked for them.
    expect(core.threads.get(bo.threadId)!.unread).toBe(false);
  } finally {
    await core.close();
  }
});

it("stops Orclings texting each other after a few in a row until the person writes", async () => {
  const { core, settled, host, turns } = await fixture();
  try {
    const pip = await core.orclings.create(draft("Pip"));
    const bo = await core.orclings.create(draft("Bo"));
    await core.threads.continueThread(pip.threadId, { ...turn, prompt: "hi" });
    await settled(pip.threadId, 1);
    await core.threads.continueThread(bo.threadId, { ...turn, prompt: "hi" });
    await settled(bo.threadId, 2);
    const pipRun = runs.listForThread(core.db, pip.threadId)[0]!;
    const boRun = runs.listForThread(core.db, bo.threadId)[0]!;
    for (let hop = 1; hop <= ORCLING_MESSAGE_CHAIN; hop++) {
      const [from, to, home] = hop % 2 ? [pipRun, "Bo", bo.threadId] : [boRun, "Pip", pip.threadId];
      await host().message(from.id, { to, text: `message ${hop}` });
      await settled(home, 2 + hop);
    }
    await expect(host().message(pipRun.id, { to: "Bo", text: "one more" })).rejects.toThrow(/Wait until the person writes/);
    expect(turns()).toBe(2 + ORCLING_MESSAGE_CHAIN);
  } finally {
    await core.close();
  }
});

it("lets the Orclings a group message names answer in turn, each hearing the others, and the person's names choose who", async () => {
  const { core, say, heard, settled, said } = await fixture();
  try {
    const pip = await core.orclings.create(draft("Pip"));
    const bo = await core.orclings.create(draft("Bo"));
    const group = await core.orclings.talk.createGroup([pip.id, bo.id], undefined, null);
    expect(group).toMatchObject({ title: "Pip and Bo", memberIds: [pip.id, bo.id] });
    expect(threads.get(core.db, group.threadId)).toMatchObject({ projectId: WORKSPACE_ID, orclingId: null });

    say("Pip", "found the flaky test");
    say("Bo", "nice, I'll rerun CI");
    await core.orclings.talk.sendToGroup(group.threadId, "morning both", { messageId: "user-1" });
    await settled(group.threadId, 2);
    expect(heard.map((entry) => entry.who)).toEqual(["Pip", "Bo"]);
    expect(heard[0]!.input).toBe("morning both");
    expect(heard[0]!.handoff).toContain("This is a group chat between the person and Orclings: you, Bo.");
    // Bo's turn opens with what was said since it last spoke, as messages it reads, not background in its instructions.
    expect(heard[1]!.input).toMatch(/^\(OpenOrc, the group chat\. This conversation began before you joined\./);
    expect(heard[1]!.input).toContain("The person: morning both");
    expect(heard[1]!.input).toContain("Pip: found the flaky test");
    expect(heard[1]!.input).toMatch(/your turn in the group chat\. Answer if you have something to add; otherwise reply with only NO_REPLY/);
    expect(heard[1]!.handoff).not.toContain("The person: morning both");
    expect(said(group.threadId)).toEqual(["user: morning both", "assistant: found the flaky test", "assistant: nice, I'll rerun CI"]);

    say("Bo", "on it");
    await core.orclings.talk.sendToGroup(group.threadId, "@Bo can you rerun it now?", {});
    await settled(group.threadId, 3);
    expect(heard.at(-1)!.who).toBe("Bo");
  } finally {
    await core.close();
  }
});

it("gives an Orcling its turn when another names it in the group, until the group waits for the person", async () => {
  const { core, say, heard, settled } = await fixture();
  try {
    const pip = await core.orclings.create(draft("Pip"));
    const bo = await core.orclings.create(draft("Bo"));
    const group = await core.orclings.talk.createGroup([pip.id, bo.id], "Release", null);
    say("Pip", ...Array.from({ length: 10 }, (_, i) => `Bo, round ${i}?`));
    say("Bo", ...Array.from({ length: 10 }, (_, i) => `Pip, round ${i}!`));
    await core.orclings.talk.sendToGroup(group.threadId, "Pip, start", {});
    await settled(group.threadId, GROUP_TURNS);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(heard.map((entry) => entry.who)).toEqual(Array.from({ length: GROUP_TURNS }, (_, i) => (i % 2 ? "Bo" : "Pip")));
  } finally {
    await core.close();
  }
});

it("keeps each Orcling's own chat and each group to themselves: other Orclings and agents cannot read or message into them", async () => {
  const { core, settled } = await fixture();
  try {
    const pip = await core.orclings.create(draft("Pip"));
    const bo = await core.orclings.create(draft("Bo"));
    const rini = await core.orclings.create(draft("Rini"));
    const group = await core.orclings.talk.createGroup([pip.id, bo.id], undefined, null);
    await core.threads.continueThread(pip.threadId, { ...turn, prompt: "hi" });
    await settled(pip.threadId, 1);
    await core.threads.continueThread(rini.threadId, { ...turn, prompt: "hi" });
    await settled(rini.threadId, 2);
    const pipRun = runs.listForThread(core.db, pip.threadId)[0]!;
    const riniRun = runs.listForThread(core.db, rini.threadId)[0]!;

    expect(await core.threads.toolThreadRead(pipRun.id, bo.threadId, 5)).toBeNull();
    expect(await core.threads.toolThreadSend(pipRun.id, bo.threadId, "psst")).toMatchObject({ delivered: false });
    expect(await core.threads.toolThreadRead(pipRun.id, group.threadId, 5)).not.toBeNull();
    expect(await core.threads.toolThreadRead(riniRun.id, group.threadId, 5)).toBeNull();
    // Lists a phone pages through leave group chats out, as they do Orclings' own chats.
    const listed = core.threads.list({ projectIds: [WORKSPACE_ID], includeChildren: true }).map((thread) => thread.id);
    expect(listed).not.toContain(group.threadId);
    expect(listed).not.toContain(pip.threadId);
  } finally {
    await core.close();
  }
});

it("takes a deleted Orcling out of its group chats: a group left with one other goes, a named one takes the names of those left", async () => {
  const { core } = await fixture();
  try {
    const pip = await core.orclings.create(draft("Pip"));
    const bo = await core.orclings.create(draft("Bo"));
    const rini = await core.orclings.create(draft("Rini"));
    const pair = await core.orclings.talk.createGroup([pip.id, bo.id], undefined, null);
    const trio = await core.orclings.talk.createGroup([pip.id, bo.id, rini.id], undefined, null);
    const titled = await core.orclings.talk.createGroup([pip.id, bo.id, rini.id], "Release", null);

    await core.orclings.delete(bo.id);

    const left = new Map(core.orclings.talk.groupsList().map((group) => [group.threadId, group]));
    expect([...left.keys()].sort()).toEqual([trio.threadId, titled.threadId].sort());
    expect(threads.get(core.db, pair.threadId)).toBeNull();
    expect(left.get(trio.threadId)).toMatchObject({ title: "Pip and Rini", memberIds: [pip.id, rini.id] });
    expect(left.get(titled.threadId)).toMatchObject({ title: "Release", memberIds: [pip.id, rini.id] });
  } finally {
    await core.close();
  }
});

it("tells an Orcling who named it and what they said, and lets one with nothing to add pass without a word reaching anyone", async () => {
  const { core, say, heard, settled, said } = await fixture();
  try {
    const autumn = await core.orclings.create(draft("Autumn"));
    const vision = await core.orclings.create(draft("Vision"));
    const group = await core.orclings.talk.createGroup([autumn.id, vision.id], undefined, null);
    say("Autumn", "Vision, quick catch-up: the cloud login is a pasted token, and we want a vault sandbox instead.");
    say("Vision", "NO_REPLY");
    await core.orclings.talk.sendToGroup(group.threadId, "@Autumn explain our problem to the team", {});
    await settled(group.threadId, 2);
    // Vision read Autumn's words in its turn, and that Autumn named it.
    const turn = heard.at(-1)!;
    expect(turn.who).toBe("Vision");
    expect(turn.input).toContain("The person: @Autumn explain our problem to the team");
    expect(turn.input).toContain("Autumn: Vision, quick catch-up: the cloud login is a pasted token");
    expect(turn.input).toMatch(/Autumn named you in what they just said, so answer them/);
    // Its quiet reply was dropped: never recorded, never shown.
    expect(said(group.threadId)).toEqual([
      "user: @Autumn explain our problem to the team",
      "assistant: Vision, quick catch-up: the cloud login is a pasted token, and we want a vault sandbox instead.",
    ]);
  } finally {
    await core.close();
  }
});
