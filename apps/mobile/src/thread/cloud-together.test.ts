import type { ThreadCollaboration } from "@openorc/protocol";
import { expect, it } from "vitest";
import { askSeen, askStanding, turnSeen } from "./cloud-together";

const mara = { id: "u-mara", name: "Mara Okafor", image: null };
const state = (facts: Partial<ThreadCollaboration>): ThreadCollaboration => ({
  viewer: { id: "u-riley", name: "Riley Chen", image: null },
  canWrite: true,
  live: null,
  send: "now",
  handoff: null,
  canPostNote: true,
  canStop: true,
  ask: null,
  queue: [],
  mentions: { unread: false, firstUnreadNoteId: null },
  noteHead: 0,
  ...facts,
});
const ask = (facts: Partial<NonNullable<ThreadCollaboration["ask"]>>): NonNullable<ThreadCollaboration["ask"]> => ({
  id: "ask-1",
  turnId: "turn-1",
  state: "waiting",
  sender: mara,
  answer: "live",
  canDecline: true,
  reason: null,
  ...facts,
});

it("names the turn this screen saw running, and none when it saw none", () => {
  expect(turnSeen(state({ live: { id: "turn-1", sender: mara, startedAt: 0, stopping: false } }))).toEqual({ expectedTurnId: "turn-1" });
  expect(turnSeen(state({}))).toEqual({});
  expect(turnSeen(null)).toEqual({});
});

it("names the ask in the phase this screen saw it, and nothing for an ask it has not seen", () => {
  expect(askSeen(state({ ask: ask({ state: "parked", turnId: "turn-0" }) }), "ask-1")).toEqual({ expectedState: "parked", expectedTurnId: "turn-0" });
  expect(askSeen(state({ ask: ask({}) }), "another-ask")).toEqual({});
  expect(askSeen(null, "ask-1")).toEqual({});
});

it("says who may answer and what answering does, in the server's words where it has them", () => {
  expect(askStanding(null, "ask-1")).toEqual({ answer: true, decline: true, line: null });
  expect(askStanding(state({ ask: ask({ answer: "live" }) }), "ask-1")).toEqual({ answer: true, decline: true, line: null });
  expect(askStanding(state({ ask: ask({ answer: "blocked", canDecline: false, reason: "Mara can answer while this turn is running." }) }), "ask-1")).toEqual({
    answer: false,
    decline: false,
    line: "Mara can answer while this turn is running.",
  });
  expect(askStanding(state({ ask: ask({ state: "parked", answer: "start" }) }), "ask-1").line).toBe("Answering starts your own turn, on your sign-in and hours.");
  // An ask the screen has not caught up with yet waits, rather than be answered unbound.
  expect(askStanding(state({}), "ask-1")).toEqual({ answer: false, decline: false, line: null });
});
