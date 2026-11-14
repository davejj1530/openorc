import type { ThreadCollaboration, ThreadPerson, ThreadSummary } from "@openorc/protocol";
import { describe, expect, it } from "vitest";
import { askAnswerBlock, canStopTurn, personFirst, personName, queuedBy, sendPayer, threadWriteBlock, togetherActivity, withOthers, writesAsCreator } from "./thread-collaboration.js";
import { asksBlocked, queueBlock, sendsBlocked } from "./hosted-send.js";
import { sendCluster } from "./conversation-submit.js";
import { rowFacts, threadActivity, threadWaitsOnYou } from "./thread-row.js";
import { composerPlaceholder } from "./composer-presentation.js";

const MARA: ThreadPerson = { id: "u-mara", name: "Mara Okafor", image: null };
const THEO: ThreadPerson = { id: "u-theo", name: "Theo Laurent", image: null };

/** Today's server: shared writing closed for everyone, the reader named. */
function together(viewer: ThreadPerson, more: Partial<ThreadCollaboration> = {}): ThreadCollaboration {
  return {
    viewer,
    canWrite: false,
    live: null,
    send: "blocked",
    handoff: null,
    canPostNote: false,
    canStop: false,
    ask: null,
    queue: [],
    mentions: { unread: false, firstUnreadNoteId: null },
    noteHead: 0,
    ...more,
  };
}

type Row = Pick<ThreadSummary, "owner" | "activity">;
const row = (collaboration: ThreadCollaboration | undefined, activity: ThreadSummary["activity"] = "idle", startedBy?: { name: string; image: null }): Row => ({
  activity,
  owner: { brain: "hosted", reach: "live", heardAt: 0, ...(startedBy && { startedBy }), ...(collaboration && { collaboration }) },
});
const live = (sender: ThreadPerson | null) => ({ id: "turn-1", sender, startedAt: 0, stopping: false });
const ask = (sender: ThreadPerson | null, state: "waiting" | "parked", answer: "live" | "start" | "blocked", reason: string | null = null) => ({
  id: "ask-1",
  turnId: "turn-1",
  state,
  sender,
  answer,
  canDecline: answer !== "blocked",
  reason,
});

describe("a cloud thread nobody else is in", () => {
  it("reads as it always did: no names, today's words, and the creator writes and answers", () => {
    const own = row(together(THEO, { live: live(THEO) }), "running");
    expect(withOthers(own)).toBe(false);
    expect(writesAsCreator(own)).toBe(true);
    expect(togetherActivity(own)).toBeNull();
    expect(threadActivity(own)).toEqual({ text: "Working", tone: "live" });
    expect(threadWriteBlock(own)).toBeNull();
    expect(sendsBlocked(own)).toBeNull();
    const parked = row(together(THEO, { ask: ask(THEO, "parked", "blocked") }), "waiting");
    expect(threadActivity(parked)).toEqual({ text: "Needs you", tone: "attention" });
    expect(threadWaitsOnYou(parked)).toBe(true);
    expect(asksBlocked(parked)).toBeNull();
    expect(
      rowFacts({ ...parked, lastActivityAt: 0, lastAgentEventAt: null, workspaceMode: "worktree", branch: "b", cloud: null, workingDirectory: null, prUrl: null, prState: null }, { now: 0 }).detail,
    ).not.toContain("Waiting");
  });
});

