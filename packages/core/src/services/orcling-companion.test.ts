import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { listEvents, runs, threads } from "@openorc/db";
import { CodexAdapter, RunHandle } from "@openorc/agents";
import { defaultOrclingLook, type CorePush, type OrclingDraft } from "@openorc/protocol";
import { createOrclingHost } from "../mcp-host/orcling.js";
import { guardContext } from "../remote/policy.js";
import { OpenOrc } from "../openorc.js";
import { dueWakes, lastDue, wakePrompt } from "./orcling-wakes.js";

let root: string | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

const draft: OrclingDraft = { name: "Pip", look: defaultOrclingLook, settings: { agent: "codex", model: "fixture", effort: null, fastMode: false }, permission: "allow" };
const turn = { agent: "codex" as const, model: "fixture", effort: undefined, attachments: undefined, mode: "act" as const, permissionMode: "autonomous" as const };

/**
 * A core whose Codex process stays open between turns and answers each input with the next scripted reply; an empty one
 * says nothing. `hold` keeps the next answer back until its release is called.
 */
async function fixture() {
  root = await mkdtemp(join(tmpdir(), "openorc-orcling-companion-"));
  const replies: string[] = [];
  const heard: string[] = [];
  const pushes: CorePush[] = [];
  let count = 0;
  let starts = 0;
  let held: Promise<void> = Promise.resolve();
  const hold = () => {
    let release!: () => void;
    held = new Promise<void>((resolve) => (release = resolve));
    return release;
  };
  vi.spyOn(CodexAdapter.prototype, "start").mockImplementation((spec) => {
    starts += 1;
    let finish!: (code: number) => void;
    const done = new Promise<number>((resolve) => (finish = resolve));
    const answer = (input: string) => {
      heard.push(input);
      const reply = () => {
        const text = replies.shift() ?? "";
        count += 1;
        if (text) handle.emit("event", { type: "message.completed", runId: spec.runId, ts: Date.now(), messageId: `reply-${count}`, role: "assistant", text });
        handle.emit("event", { type: "turn.completed", runId: spec.runId, ts: Date.now(), turnId: `turn-${count}`, status: "success", durationMs: 1 });
      };
      setTimeout(() => void held.then(reply), 0);
    };
    const handle = new RunHandle(spec.runId, { send: async (text) => answer(text), interrupt() {}, close: () => finish(0), done });
    setTimeout(() => {
      handle.emit("event", { type: "session.started", runId: spec.runId, ts: Date.now(), agent: "codex", externalSessionId: `session-${spec.runId}`, model: "fixture" });
      answer(spec.prompt);
    }, 0);
    return handle;
  });
  const core = await OpenOrc.create({ dataDir: join(root, "data"), ephemeral: true, transport: { push: (push) => void pushes.push(push) } });
  const environment = core.environment.current();
  vi.spyOn(core.environment, "current").mockReturnValue({ ...environment, binaries: { ...environment.binaries, codex: "/fixture/codex" } });
  vi.spyOn(core.memory, "onRunFinished").mockImplementation(() => {});
  vi.spyOn(core.textGeneration, "title").mockResolvedValue(null);
  const settled = async (threadId: string, turns: number) => {
    await vi.waitFor(() => expect(count).toBe(turns));
    await vi.waitFor(() => expect(core.threads.get(threadId)?.activity).toBe("idle"));
  };
  const notices = () => pushes.filter((push) => push.type === "notify");
  return { core, replies, heard, settled, notices, hold, starts: () => starts };
}

