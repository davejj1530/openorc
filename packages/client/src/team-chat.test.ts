import { describe, expect, it } from "vitest";
import type { TeamChatState, TeamMessage } from "@openorc/protocol";
import { mergeTeamMessages, teamChatRoster, TeamChatGeneration } from "./team-chat.js";

const message = (id: string, seq: number): TeamMessage => ({
  id,
  seq,
  channelId: "general",
  actor: { kind: "person", person: { id: "other", name: "Morgan", image: null } },
  body: id,
  files: [],
  reactions: [],
  call: null,
  createdAt: "2026-01-01T00:00:00Z",
});

describe("team chat delivery", () => {
  it("reconciles a lost send reply, a live arrival and a retry as one message", () => {
    const sent = message("message-one", 1);
    const live = mergeTeamMessages([], [sent]);
    expect(mergeTeamMessages(live, [sent, sent])).toEqual([sent]);
  });
  it("orders simultaneous timestamps by committed sequence and replaces reactions", () => {
    const first = message("first", 1);
    const updated = { ...first, reactions: [{ emoji: "👍", userIds: ["other"] }] };
    expect(mergeTeamMessages([message("last", 2), first], [updated])).toEqual([updated, message("last", 2)]);
  });
  it("rejects a response after another account or space is selected", () => {
    const generation = new TeamChatGeneration();
    generation.enter({ accountId: "first", spaceId: "team" });
    const first = generation.capture();
    generation.enter({ accountId: "first", spaceId: "another-team" });
    expect(generation.accepts(first)).toBe(false);
    const second = generation.capture();
    generation.enter({ accountId: "second", spaceId: "another-team" });
    expect(generation.accepts(second)).toBe(false);
  });
  it("rejects an old response after freeze or access loss, including after recovery", () => {
    const generation = new TeamChatGeneration();
    const scope = { accountId: "person", spaceId: "team" };
    generation.enter(scope);
    const before = generation.capture();
    generation.invalidate();
    generation.enter(scope);
    expect(generation.accepts(before)).toBe(false);
    expect(generation.accepts(generation.capture())).toBe(true);
  });
});

it("lists every other teammate before a direct message exists, without exposing later features", () => {
  const state: TeamChatState = {
    features: ["base"],
    people: [
      { id: "self", name: "Alex", image: null },
      { id: "b", name: "Zora", image: null },
      { id: "a", name: "Bea", image: null },
    ],
    conversations: [],
  };
  expect(teamChatRoster(state, "self").map((row) => row.title)).toEqual(["Bea", "Zora"]);
});
