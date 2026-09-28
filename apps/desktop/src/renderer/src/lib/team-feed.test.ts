import { describe, expect, it } from "vitest";
import type { TeamActorView, TeamChatEntry, TeamExecutionView } from "@openorc/protocol";
import { teamFeed, teamWorkingStatus, type TeamFeedItem } from "./team-feed";
import type { TeamContextCheckpoint } from "./team-context";

function actor(
  id: string,
  createdAt: number,
  entries: { id: string; startedAt: number; endedAt?: number | null; turnId?: string; turn?: number; reason?: TeamActorView["runs"][number]["reason"] }[],
  extra: Partial<TeamActorView> = {},
): TeamActorView {
  const runs = entries.map((entry) => ({ ...entry, turnId: entry.turnId ?? `turn-${entry.id}`, turn: entry.turn ?? 0 }));
  return {
    id,
    memberKey: id.replace("member:", ""),
    taskId: null,
    parentId: "lead",
    title: id,
    createdAt,
    state: "waiting",
    settings: { agent: "codex", model: "same-model", effort: "medium", fastMode: false },
    runs,
    runIds: [...new Set(runs.map((run) => run.id))],
    activeRunId: null,
    error: null,
    result: null,
    retry: { allowed: false, reason: null },
    workspace: null,
    participant: true,
    ...extra,
  };
}
function chat(id: string, senderId: string, createdAt: number, text = id): TeamChatEntry {
  return { id, senderId, senderName: senderId, text, attachments: [], createdAt, to: [{ actorId: "member:mark", name: "Mark", state: "delivered" }] };
}
function execution(): TeamExecutionView {
  return {
    id: "execution",
    state: "active",
    generation: 1,
    createdAt: 100,
    updatedAt: 900,
    error: null,
    activity: "working",
    initialPrompt: { text: "Build it", attachments: [], createdAt: 100 },
    publications: [],
    userDirections: [
      { id: "queued", text: "Queued for the lead", createdAt: 250, state: "pending" },
      { id: "live", text: "Said mid-turn", createdAt: 320, state: "claimed", live: { runId: "lead-2", state: "accepted" } },
    ],
    chat: [chat("chat-user", "user", 400, "@Mark status?"), chat("chat-mark", "member:mark", 460, "On it")],
    actors: [
      actor(
        "lead",
        100,
        [
          { id: "lead-1", startedAt: 110 },
          { id: "lead-2", startedAt: 300 },
        ],
        { parentId: null, participant: undefined },
      ),
      actor("member:mark", 100, [
        { id: "mark-1", startedAt: 410 },
        { id: "mark-2", startedAt: 470 },
      ]),
      actor("member:melo", 100, []),
    ],
  };
}
const shape = (items: TeamFeedItem[]) =>
  items.map((item) => {
    switch (item.kind) {
      case "prompt":
        return "prompt";
      case "direction":
        return `direction:${item.direction.id}`;
      case "chat":
        return `chat:${item.entry.id}${item.continued ? "+" : ""}`;
      case "turn":
        return `turn:${item.runId}${item.continued ? "+" : ""}${item.last ? "!" : ""}`;
      case "checkpoint":
        return `checkpoint:${item.checkpoint.id}`;
      case "assignment":
        return `assignment:${item.actor.id}`;
    }
  });