it("an Orcling that wakes with nothing to say leaves its conversation as it was; one that texts marks it and notifies", async () => {
  const { core, replies, settled, notices } = await fixture();
  try {
    const pip = await core.orclings.create(draft);
    replies.push("hi!");
    await core.threads.continueThread(pip.threadId, { ...turn, prompt: "Hello" });
    await settled(pip.threadId, 1);
    core.threads.update(pip.threadId, { seen: true });
    const before = threads.get(core.db, pip.threadId)!;
    const noticed = notices().length;

    replies.push("");
    await core.threads.send(pip.threadId, wakePrompt([{ kind: "startup" }], Date.now()), null, { unprompted: true });
    await settled(pip.threadId, 2);
    expect(threads.get(core.db, pip.threadId)!.lastActivityAt).toBe(before.lastActivityAt);
    expect(core.threads.get(pip.threadId)!.unread).toBe(false);
    expect(notices()).toHaveLength(noticed);

    replies.push("morning! the openorc build went green overnight");
    await core.threads.send(pip.threadId, wakePrompt([{ kind: "startup" }], Date.now()), null, { unprompted: true });
    await settled(pip.threadId, 3);
    expect(core.threads.get(pip.threadId)!.unread).toBe(true);
    expect(notices().at(-1)).toMatchObject({ title: "Pip", body: expect.stringContaining("morning!") });

    // The nudge itself never shows: the transcript holds only what was said.
    const said = runs.listForThread(core.db, pip.threadId).flatMap((run) => listEvents(core.db, run.id, { kinds: ["message.completed"] }));
    expect(said.map((event) => (event.type === "message.completed" ? `${event.role}: ${event.text}` : ""))).toEqual([
      "user: Hello",
      "assistant: hi!",
      "assistant: morning! the openorc build went green overnight",
    ]);
  } finally {
    await core.close();
  }
});

it("hears the person's reactions once, ahead of its next message, and reacts to their newest message itself", async () => {
  const { core, replies, heard, settled } = await fixture();
  try {
    const pip = await core.orclings.create(draft);
    replies.push("found it.\n\nthe cache key skipped the branch");
    await core.threads.continueThread(pip.threadId, { ...turn, prompt: "Why is CI slow?" });
    await settled(pip.threadId, 1);
    const run = runs.listForThread(core.db, pip.threadId)[0]!;

    core.orclings.react({ threadId: pip.threadId, runId: run.id, messageId: "reply-1", part: 1 }, "heart", null);
    expect(core.orclings.reactions(pip.threadId)).toMatchObject([{ messageId: "reply-1", part: 1, orclingId: null, reaction: "heart" }]);
    expect(() => core.orclings.react({ threadId: pip.threadId, runId: run.id, messageId: "nowhere", part: 0 }, "haha", null)).toThrow(/not in this conversation/);

    replies.push("glad that helped");
    await core.threads.continueThread(pip.threadId, { ...turn, prompt: "thanks" });
    await settled(pip.threadId, 2);
    expect(heard.at(-1)).toContain('❤️ on "the cache key skipped the branch"');
    expect(heard.at(-1)).toMatch(/thanks$/);

    const tools = createOrclingHost({
      db: core.db,
      orclings: core.orclings,
      memory: core.memory,
      runs: core.runs,
      threads: core.threads,
      settings: core.settings,
      planLimits: async () => [],
      guard: guardContext(core.db, root!),
      call: (method, params) => core.handle({ type: "rpc", id: 0, method, params }).then((reply) => (reply.type === "rpc.result" ? reply.result : Promise.reject(new Error(reply.message)))),
      send: async () => {
        throw new Error("Not sent in this test.");
      },
      invalidate: () => {},
    }).orcling!;
    expect(await tools.react(run.id, "haha")).toContain('Reacted 😂 to "thanks"');
    const theirs = core.orclings.reactions(pip.threadId).find((reaction) => reaction.orclingId === pip.id)!;
    expect(theirs).toMatchObject({ reaction: "haha", part: 0 });

    replies.push("anytime");
    await core.threads.continueThread(pip.threadId, { ...turn, prompt: "see you" });
    await settled(pip.threadId, 3);
    expect(heard.at(-1)).toBe("see you");
  } finally {
    await core.close();
  }
});

it("wakes once for a check-in time, catches up once on one missed while closed, and never for times before the rule", () => {
  const at = (day: number, hours: number, minutes = 0) => new Date(2026, 10, day, hours, minutes).getTime();
  const nine = { kind: "time" as const, at: "09:00", days: [1, 2, 3, 4, 5] };
  const pip = { wakes: [nine] };
  const key = "time@09:00:12345";
  // Monday 9 November 2026. Saved at 15:00, the morning's 9:00 is before the rule existed.
  expect(dueWakes(pip, new Map([[key, at(9, 15)]]), { now: at(9, 15, 1), opening: false, lastActivityAt: 0 })).toEqual([]);
  expect(dueWakes(pip, new Map([[key, at(9, 15)]]), { now: at(10, 9, 0), opening: false, lastActivityAt: 0 })).toEqual([
    { key, reason: { kind: "time", at: "09:00", dueAt: at(10, 9), missed: false } },
  ]);
  expect(dueWakes(pip, new Map([[key, at(10, 9)]]), { now: at(10, 9, 1), opening: false, lastActivityAt: 0 })).toEqual([]);
  // Closed from Tuesday until Thursday noon: one wake, for Thursday's missed 9:00.
  expect(dueWakes(pip, new Map([[key, at(10, 9)]]), { now: at(12, 12), opening: true, lastActivityAt: 0 })).toEqual([{ key, reason: { kind: "time", at: "09:00", dueAt: at(12, 9), missed: true } }]);
  // Saturday is not one of its days, so Friday's is the latest.
  expect(lastDue(nine, at(14, 10))).toBe(at(13, 9));
  expect(wakePrompt([{ kind: "time", at: "09:00", dueAt: at(12, 9), missed: true }], at(12, 12))).toContain("Your 09:00 check-in was due Thursday 9:00 AM, while OpenOrc was closed.");
});

