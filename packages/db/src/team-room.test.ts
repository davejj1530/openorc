import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_TEAM_LIMITS } from "@openorc/protocol";
import { Db } from "./database.js";
import { orchestration } from "./orchestration.js";
import { projects, threads } from "./repos.js";
import { teamRoom } from "./team-room.js";

const opened = new Set<Db>();
afterEach(() => {
  for (const db of opened) db.close();
  opened.clear();
});
const settings = { agent: "codex" as const, model: "fixture", effort: null, fastMode: false };
function fixture() {
  const db = Db.memory();
  opened.add(db);
  const project = projects.insert(db, { name: "Room", rootPath: `/tmp/${randomUUID()}`, defaultBranch: "main", gitRemote: null, settings: {} });
  const saved = orchestration.save(db, {
    projectId: project.id,
    expectedRevisionId: null,
    draft: {
      name: "Room team",
      limits: DEFAULT_TEAM_LIMITS,
      members: [
        { key: "lead", name: "Lead", managerKey: null, responsibility: "Lead", settings },
        { key: "alice", name: "Alice", managerKey: "lead", responsibility: "Build", settings },
      ],
    },
  });
  const instance = () =>
    orchestration.createInstance(db, {
      threadId: threads.insert(db, { projectId: project.id, title: "Room", ...settings, mode: "act", permissionMode: "trusted" }).id,
      teamRevisionId: saved.revision.id,
      initialLeadOverrides: {},
    });
  return { db, room: instance(), other: instance() };
}