describe("team feed", () => {
  it("skips the prompt when the core says the opening message is a chat entry", () => {
    const data = execution();
    data.chat = [chat("opening", "user", 101, "Build it")];
    expect(shape(teamFeed(data))[0]).toBe("prompt");
    data.initialPrompt.chatId = "opening";
    expect(shape(teamFeed(data))[0]).toBe("chat:opening");
  });

  it("places isolated assignments in the feed and leaves nested ones to their manager card", () => {
    const data = execution();
    const assignment = actor("worker", 200, [{ id: "worker-1", startedAt: 210 }], { taskId: "task-1", participant: undefined });
    const nested = actor("nested", 220, [], { taskId: "task-2", parentId: "worker", participant: undefined });
    data.actors.push(assignment, nested);
    const items = shape(teamFeed(data));
    expect(items).toContain("assignment:worker");
    expect(items).not.toContain("assignment:nested");
    expect(items).not.toContain("turn:worker-1");
  });

  it("keeps turn order from an older projection without run timestamps and places member checkpoints by time", () => {
    const older: TeamExecutionView = JSON.parse(JSON.stringify(execution(), (key, value) => (key === "runs" ? undefined : value)));
    const turns = shape(teamFeed(older)).filter((item) => item.startsWith("turn:"));
    expect(turns).toEqual(["turn:lead-1", "turn:lead-2+!", "turn:mark-1", "turn:mark-2+!"]);
    const checkpoint: TeamContextCheckpoint = { id: "cp", actorId: "member:mark", executionId: "execution", reason: "fresh_retry", createdAt: 465 };
    const compact: TeamContextCheckpoint = { ...checkpoint, id: "compact", reason: "compact" };
    const items = shape(teamFeed(execution(), [checkpoint, compact]));
    expect(items.indexOf("checkpoint:cp")).toBe(items.indexOf("chat:chat-mark+") + 1);
    expect(items).not.toContain("checkpoint:compact");
  });

  it("shows a member's consecutive turns on one process as separate turns, in order", () => {
    const warm = execution();
    warm.actors[1] = actor("member:mark", 100, [
      { id: "mark-1", turnId: "turn-a", turn: 0, startedAt: 410 },
      { id: "mark-1", turnId: "turn-b", turn: 1, startedAt: 470 },
    ]);
    const items = teamFeed(warm).filter((item) => item.kind === "turn" && item.actor.id === "member:mark");
    expect(items.map((item) => (item.kind === "turn" ? [item.turnId, item.turn, item.runId, item.continued, item.last] : null))).toEqual([
      ["turn-a", 0, "mark-1", false, false],
      ["turn-b", 1, "mark-1", true, true],
    ]);
    // One process, so the actor lists it once.
    expect(warm.actors[1]!.runIds).toEqual(["mark-1"]);
  });

  it("names the members whose turn is in progress", () => {
    const members = [
      { key: "lead", name: "Assistant General" },
      { key: "mark", name: "Mark" },
      { key: "melo", name: "Melo" },
      { key: "sam", name: "Sam" },
    ];
    const working = (keys: string[]) =>
      teamWorkingStatus(
        members.map((member) => ({ memberKey: member.key, activeRunId: keys.includes(member.key) ? "run" : null, taskId: null })),
        members,
      );
    expect(working([])).toBeNull();
    expect(working(["mark"])).toBe("Mark is working");
    expect(working(["melo", "mark"])).toBe("Mark and Melo are working");
    expect(working(["mark", "melo", "sam"])).toBe("Mark, Melo and Sam are working");
    expect(teamWorkingStatus([{ memberKey: "mark", activeRunId: "run", taskId: "task" }], members)).toBeNull();
  });

  it("tells members reading the room apart from members working", () => {
    const members = [
      { key: "lead", name: "Assistant General" },
      { key: "mark", name: "Mark" },
      { key: "melo", name: "Melo" },
    ];
    const actors = [
      { memberKey: "lead", activeRunId: "lead-run", taskId: null, runs: [{ id: "lead-run", turnId: `turn-${"lead-run"}`, turn: 0, startedAt: 1, reason: "lead" as const }] },
      { memberKey: "mark", activeRunId: "mark-run", taskId: null, runs: [{ id: "mark-run", turnId: `turn-${"mark-run"}`, turn: 0, startedAt: 2, reason: "ambient" as const }] },
      { memberKey: "melo", activeRunId: "melo-run", taskId: null, runs: [{ id: "melo-run", turnId: `turn-${"melo-run"}`, turn: 0, startedAt: 3, reason: "ambient" as const }] },
    ];
    expect(teamWorkingStatus(actors, members)).toBe("Assistant General is working, Mark and Melo are reading");
    expect(teamWorkingStatus(actors.slice(1), members)).toBe("Mark and Melo are reading");
  });
});

it("places a turn where it finished, a running turn where it started, and needs no transcript to do so", () => {
  const data = execution();
  data.actors[0]!.runs[1]!.endedAt = 800;
  const feed = shape(teamFeed(data));
  expect(feed.at(-1)).toBe("turn:lead-2!");
  expect(feed.indexOf("direction:live")).toBeLessThan(feed.indexOf("chat:chat-user"));
  expect(shape(teamFeed(structuredClone(data)))).toEqual(feed);
  // Still running: the turn stays where it started.
  data.actors[0]!.runs[1]!.endedAt = null;
  expect(shape(teamFeed(data)).indexOf("turn:lead-2")).toBeLessThan(shape(teamFeed(data)).indexOf("direction:live"));
});
it("orders a warm process's turns by when each one finished", () => {
  const warm = execution();
  warm.actors[1] = actor("member:mark", 100, [
    { id: "mark-1", turnId: "turn-a", turn: 0, startedAt: 410, endedAt: 600 },
    { id: "mark-1", turnId: "turn-b", turn: 1, startedAt: 700, endedAt: 900 },
  ]);
  const turns = teamFeed(warm).filter((item) => item.kind === "turn" && item.actor.id === "member:mark");
  expect(turns.map((item) => item.at)).toEqual([600, 900]);
});