it("wakes as OpenOrc opens only after a quiet stretch, so restarting the app does not wake it again", () => {
  const hour = 60 * 60_000;
  const now = 100 * hour;
  const pip = { wakes: [{ kind: "startup" as const }] };
  const due = (lastWake: number, lastActivityAt: number, opening = true) => dueWakes(pip, new Map([["startup", lastWake]]), { now, opening, lastActivityAt });
  expect(due(0, now - 7 * hour)).toEqual([{ key: "startup", reason: { kind: "startup" } }]);
  expect(due(0, now - 7 * hour, false)).toEqual([]);
  expect(due(now - hour, now - 7 * hour)).toEqual([]);
  expect(due(0, now - hour)).toEqual([]);
});

it("keeps a wake quiet when its process has to start again, as after a change of permission", async () => {
  const { core, replies, settled, notices, starts } = await fixture();
  try {
    const pip = await core.orclings.create(draft);
    replies.push("hi!");
    await core.threads.continueThread(pip.threadId, { ...turn, prompt: "Hello" });
    await settled(pip.threadId, 1);
    core.threads.update(pip.threadId, { permissionMode: "review", seen: true });
    const before = threads.get(core.db, pip.threadId)!.lastActivityAt;
    const noticed = notices().length;

    replies.push("");
    await core.threads.send(pip.threadId, wakePrompt([{ kind: "startup" }], Date.now()), null, { unprompted: true });
    await settled(pip.threadId, 2);
    expect(starts()).toBe(2);
    expect(threads.get(core.db, pip.threadId)!.lastActivityAt).toBe(before);
    expect(core.threads.get(pip.threadId)!.unread).toBe(false);
    expect(notices()).toHaveLength(noticed);
  } finally {
    await core.close();
  }
});

it("sends a message the person queued during a quiet wake once the wake ends", async () => {
  const { core, replies, heard, settled, hold } = await fixture();
  try {
    const pip = await core.orclings.create(draft);
    replies.push("hi!");
    await core.threads.continueThread(pip.threadId, { ...turn, prompt: "Hello" });
    await settled(pip.threadId, 1);

    replies.push("", "morning to you too");
    const release = hold();
    await core.threads.send(pip.threadId, wakePrompt([{ kind: "startup" }], Date.now()), null, { unprompted: true });
    await core.threads.queue(pip.threadId, "morning", []);
    release();
    await settled(pip.threadId, 3);
    expect(heard.at(-1)).toBe("morning");
    expect(core.threads.get(pip.threadId)!.unread).toBe(true);
  } finally {
    await core.close();
  }
});

it("records a message under the id the window already shows it with, on a new process and on a warm one", async () => {
  const { core, replies, settled } = await fixture();
  try {
    const pip = await core.orclings.create(draft);
    replies.push("hi!", "still here");
    await core.threads.continueThread(pip.threadId, { ...turn, prompt: "Hello", promptMessageId: "user-from-window-1" });
    await settled(pip.threadId, 1);
    const run = runs.listForThread(core.db, pip.threadId).at(-1)!;
    await core.runs.send(run.id, "you there?", { messageId: "user-from-window-2" });
    await settled(pip.threadId, 2);
    const mine = listEvents(core.db, run.id, { kinds: ["message.completed"] }).flatMap((event) => (event.type === "message.completed" && event.role === "user" ? [event.messageId] : []));
    expect(mine).toEqual(["user-from-window-1", "user-from-window-2"]);
  } finally {
    await core.close();
  }
});