describe("a teammate's cloud thread on today's server", () => {
  const mara = { name: "Mara Okafor", image: null };

  it("names whose turn and whose ask it is, and keeps a teammate's ask from calling the reader", () => {
    const running = row(together(THEO, { live: live(MARA) }), "running", mara);
    expect(threadActivity(running)).toEqual({ text: "Mara's turn", tone: "live" });
    const waiting = row(together(THEO, { ask: ask(MARA, "waiting", "blocked", "Mara Okafor can answer while this turn is running.") }), "waiting", mara);
    expect(threadActivity(waiting)).toEqual({ text: "Waiting on Mara", tone: "muted" });
    expect(threadWaitsOnYou(waiting)).toBe(false);
    expect(asksBlocked(waiting)).toBe("Mara Okafor can answer while this turn is running.");
    const parked = row(together(THEO, { ask: ask(MARA, "parked", "blocked") }), "waiting", mara);
    expect(threadActivity(parked)).toEqual({ text: "Waiting for an answer", tone: "muted" });
    expect(asksBlocked(parked)).toBe("Only Mara can run the agent in this cloud thread for now.");
  });

  it("blocks the composer in the designed words, not the old fixed sentence, and reads the server's block first", () => {
    const blocked = row(together(THEO, { live: live(MARA) }), "running", mara);
    expect(writesAsCreator(blocked)).toBe(false);
    expect(sendsBlocked(blocked)).toBe("Only Mara can run the agent in this cloud thread for now.");
    const handoff = { code: "handoff_command" as const, message: "Mara's command is still running. Stop it before starting your turn.", responsible: MARA, commandIds: ["c1"], retrySave: false };
    expect(threadWriteBlock(row(together(THEO, { canWrite: true, send: "blocked", handoff }), "idle", mara))).toBe(handoff.message);
    expect(sendsBlocked({ owner: { ...blocked.owner!, reach: "offline" } })).toBe("OpenOrc Cloud can't be reached.");
  });

  it("lights up without another change once the server opens shared writing", () => {
    const open = row(together(THEO, { canWrite: true, send: "now", canStop: true, live: live(MARA) }), "running", mara);
    expect(sendsBlocked(open)).toBeNull();
    expect(composerPlaceholder("codex", open)).toBe("Message Codex…");
    expect(composerPlaceholder("codex", row(together(THEO), "idle", mara))).toBe("Mara's thread");
    expect(threadActivity(open)).toEqual({ text: "Mara's turn", tone: "live" });
    const parked = row(together(THEO, { canWrite: true, send: "now", ask: ask(MARA, "parked", "start") }), "waiting", mara);
    expect(asksBlocked(parked)).toBeNull();
    expect(askAnswerBlock(parked)).toBeNull();
  });

  it("names the reader's own turn as theirs inside someone else's thread", () => {
    expect(threadActivity(row(together(THEO, { canWrite: true, send: "now", live: live(THEO) }), "running", mara))).toEqual({ text: "Your turn", tone: "live" });
  });

  it("names the reader's own live ask as theirs inside someone else's thread", () => {
    const mine = row(together(THEO, { canWrite: true, send: "now", ask: ask(THEO, "waiting", "live") }), "waiting", mara);
    expect(threadActivity(mine)).toEqual({ text: "Needs your answer", tone: "attention" });
    expect(threadWaitsOnYou(mine)).toBe(true);
  });

  it("appends whose turn it is to the row's hover words", () => {
    const running = row(together(THEO, { live: live(MARA) }), "running", mara);
    const facts = rowFacts(
      { ...running, lastActivityAt: 0, lastAgentEventAt: null, workspaceMode: "worktree", branch: "export-activity", cloud: null, workingDirectory: null, prUrl: null, prState: null },
      { now: 0 },
    );
    expect(facts.detail).toBe("now · Mara Okafor · OpenOrc Cloud · export-activity · Mara's turn");
  });
});