describe("team room log", () => {
  it("rejects a stored JSON array whose attachment entries are not paths", () => {
    const { db, room } = fixture();
    const id = randomUUID();
    db.stmt(
      "INSERT INTO team_room_events(instance_id,seq,id,author_kind,author_id,body,attachments,addressees,source,payload_hash,created_at) VALUES (?,1,?,'user','user','Broken','[42]','[]','chat',?,1)",
    ).run(room.id, id, "a".repeat(64));
    expect(() => teamRoom.get(db, id)).toThrow();
    expect(() => teamRoom.list(db, room.id)).toThrow();
  });

  it("reports assessed reads per message, never uncertain, migrated, or skipped ranges", () => {
    const { db, room, other } = fixture();
    const first = teamRoom.append(db, { instanceId: room.id, executionId: "execution", authorKind: "user", authorId: "user", body: "First", source: "prompt" });
    const second = teamRoom.append(db, { instanceId: room.id, executionId: "execution", authorKind: "user", authorId: "user", body: "Second", source: "chat" });
    const delivery = teamRoom.reserveDelivery(db, { instanceId: room.id, actorId: "lead", epoch: 0, fromSeq: second.seq, toSeq: second.seq, operation: "live" });
    teamRoom.settleDelivery(db, delivery.id, "confirmed");
    expect(teamRoom.readers(db, room.id, "execution").size).toBe(0);
    teamRoom.advance(db, room.id, "lead", second.seq, { assessed: true });
    expect(teamRoom.readers(db, room.id, "execution").get(second.id)).toEqual(["lead"]);
    expect(teamRoom.readers(db, room.id, "execution").has(first.id)).toBe(false);
    const uncertain = teamRoom.reserveDelivery(db, { instanceId: room.id, actorId: "member:alice", epoch: 0, fromSeq: first.seq, toSeq: second.seq, operation: "live" });
    teamRoom.settleDelivery(db, uncertain.id, "uncertain");
    teamRoom.setCursor(db, { instanceId: room.id, actorId: "member:alice", epoch: 0, seq: second.seq, unknown: true });
    expect(teamRoom.readers(db, room.id, "execution").get(second.id)).toEqual(["lead"]);
    expect(teamRoom.readers(db, other.id, "execution").size).toBe(0);
    expect(teamRoom.readers(db, room.id, "another-execution").size).toBe(0);
  });

  it("numbers messages without gaps per instance, keeps them immutable and replays a request key only for identical content", () => {
    const { db, room, other } = fixture();
    const first = teamRoom.append(db, { instanceId: room.id, authorKind: "user", authorId: "user", body: "Hello", addressees: ["lead"], source: "prompt", requestKey: "k1" });
    const second = teamRoom.append(db, { instanceId: room.id, authorKind: "member", authorId: "lead", body: "Hi", source: "reply" });
    const elsewhere = teamRoom.append(db, { instanceId: other.id, authorKind: "user", authorId: "user", body: "Other room", source: "chat" });
    expect([first.seq, second.seq, elsewhere.seq]).toEqual([1, 2, 1]);
    expect(first.requestId).toBe(first.id);
    expect(second.requestId).toBeNull();
    expect(teamRoom.append(db, { instanceId: room.id, authorKind: "user", authorId: "user", body: "Hello", addressees: ["lead"], source: "prompt", requestKey: "k1" })).toEqual(first);
    expect(() => teamRoom.append(db, { instanceId: room.id, authorKind: "user", authorId: "user", body: "Changed", addressees: ["lead"], source: "prompt", requestKey: "k1" })).toThrow(
      /different room message/,
    );
    expect(() => db.stmt("UPDATE team_room_events SET body='x' WHERE id=?").run(first.id)).toThrow(/immutable/);
    expect(() =>
      db
        .stmt(
          "INSERT INTO team_room_events(instance_id,seq,id,author_kind,author_id,body,attachments,addressees,source,payload_hash,created_at) VALUES(?,9,?,'user','user','gap','[]','[]','chat',?,1)",
        )
        .run(room.id, randomUUID(), "a".repeat(64)),
    ).toThrow(/without gaps/);
    expect(teamRoom.list(db, room.id).map((event) => event.seq)).toEqual([1, 2]);
    expect(teamRoom.list(db, room.id, { afterSeq: 1 }).map((event) => event.seq)).toEqual([2]);
    expect(teamRoom.list(db, room.id, { beforeSeq: 2, limit: 1 }).map((event) => event.seq)).toEqual([1]);
  });

  it("copies a room into a fork up to a point, past one page, keeping order and remapped references, and replays idempotently", () => {
    const { db, room, other } = fixture();
    const opening = teamRoom.append(db, { instanceId: room.id, authorKind: "user", authorId: "user", body: "Kickoff", addressees: ["lead"], source: "prompt", requestKey: "open" });
    // A room longer than one 500-message page, so the copy cannot rely on a single query.
    for (let index = 0; index < 600; index += 1)
      teamRoom.append(db, { instanceId: room.id, authorKind: "member", authorId: "lead", body: `Turn ${index}`, source: "reply", requestId: opening.id, replyTo: opening.id });
    const after = teamRoom.append(db, { instanceId: room.id, authorKind: "user", authorId: "user", body: "After the fork point", source: "chat" });
    expect(after.seq).toBe(602);

    expect(teamRoom.adopt(db, { from: room.id, to: other.id, throughSeq: 601, requestKeyPrefix: "fork:1" })).toBe(601);
    const copy = teamRoom.list(db, other.id, { limit: 500 });
    expect(teamRoom.count(db, other.id)).toBe(601);
    expect(teamRoom.latestSeq(db, other.id)).toBe(601);
    // Oldest first, same words, new ids, and the messages after the fork point stay with the source.
    expect(teamRoom.list(db, other.id, { beforeSeq: 4 }).map((event) => event.body)).toEqual(["Kickoff", "Turn 0", "Turn 1"]);
    expect(copy.at(-1)!.body).toBe("Turn 599");
    expect(teamRoom.list(db, other.id).every((event) => event.body !== "After the fork point")).toBe(true);
    expect(teamRoom.list(db, other.id, { beforeSeq: 2 })[0]!.id).not.toBe(opening.id);
    // References point at the copies, never back into the source room.
    const copiedOpening = teamRoom.byRequestKey(db, other.id, "fork:1:1")!;
    const copiedTurn = teamRoom.byRequestKey(db, other.id, "fork:1:2")!;
    expect(copiedTurn.replyTo).toBe(copiedOpening.id);
    expect(copiedTurn.requestId).toBe(copiedOpening.id);
    expect(copiedOpening.executionId).toBeNull();

    // A replay copies nothing more and leaves the references it already wrote alone.
    expect(teamRoom.adopt(db, { from: room.id, to: other.id, throughSeq: 601, requestKeyPrefix: "fork:1" })).toBe(0);
    expect(teamRoom.count(db, other.id)).toBe(601);
    expect(teamRoom.byRequestKey(db, other.id, "fork:1:2")!.replyTo).toBe(copiedOpening.id);
    expect(teamRoom.seqOf(db, other.id, "fork:1:2")).toBe(2);
    expect(teamRoom.seqOf(db, other.id, "fork:1:9999")).toBeNull();

    // Purge takes the room, its cursors and its delivery receipts, and only for that instance.
    teamRoom.setCursor(db, { instanceId: other.id, actorId: "lead", epoch: 1, seq: 3 });
    teamRoom.reserveDelivery(db, { instanceId: other.id, actorId: "lead", epoch: 1, fromSeq: 4, toSeq: 5, operation: "turn", attemptId: randomUUID(), state: "submitted" });
    teamRoom.purge(db, other.id);
    expect(teamRoom.count(db, other.id)).toBe(0);
    expect(teamRoom.cursor(db, other.id, "lead").deliveredSeq).toBe(0);
    expect(teamRoom.deliveries(db, other.id, { actorId: "lead" })).toHaveLength(0);
    expect(teamRoom.count(db, room.id)).toBe(602);
  });

  it("hands each member exactly the messages after its cursor, never its own, and advances only on confirmation", () => {
    const { db, room } = fixture();
    const userMessage = teamRoom.append(db, { instanceId: room.id, authorKind: "user", authorId: "user", body: "Plan the release", addressees: ["lead"], source: "chat" });
    const bob = teamRoom.append(db, { instanceId: room.id, authorKind: "member", authorId: "lead", body: "On it", source: "reply", requestId: userMessage.id });
    // Alice has read nothing; the lead wrote message 2 itself and is never handed it, but its cursor only moves over ranges it was handed.
    expect(teamRoom.pending(db, room.id, "member:alice").map((event) => event.seq)).toEqual([1, 2]);
    expect(teamRoom.pending(db, room.id, "lead").map((event) => event.seq)).toEqual([1]);
    expect(teamRoom.cursor(db, room.id, "lead").deliveredSeq).toBe(0);
    const delivery = teamRoom.reserveDelivery(db, { instanceId: room.id, actorId: "member:alice", epoch: 0, fromSeq: 1, toSeq: 2, operation: "turn", attemptId: "attempt-1" });
    expect(delivery.state).toBe("queued");
    teamRoom.submitted(db, delivery.id, "run-1");
    // A failed turn leaves the range unread; the next turn hands it over again.
    teamRoom.settleDelivery(db, delivery.id, "uncertain", { error: "process died" });
    expect(teamRoom.pending(db, room.id, "member:alice").map((event) => event.seq)).toEqual([1, 2]);
    expect(() => teamRoom.settleDelivery(db, delivery.id, "confirmed")).toThrow(/already uncertain/);
    const retry = teamRoom.reserveDelivery(db, { instanceId: room.id, actorId: "member:alice", epoch: 0, fromSeq: 1, toSeq: 2, operation: "turn", attemptId: "attempt-2", state: "submitted" });
    teamRoom.settleDelivery(db, retry.id, "confirmed", { assessed: true });
    expect(teamRoom.cursor(db, room.id, "member:alice")).toMatchObject({ deliveredSeq: 2, assessedSeq: 2, unknown: false });
    expect(teamRoom.pending(db, room.id, "member:alice")).toEqual([]);
    // Alice answers; Bob (the lead) receives only her message, not the earlier ones again.
    const alice = teamRoom.append(db, { instanceId: room.id, authorKind: "member", authorId: "member:alice", body: "I can take the tests", source: "reply", requestId: userMessage.id });
    expect(teamRoom.pending(db, room.id, "lead").map((event) => event.seq)).toEqual([1, alice.seq]);
    expect(teamRoom.pending(db, room.id, "member:alice")).toEqual([]);
    expect(teamRoom.deliveries(db, room.id, { actorId: "member:alice" }).map((item) => item.state)).toEqual(["uncertain", "confirmed"]);
    void bob;
  });

  it("places a migrated session at a known point without pretending it was delivered normally", () => {
    const { db, room } = fixture();
    teamRoom.append(db, { instanceId: room.id, authorKind: "user", authorId: "user", body: "Old", source: "legacy" });
    const placed = teamRoom.setCursor(db, { instanceId: room.id, actorId: "member:alice", epoch: 0, seq: 1, unknown: true });
    expect(placed).toMatchObject({ deliveredSeq: 1, unknown: true });
    expect(teamRoom.pending(db, room.id, "member:alice")).toEqual([]);
    teamRoom.append(db, { instanceId: room.id, authorKind: "user", authorId: "user", body: "New", source: "chat" });
    expect(teamRoom.pending(db, room.id, "member:alice").map((event) => event.body)).toEqual(["New"]);
    teamRoom.advance(db, room.id, "member:alice", 2);
    expect(teamRoom.cursor(db, room.id, "member:alice").unknown).toBe(false);
  });
});