describe("people in a thread", () => {
  it("counts a teammate in the reader's own thread through the live turn or the queue, and a former member as someone", () => {
    expect(withOthers(row(together(THEO, { queue: [{ messageId: "m1", author: MARA, paused: false, canEdit: false, canRemove: false, canStart: false }] })))).toBe(true);
    expect(withOthers(row(together(THEO, { live: live(null) }), "running"))).toBe(true);
    expect(threadActivity(row(together(THEO, { live: live(null) }), "running"))).toEqual({ text: "Working", tone: "live" });
    expect(threadActivity(row(together(THEO, { ask: ask(null, "waiting", "blocked") }), "waiting"))).toEqual({ text: "Waiting for an answer", tone: "muted" });
  });

  it("names people, former members included, and reads queue rights from the server", () => {
    expect([personName(MARA), personFirst(MARA), personName(null), personFirst(null)]).toEqual(["Mara Okafor", "Mara", "Former member", "Former member"]);
    const thread = row(together(THEO, { queue: [{ messageId: "m1", author: MARA, paused: false, canEdit: false, canRemove: false, canStart: false }] }));
    expect(queuedBy(thread, "m1")).toEqual({ author: MARA, canEdit: false, canRemove: false, paused: false, canStart: false });
    expect(queuedBy(thread, "m2")).toBeNull();
  });

  it("keeps an older server's teammate view", () => {
    const old = row(undefined, "waiting", { name: "Mara Okafor", image: null });
    expect(threadActivity(old)).toEqual({ text: "Waiting on Mara", tone: "muted" });
    expect(sendsBlocked(old)).toBe("Only Mara can make changes in Mara's thread.");
    expect(asksBlocked(old)).toBe("Only Mara can answer in Mara's thread.");
  });
});

describe("sending, queueing and stopping in a shared thread", () => {
  const mara = { name: "Mara Okafor", image: null };
  const open = (more: Partial<ThreadCollaboration> = {}) => together(THEO, { canWrite: true, send: "now", canStop: true, ...more });
  const free = { state: "signed-in", reach: "live", plan: { pro: false }, hours: null, signIns: [], projects: [] } as unknown as Parameters<typeof queueBlock>[1];

  it("says on demand whose sign-in and hours each way uses during a teammate's turn, never inferring a pronoun", () => {
    expect(sendPayer(row(open({ live: live(MARA) }), "running", mara))).toEqual({
      now: "Joins Mara's turn, on their sign-in and hours.",
      queue: "After Mara's turn, using your sign-in and hours.",
      send: null,
      stop: "Stop Mara's turn",
    });
    expect(sendPayer(row(open(), "idle", mara))).toEqual({ now: null, queue: null, send: "Uses your sign-in and hours.", stop: null });
    expect(sendPayer(row(open({ live: live(THEO) }), "running", mara))).toBeNull();
    expect(sendPayer(row(together(THEO, { live: live(MARA) }), "running", mara))).toBeNull();
    expect(sendPayer(row(together(THEO), "idle"))).toBeNull();
  });

  it("refuses Queue without the reader's own hours or sign-in, while Send now into the running turn stays open", () => {
    const running = row(open({ live: live(MARA) }), "running", mara);
    expect(queueBlock(running, free, { agent: "claude", model: null })).toBeTruthy();
    expect(queueBlock(row(open({ live: live(THEO) }), "running", mara), free, { agent: "claude", model: null })).toBeNull();
    expect(sendCluster({ queueing: true, liveByDefault: true, steerable: true, canStop: true, hasDraft: true, queueBlocked: "You need Pro." })).toEqual({
      kind: "turn",
      stop: true,
      enter: "now",
      other: { way: "queue", blocked: "You need Pro." },
    });
  });

  it("lets the server decide who stops, keeping the creator on today's rule", () => {
    expect(canStopTurn(row(open({ live: live(MARA), canStop: false }), "running", mara))).toBe(false);
    expect(canStopTurn(row(open({ live: live(MARA) }), "running", mara))).toBe(true);
    expect(canStopTurn(row(together(THEO, { live: live(THEO) }), "running"))).toBeUndefined();
  });

  it("reads a paused message and whether its author may start it", () => {
    const paused = row(open({ queue: [{ messageId: "m1", author: THEO, paused: true, canEdit: true, canRemove: true, canStart: true }] }), "idle", mara);
    expect(queuedBy(paused, "m1")).toMatchObject({ paused: true, canStart: true });
  });
});
