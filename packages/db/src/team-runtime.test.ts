import { insertLegacyRun } from "./fixtures/legacy-run.js";
import { LEGACY_TEAM_PROMPT, legacyTeamRuntime, readLegacyJournals, teamJournalWriter } from "./fixtures/legacy-team-journal.js";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { TeamActorRecord, TeamAttemptRecord, TeamDraft, TeamExecutionRecord, TeamMailboxMessage, TeamPublicationRecord, TeamWorkspaceRecord } from "@openorc/protocol";
import { teamAttemptDirectionVersion, teamAttemptHasUnconfirmedDirection, teamAttemptMessageIds } from "@openorc/protocol";
import { Db } from "./database.js";
import { orchestration } from "./orchestration.js";
import { projects, runs, tasks, threads } from "./repos.js";
import { migrations } from "./schema.js";
import { MAX_TEAM_MAILBOX_BYTES, teamRuntime } from "./team-runtime.js";
import { teamContexts } from "./team-context.js";
import { teamWorkspaces } from "./team-workspaces.js";

const opened: Db[] = [];
const folders: string[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});
const settings = { agent: "codex" as const, model: "gpt-6-astra", effort: "high", fastMode: false };
function fixture(db = Db.memory()) {
  opened.push(db);
  const project = projects.insert(db, { name: "Runtime", rootPath: `/tmp/runtime-${randomUUID()}`, defaultBranch: "main", gitRemote: null, settings: {} });
  const thread = threads.insert(db, { projectId: project.id, title: "Team work", ...settings, mode: "act", permissionMode: "trusted" });
  const draft: TeamDraft = {
    name: "Team",
    limits: { maxConcurrentAgents: 3, maxAssignments: 24, maxExecutionMinutes: 60, maxAttemptsPerAssignment: 2 },
    members: [
      { key: "coordinator", name: "Lead", managerKey: null, responsibility: "Coordinate", settings },
      { key: "worker", name: "Worker", managerKey: "coordinator", responsibility: "Implement", settings },
      { key: "manager", name: "Manager", managerKey: "coordinator", responsibility: "Review", settings },
      { key: "reviewer", name: "Reviewer", managerKey: "manager", responsibility: "Check", settings },
    ],
  };
  const team = orchestration.save(db, { projectId: project.id, expectedRevisionId: null, draft });
  const instance = orchestration.createInstance(db, { threadId: thread.id, teamRevisionId: team.revision.id });
  const record: TeamExecutionRecord = {
    id: randomUUID(),
    instanceId: instance.id,
    projectId: project.id,
    threadId: thread.id,
    state: "active",
    generation: 1,
    revision: 0,
    limits: draft.limits,
    actors: [actor("lead", "coordinator", null, null)],
    attempts: [],
    messages: [],
    error: null,
    createdAt: 1_000,
    updatedAt: 1_000,
    deadlineAt: 3_601_000,
  };
  return { db, project, thread, team, instance, record };
}
function actor(id: string, memberKey: string, taskId: string | null, parentId: string | null): TeamActorRecord {
  return {
    id,
    memberKey,
    taskId,
    parentId,
    requestKey: parentId ? id : null,
    requestHash: parentId ? `hash-${id}` : null,
    dependencies: [],
    input: { title: "Work", spec: "Requested work", attachments: [], responsibility: "Build", settings },
    state: "queued",
    retries: 0,
    directionVersion: 0,
    deliveredVersion: 0,
    disposition: null,
    result: null,
    snapshotId: null,
    error: null,
  };
}
function task(db: Db, record: TeamExecutionRecord, parentTaskId: string | null = null) {
  return tasks.insert(db, {
    projectId: record.projectId,
    threadId: record.threadId,
    title: "Child work",
    spec: "Work",
    priority: "none",
    labels: [],
    workspaceMode: "current",
    baseRef: null,
    parentTaskId,
    origin: "agent",
  });
}
function addActor(db: Db, record: TeamExecutionRecord, id = "worker-1", member = "worker", parent = "lead") {
  const child = actor(id, member, task(db, record, record.actors.find((item) => item.id === parent)?.taskId ?? null).id, parent);
  record.actors.push(child);
  return child;
}
function attempt(record: TeamExecutionRecord, actorId = "lead", id = randomUUID()): TeamAttemptRecord {
  return {
    id,
    actorId,
    runId: null,
    generation: record.generation,
    state: "starting",
    settings,
    configurationVersion: 1,
    directionVersion: 0,
    messageIds: [],
    snapshotId: null,
    error: null,
    createdAt: 1_000,
    endedAt: null,
  };
}
function bindRun(db: Db, record: TeamExecutionRecord, item: TeamAttemptRecord) {
  const owner = record.actors.find((actor) => actor.id === item.actorId)!;
  item.runId = randomUUID();
  insertLegacyRun(db, { id: item.runId, taskId: owner.taskId, threadId: owner.taskId ? null : record.threadId, ...settings, mode: "act", permissionMode: "trusted" });
  return item.runId;
}
function message(id = "direction-1", sequence = 1): TeamMailboxMessage {
  return { id, sequence, senderId: "user", recipientId: "lead", kind: "direction", body: "Please continue", dedupeKey: id, state: "pending", attemptId: null, createdAt: 1_000, deliveredAt: null };
}

describe("live lead direction reservations", () => {
  function running(db = Db.memory()) {
    const setup = fixture(db);
    teamRuntime.create(db, setup.record);
    const saved = teamRuntime.update(db, setup.record.id, (record) => {
      const turn = attempt(record);
      bindRun(db, record, turn);
      turn.state = "running";
      record.attempts.push(turn);
      record.actors[0]!.state = "running";
    }).record;
    return { ...setup, record: saved };
  }
  function reserve(record: TeamExecutionRecord, id = "live-1") {
    const turn = record.attempts.at(-1)!;
    const owner = record.actors.find((item) => item.id === turn.actorId)!;
    owner.directionVersion++;
    const direction: TeamMailboxMessage = {
      ...message(id, record.messages.length + 1),
      delivery: "immediate",
      createdAt: 1_100,
      attachments: ["/managed/design.png"],
      state: "claimed",
      attemptId: turn.id,
    };
    record.messages.push(direction);
    (turn.liveDirections ??= []).push({ messageId: id, directionVersion: owner.directionVersion, state: "reserved", createdAt: 1_100, settledAt: null, error: null });
  }
  function accepted(record: TeamExecutionRecord) {
    Object.assign(record.attempts.at(-1)!.liveDirections!.at(-1)!, { state: "accepted", settledAt: 1_200 });
  }

  it("retains a live reservation and acceptance across reopen without rewriting initial turn input", () => {
    const folder = mkdtempSync(path.join(os.tmpdir(), "openorc-live-direction-"));
    folders.push(folder);
    const file = path.join(folder, "ledger.sqlite");
    const { db, record } = running(Db.open(file));
    const initial = record.attempts[0]!;
    const reserved = teamRuntime.update(db, record.id, reserve).record;
    expect(reserved.messages[0]).toMatchObject({ delivery: "immediate", state: "claimed", attemptId: initial.id, attachments: ["/managed/design.png"] });
    expect(teamAttemptMessageIds(reserved.attempts[0]!)).toEqual([]);
    expect(teamAttemptHasUnconfirmedDirection(reserved.attempts[0]!)).toBe(true);
    const confirmed = teamRuntime.update(db, record.id, accepted).record;
    expect(teamAttemptMessageIds(confirmed.attempts[0]!)).toEqual(["live-1"]);
    expect(teamAttemptDirectionVersion(confirmed.attempts[0]!)).toBe(1);
    expect(teamAttemptHasUnconfirmedDirection(confirmed.attempts[0]!)).toBe(false);
    expect(confirmed.attempts[0]).toMatchObject({ messageIds: initial.messageIds, directionVersion: initial.directionVersion });
    expect(confirmed.messages[0]).toMatchObject({ state: "claimed", deliveredAt: null });
    opened.splice(opened.indexOf(db), 1);
    db.close();
    const reopened = Db.open(file);
    opened.push(reopened);
    expect(teamRuntime.get(reopened, record.id)).toEqual(confirmed);
    expect(() =>
      teamRuntime.update(reopened, record.id, (draft) => {
        draft.messages[0]!.delivery = undefined;
      }),
    ).toThrow(/immutable/);
    expect(() =>
      teamRuntime.update(reopened, record.id, (draft) => {
        draft.attempts[0]!.messageIds = ["live-1"];
      }),
    ).toThrow(/immutable/);
  });

  it("rejects a live reservation that overtakes an earlier pending message", () => {
    const { db, record } = running();
    teamRuntime.update(db, record.id, (draft) => {
      reserve(draft, "earlier");
      delete draft.attempts[0]!.liveDirections;
      Object.assign(draft.messages[0]!, { state: "pending", attemptId: null });
      delete draft.messages[0]!.delivery;
    });
    expect(() => teamRuntime.update(db, record.id, (draft) => reserve(draft, "later"))).toThrow(/overtake pending/);
    expect(teamRuntime.get(db, record.id)!.messages.map((item) => [item.id, item.state])).toEqual([["earlier", "pending"]]);
  });

  it("preserves proven-unavailable delivery history when a later attempt claims the queued message", () => {
    const { db, record } = running();
    teamRuntime.update(db, record.id, reserve);
    const unavailable = teamRuntime.update(db, record.id, (draft) => {
      Object.assign(draft.attempts[0]!.liveDirections![0]!, { state: "unavailable", settledAt: 1_200, error: "No active native turn." });
      Object.assign(draft.messages[0]!, { state: "pending", attemptId: null });
    }).record;
    expect(teamAttemptMessageIds(unavailable.attempts[0]!)).toEqual([]);
    expect(teamAttemptHasUnconfirmedDirection(unavailable.attempts[0]!)).toBe(false);
    expect(() =>
      teamRuntime.update(db, record.id, (draft) => {
        Object.assign(draft.messages[0]!, { state: "cancelled", cancelledAt: 1_300 });
      }),
    ).toThrow(/reserved/);
    const resumed = teamRuntime.update(db, record.id, (draft) => {
      Object.assign(draft.attempts[0]!, { state: "closed", endedAt: 1_300 });
      const next = { ...attempt(draft), createdAt: 1_400, directionVersion: 1, messageIds: ["live-1"] };
      bindRun(db, draft, next);
      draft.attempts.push(next);
      Object.assign(draft.messages[0]!, { state: "claimed", attemptId: next.id });
    }).record;
    expect(resumed.attempts[0]!.liveDirections).toEqual(unavailable.attempts[0]!.liveDirections);
    expect(teamAttemptMessageIds(resumed.attempts[1]!)).toEqual(["live-1"]);
  });

  it("records uncertainty after Stop fences the attempt and rejects late acceptance or unavailability", () => {
    const { db, record } = running();
    teamRuntime.update(db, record.id, reserve);
    teamRuntime.update(db, record.id, (draft) => {
      draft.generation++;
      draft.state = "stopped";
      draft.actors[0]!.state = "cancelled";
      Object.assign(draft.attempts[0]!, { state: "cancelled", endedAt: 1_300 });
    });
    for (const state of ["accepted", "unavailable"] as const) {
      expect(() =>
        teamRuntime.update(db, record.id, (draft) => {
          Object.assign(draft.attempts[0]!.liveDirections![0]!, { state, settledAt: 1_400, error: state === "accepted" ? null : "No active turn." });
          if (state === "unavailable") Object.assign(draft.messages[0]!, { state: "pending", attemptId: null });
        }),
      ).toThrow(/fenced|current|active/);
    }
    const retained = teamRuntime.update(db, record.id, (draft) => {
      Object.assign(draft.attempts[0]!.liveDirections![0]!, { state: "uncertain", settledAt: 1_400, error: "Provider closed before acknowledgment." });
    }).record;
    expect(retained.state).toBe("stopped");
    expect(teamAttemptHasUnconfirmedDirection(retained.attempts[0]!)).toBe(true);
    expect(retained.messages[0]).toMatchObject({ state: "claimed", attemptId: retained.attempts[0]!.id });
  });

  it.each(["worker", "result"])("rejects an invalid %s live reservation without persisting its claim", (kind) => {
    const { db, record } = running();
    expect(() =>
      teamRuntime.update(db, record.id, (draft) => {
        if (kind === "worker") {
          const child = addActor(db, draft);
          const turn = attempt(draft, child.id);
          turn.state = "running";
          bindRun(db, draft, turn);
          draft.attempts.push(turn);
          child.state = "running";
        }
        reserve(draft);
        const turn = draft.attempts.at(-1)!;
        const direction = draft.messages[0]!;
        if (kind === "worker") direction.recipientId = turn.actorId;
        if (kind === "queued") delete direction.delivery;
        if (kind === "result") {
          direction.kind = "result";
          direction.senderId = "lead";
        }
        if (kind === "foreign-claim") direction.attemptId = "another-attempt";
        if (kind === "missing-run") turn.runId = null;
        if (kind === "initial-input") turn.messageIds.push(direction.id);
        if (kind === "future-version") turn.liveDirections![0]!.directionVersion = 20;
        if (kind === "stale-attempt") {
          draft.generation++;
        }
      }),
    ).toThrow();
    expect(teamRuntime.get(db, record.id)).toEqual(record);
  });

  it("requires reservation before a native outcome and append-only ordered immutable live history", () => {
    const { db, record } = running();
    expect(() =>
      teamRuntime.update(db, record.id, (draft) => {
        reserve(draft);
        accepted(draft);
      }),
    ).toThrow(/reserved/);
    teamRuntime.update(db, record.id, reserve);
    expect(() =>
      teamRuntime.update(db, record.id, (draft) => {
        reserve(draft, "live-2");
      }),
    ).toThrow(/unconfirmed|unresolved/);
    const settled = teamRuntime.update(db, record.id, accepted).record;
    for (const mutate of [
      (turn: TeamAttemptRecord) => {
        turn.liveDirections = [];
      },
      (turn: TeamAttemptRecord) => {
        turn.liveDirections![0]!.messageId = "different";
      },
      (turn: TeamAttemptRecord) => {
        turn.liveDirections![0]!.directionVersion++;
      },
      (turn: TeamAttemptRecord) => {
        turn.liveDirections![0]!.createdAt++;
      },
      (turn: TeamAttemptRecord) => {
        turn.liveDirections![0]!.settledAt!++;
      },
      (turn: TeamAttemptRecord) => {
        Object.assign(turn.liveDirections![0]!, { state: "uncertain", error: "Rewrite accepted history." });
      },
    ])
      expect(() => teamRuntime.update(db, record.id, (draft) => mutate(draft.attempts[0]!))).toThrow(/immutable|removed|retained/);
    teamRuntime.update(db, record.id, (draft) => reserve(draft, "live-2"));
    const next = teamRuntime.update(db, record.id, accepted).record;
    expect(next.attempts[0]!.liveDirections![0]).toEqual(settled.attempts[0]!.liveDirections![0]);
    expect(teamAttemptMessageIds(next.attempts[0]!)).toEqual(["live-1", "live-2"]);
    expect(teamAttemptDirectionVersion(next.attempts[0]!)).toBe(2);
  });

  it("rejects corrupt settlement metadata without changing a pending native reservation", () => {
    const { db, record } = running();
    const reserved = teamRuntime.update(db, record.id, reserve).record;
    for (const change of [
      { state: "accepted", settledAt: null },
      { state: "accepted", settledAt: 1_000 },
      { state: "accepted", settledAt: 1_200, error: "Contradictory failure." },
      { state: "uncertain", settledAt: 1_200, error: null },
      { state: "reserved", settledAt: 1_200 },
    ])
      expect(() => teamRuntime.update(db, record.id, (draft) => Object.assign(draft.attempts[0]!.liveDirections![0]!, change))).toThrow();
    expect(teamRuntime.get(db, record.id)).toEqual(reserved);
  });

  it("does not turn native acceptance into delivered direction before successful captured process closure", () => {
    const { db, record } = running();
    teamRuntime.update(db, record.id, reserve);
    expect(() =>
      teamRuntime.update(db, record.id, (draft) => {
        accepted(draft);
        Object.assign(draft.messages[0]!, { state: "pending", attemptId: null });
      }),
    ).toThrow(/claim/);
    expect(() =>
      teamRuntime.update(db, record.id, (draft) => {
        Object.assign(draft.attempts[0]!.liveDirections![0]!, { state: "unavailable", settledAt: 1_200, error: "Not sent." });
      }),
    ).toThrow(/claim/);
    teamRuntime.update(db, record.id, accepted);
    expect(() =>
      teamRuntime.update(db, record.id, (draft) => {
        Object.assign(draft.messages[0]!, { state: "delivered", deliveredAt: 1_300 });
      }),
    ).toThrow(/captured.*closed/);
    const confirmed = teamRuntime.update(db, record.id, (draft) => {
      const turn = draft.attempts[0]!;
      runs.update(db, turn.runId!, { state: "success", endedAt: 1_300 });
      Object.assign(turn, { state: "closed", endedAt: 1_300, snapshotId: "captured-turn" });
      Object.assign(draft.messages[0]!, { state: "delivered", deliveredAt: 1_300 });
    }).record;
    expect(confirmed.messages[0]).toMatchObject({ state: "delivered", attemptId: record.attempts[0]!.id });
  });

  it("reads and updates legacy journals without synthesizing live delivery fields", () => {
    const { db, record } = running();
    teamRuntime.update(db, record.id, (draft) => {
      draft.messages.push(message());
      draft.actors[0]!.directionVersion++;
    });
    const stored = teamRuntime.get(db, record.id)!;
    expect(stored.attempts[0]).not.toHaveProperty("liveDirections");
    expect(stored.messages[0]).not.toHaveProperty("delivery");
    expect(teamAttemptMessageIds(stored.attempts[0]!)).toEqual([]);
    expect(teamAttemptDirectionVersion(stored.attempts[0]!)).toBe(0);
    expect(teamAttemptHasUnconfirmedDirection(stored.attempts[0]!)).toBe(false);
  });
});

describe("team execution journal", () => {
  it("keeps actor diagnostics ahead of later attempt and claim faults", () => {
    const { db, record } = fixture();
    teamRuntime.create(db, record);
    expect(() =>
      teamRuntime.update(db, record.id, (draft) => {
        draft.actors[0]!.deliveredVersion = 1;
        draft.attempts.push(attempt(draft, "missing"));
        draft.claims = [{ id: "claim", actorId: "missing", path: "file", note: null, createdAt: 1_000, releasedAt: null }];
      }),
    ).toThrow("Invalid team execution: actor lead delivered a future direction.");
    expect(teamRuntime.get(db, record.id)).toEqual(record);
  });

  it("keeps process-sharing diagnostics ahead of turn and mailbox faults", () => {
    const { db, record } = fixture();
    teamRuntime.create(db, record);
    expect(() =>
      teamRuntime.update(db, record.id, (draft) => {
        const first = attempt(draft);
        first.runId = "shared";
        draft.attempts.push(first, { ...attempt(draft), runId: "shared", actorId: "missing" });
        draft.messages.push(message("duplicate", 1), message("duplicate", 2));
      }),
    ).toThrow("Invalid team execution: run shared is shared by turns of lead, which is not a conversation member.");
    expect(teamRuntime.get(db, record.id)).toEqual(record);
  });

  it("keeps turn-reservation diagnostics ahead of mailbox and claim faults", () => {
    const { db, record } = fixture();
    teamRuntime.create(db, record);
    expect(() =>
      teamRuntime.update(db, record.id, (draft) => {
        draft.attempts.push(attempt(draft, "missing"));
        draft.messages.push(message("duplicate", 1), message("duplicate", 2));
        draft.claims = [{ id: "claim", actorId: "missing", path: "file", note: null, createdAt: 1_000, releasedAt: null }];
      }),
    ).toThrow(/attempt .* has an unknown actor or future generation/);
    expect(teamRuntime.get(db, record.id)).toEqual(record);
  });

  it("checks mailbox identity before file claims, then file-claim ownership on its own", () => {
    const { db, record } = fixture();
    teamRuntime.create(db, record);
    expect(() =>
      teamRuntime.update(db, record.id, (draft) => {
        draft.messages.push({ ...message(), senderId: "missing" });
        draft.claims = [{ id: "claim", actorId: "missing", path: "file", note: null, createdAt: 1_000, releasedAt: null }];
      }),
    ).toThrow("Invalid team execution: message direction-1 has an unknown sender or recipient.");
    expect(() =>
      teamRuntime.update(db, record.id, (draft) => {
        draft.claims = [{ id: "claim", actorId: "missing", path: "file", note: null, createdAt: 1_000, releasedAt: null }];
      }),
    ).toThrow("Invalid team execution: claim claim belongs to an unknown actor.");
    expect(teamRuntime.get(db, record.id)).toEqual(record);
  });

  it("retains immutable admission keys across terminal history and database reopen", () => {
    const folder = mkdtempSync(path.join(os.tmpdir(), "openorc-team-admission-"));
    folders.push(folder);
    const file = path.join(folder, "ledger.sqlite");
    const { db, record } = fixture(Db.open(file));
    record.admission = { scope: "thread", requestKey: "follow-up-once", payloadHash: "a".repeat(64) };
    teamRuntime.create(db, record);
    expect(() =>
      teamRuntime.update(db, record.id, (draft) => {
        draft.admission!.payloadHash = "b".repeat(64);
      }),
    ).toThrow(/admission cannot be changed/);
    teamRuntime.update(db, record.id, (draft) => {
      draft.state = "stopped";
    });
    opened.splice(opened.indexOf(db), 1);
    db.close();
    const reopened = Db.open(file);
    opened.push(reopened);
    expect(teamRuntime.findAdmission(reopened, { scope: "thread", threadId: record.threadId, requestKey: "follow-up-once" })).toMatchObject({
      id: record.id,
      state: "stopped",
      admission: record.admission,
    });
    expect(teamRuntime.findAdmission(reopened, { scope: "thread", threadId: "other-thread", requestKey: "follow-up-once" })).toBeNull();
    expect(() => teamRuntime.create(reopened, { ...record, id: randomUUID() })).toThrow(/already admitted/);
    expect(teamRuntime.findAdmission(reopened, { scope: "project", projectId: record.projectId, requestKey: "follow-up-once" })).toBeNull();
  });

  it("creates one lead-only execution per thread and retains terminal history across later goals", () => {
    const { db, record } = fixture();
    expect(teamRuntime.create(db, record)).toEqual(record);
    expect(teamRuntime.activeForThread(db, record.threadId)).toEqual(record);
    expect(teamRuntime.listOpen(db)).toEqual([record]);
    expect(() => teamRuntime.create(db, { ...record, id: "second" })).toThrow(/already has an open/);
    teamRuntime.update(db, record.id, (draft) => {
      draft.state = "attention";
    });
    expect(teamRuntime.activeForThread(db, record.threadId)?.state).toBe("attention");
    teamRuntime.update(db, record.id, (draft) => {
      draft.state = "stopping";
      draft.generation++;
    });
    expect(teamRuntime.listOpen(db)[0]?.state).toBe("stopping");
    teamRuntime.update(db, record.id, (draft) => {
      draft.state = "stopped";
    });
    expect(teamRuntime.activeForThread(db, record.threadId)).toBeNull();
    expect(teamRuntime.listOpen(db)).toEqual([]);
    expect(teamRuntime.create(db, { ...record, id: "second" }).id).toBe("second");
    expect(teamRuntime.get(db, record.id)?.state).toBe("stopped");
    expect(() =>
      teamRuntime.update(db, record.id, (draft) => {
        draft.state = "active";
      }),
    ).toThrow(/terminal/);
  });

  it("rejects ownership, missing lead, and noninitial journals without persisting work", () => {
    const { db, record } = fixture();
    for (const changed of [{ projectId: "foreign" }, { instanceId: "foreign" }, { threadId: "foreign" }, { actors: [] }, { revision: 1 }, { generation: 2 }]) {
      expect(() => teamRuntime.create(db, { ...record, ...changed })).toThrow();
    }
    expect(teamRuntime.get(db, record.id)).toBeNull();
    expect(tasks.list(db)).toEqual([]);
  });

  it("rejects tasks from another project or another thread in the same project", () => {
    const { db, record } = fixture();
    const other = threads.insert(db, { projectId: record.projectId, title: "Other", ...settings, mode: "act", permissionMode: "trusted" });
    const foreignTask = task(db, { ...record, threadId: other.id });
    teamRuntime.create(db, record);
    expect(() =>
      teamRuntime.update(db, record.id, (draft) => {
        draft.actors.push(actor("worker-1", "worker", foreignTask.id, "lead"));
      }),
    ).toThrow(/outside/);
    const otherProject = projects.insert(db, { name: "Other", rootPath: "/tmp/runtime-other", defaultBranch: "main", gitRemote: null, settings: {} });
    const crossProjectTask = task(db, { ...record, projectId: otherProject.id });
    expect(() =>
      teamRuntime.update(db, record.id, (draft) => {
        draft.actors.push(actor("worker-1", "worker", crossProjectTask.id, "lead"));
      }),
    ).toThrow(/outside/);
  });

  it("binds lead and assignment runs to their own scopes and preserves bindings across stop generations", () => {
    const { db, record } = fixture();
    teamRuntime.create(db, record);
    const saved = teamRuntime.update(db, record.id, (draft) => {
      const child = addActor(db, draft);
      for (const id of ["lead", child.id]) {
        const item = attempt(draft, id);
        bindRun(db, draft, item);
        draft.attempts.push(item);
      }
    }).record;
    for (const item of saved.attempts) expect(teamRuntime.binding(db, item.runId!)).toEqual({ runId: item.runId, executionId: record.id, actorId: item.actorId, attemptId: item.id, generation: 1 });
    const stopped = teamRuntime.update(db, record.id, (draft) => {
      draft.generation = 2;
      draft.state = "attention";
      draft.error = "Stop timed out";
      for (const item of draft.attempts) item.state = "attention";
      for (const actor of draft.actors) actor.state = "attention";
    }).record;
    expect(stopped.attempts.map((item) => item.generation)).toEqual([1, 1]);
    expect(teamRuntime.binding(db, saved.attempts[0]!.runId!)?.generation).toBe(1);
    expect(() =>
      teamRuntime.update(db, record.id, (draft) => {
        draft.attempts[0]!.runId = draft.attempts[1]!.runId;
      }),
    ).toThrow(/immutable/);
    expect(() =>
      teamRuntime.update(db, record.id, (draft) => {
        draft.attempts[0]!.generation = 2;
      }),
    ).toThrow(/immutable/);
    expect(() =>
      teamRuntime.update(db, record.id, (draft) => {
        draft.actors[1]!.memberKey = "manager";
      }),
    ).toThrow(/immutable/);
    expect(() =>
      teamRuntime.update(db, record.id, (draft) => {
        draft.attempts = [];
      }),
    ).toThrow(/history/);
  });

  it("retains nested task parent links and rejects a detached child reservation atomically", () => {
    const { db, record } = fixture();
    teamRuntime.create(db, record);
    const manager = teamRuntime.update(db, record.id, (draft) => addActor(db, draft, "manager-1", "manager")).value;
    expect(() =>
      teamRuntime.update(db, record.id, (draft) => {
        draft.actors.push(actor("reviewer-1", "reviewer", task(db, draft).id, manager.id));
      }),
    ).toThrow(/requesting manager's task/);
    expect(tasks.list(db)).toHaveLength(1);
    const child = teamRuntime.update(db, record.id, (draft) => addActor(db, draft, "reviewer-1", "reviewer", manager.id)).value;
    expect(tasks.get(db, child.taskId!)).toMatchObject({ threadId: record.threadId, parentTaskId: manager.taskId });
    expect(teamRuntime.assignmentForTask(db, child.taskId!)).toEqual({ executionId: record.id, actorId: child.id });
  });

  it("rejects incorrect Run scope, rebinding a Run, and stealing an active task reservation", () => {
    const { db, record } = fixture();
    teamRuntime.create(db, record);
    const saved = teamRuntime.update(db, record.id, (draft) => {
      addActor(db, draft);
      const item = attempt(draft);
      bindRun(db, draft, item);
      draft.attempts.push(item);
    }).record;
    // Only a conversation member's own consecutive turns may share a process; the lead and assignments keep one run each.
    expect(() =>
      teamRuntime.update(db, record.id, (draft) => {
        const item = attempt(draft, "worker-1");
        item.runId = saved.attempts[0]!.runId;
        draft.attempts.push(item);
      }),
    ).toThrow(/not a conversation member|another task/);
    teamRuntime.update(db, record.id, (draft) => {
      draft.state = "completed";
    });
    const next = teamRuntime.create(db, { ...record, id: "next" });
    expect(() =>
      teamRuntime.update(db, next.id, (draft) => {
        const item = attempt(draft);
        item.runId = saved.attempts[0]!.runId;
        draft.attempts.push(item);
      }),
    ).toThrow(/already bound/);
    expect(() =>
      teamRuntime.update(db, next.id, (draft) => {
        draft.actors.push(saved.actors[1]!);
      }),
    ).toThrow(/active assignment/);
    expect(teamRuntime.get(db, next.id)).toEqual(next);
  });

  it("lets one conversation member's turns share a process, with one binding, and refuses a share that could not be one process", () => {
    const { db, record } = fixture();
    record.actors.push({ ...actor("member:worker", "worker", null, "lead"), requestKey: null, requestHash: null, participant: true, state: "waiting" });
    teamRuntime.create(db, record);
    const first = attempt(record, "member:worker");
    const saved = teamRuntime.update(db, record.id, (draft) => {
      const item = { ...first };
      bindRun(db, draft, item);
      draft.attempts.push(item);
    }).record;
    const runId = saved.attempts[0]!.runId!;

    // A second turn on the same process is allowed once the first has closed.
    expect(() =>
      teamRuntime.update(db, record.id, (draft) => {
        draft.attempts.push({ ...attempt(draft, "member:worker"), runId });
      }),
    ).toThrow(/began another turn/);
    const warm = teamRuntime.update(db, record.id, (draft) => {
      const open = draft.attempts[0]!;
      open.state = "closed";
      open.endedAt = 2_000;
      draft.attempts.push({ ...attempt(draft, "member:worker"), runId });
    }).record;
    expect(warm.attempts.map((item) => item.runId)).toEqual([runId, runId]);
    // One process, one binding, naming the turn that opened it.
    expect(teamRuntime.binding(db, runId)).toEqual({ runId, executionId: record.id, actorId: "member:worker", attemptId: saved.attempts[0]!.id, generation: 1 });
    expect(db.stmt("SELECT COUNT(*) AS total FROM team_run_bindings WHERE execution_id=?").get(record.id)).toEqual({ total: 1 });

    // A turn that could not have come from the same process is refused, and so is a share by a non-member.
    expect(() =>
      teamRuntime.update(db, record.id, (draft) => {
        draft.attempts[1]!.state = "closed";
        draft.attempts[1]!.endedAt = 3_000;
        draft.attempts.push({ ...attempt(draft, "member:worker"), runId, settings: { ...settings, model: "other-model" } });
      }),
    ).toThrow(/could not have started from one process/);
    expect(() =>
      teamRuntime.update(db, record.id, (draft) => {
        draft.attempts[1]!.state = "closed";
        draft.attempts[1]!.endedAt = 3_000;
        draft.attempts.push({ ...attempt(draft, "lead"), runId });
      }),
    ).toThrow(/could not have started from one process/);

    // The lead keeps one process per turn: fork, move, restore and task completion resolve its turn through the binding in SQL.
    const lead = teamRuntime.update(db, record.id, (draft) => {
      draft.attempts[1]!.state = "closed";
      draft.attempts[1]!.endedAt = 3_000;
      const item = attempt(draft, "lead");
      bindRun(db, draft, item);
      item.state = "closed";
      item.endedAt = 4_000;
      draft.attempts.push(item);
    }).record;
    const leadRun = lead.attempts.at(-1)!.runId!;
    expect(() =>
      teamRuntime.update(db, record.id, (draft) => {
        draft.attempts.push({ ...attempt(draft, "lead"), runId: leadRun });
      }),
    ).toThrow(/not a conversation member/);
  });

  it("enforces sibling dependency ownership, acyclicity, and direct-child waiting", () => {
    const { db, record } = fixture();
    teamRuntime.create(db, record);
    expect(() =>
      teamRuntime.update(db, record.id, (draft) => {
        addActor(db, draft).dependencies = ["manager-1"];
        addActor(db, draft, "manager-1", "manager").dependencies = ["worker-1"];
      }),
    ).toThrow(/cycle/);
    expect(tasks.list(db)).toEqual([]);
    expect(() =>
      teamRuntime.update(db, record.id, (draft) => {
        addActor(db, draft);
        addActor(db, draft, "manager-1", "manager");
        addActor(db, draft, "reviewer-1", "reviewer", "manager-1").dependencies = ["worker-1"];
      }),
    ).toThrow(/sibling/);
    const saved = teamRuntime.update(db, record.id, (draft) => {
      addActor(db, draft);
      addActor(db, draft, "manager-1", "manager").dependencies = ["worker-1"];
      draft.actors[0]!.disposition = { kind: "wait", version: 0, result: null, waitFor: ["worker-1"] };
    }).record;
    expect(saved.actors).toHaveLength(3);
    expect(() =>
      teamRuntime.update(db, record.id, (draft) => {
        draft.actors[1]!.disposition = { kind: "wait", version: 0, result: null, waitFor: ["manager-1"] };
      }),
    ).toThrow(/direct children/);
  });

  it("retains immutable image delivery snapshots across reopen and bounds their mailbox cost", () => {
    const folder = mkdtempSync(path.join(os.tmpdir(), "openorc-team-images-"));
    folders.push(folder);
    const file = path.join(folder, "ledger.sqlite");
    const { db, record } = fixture(Db.open(file));
    teamRuntime.create(db, record);
    const saved = teamRuntime.update(db, record.id, (draft) => {
      const direction = { ...message(), attachments: ["/managed/design.png"] };
      const turn = { ...attempt(draft), attachments: direction.attachments, messageIds: [direction.id], directionVersion: 1 };
      draft.actors[0]!.directionVersion = 1;
      draft.messages.push({ ...direction, state: "claimed", attemptId: turn.id });
      draft.attempts.push(turn);
    }).record;
    expect(() =>
      teamRuntime.update(db, record.id, (draft) => {
        draft.messages[0]!.attachments = ["/replaced.png"];
      }),
    ).toThrow(/immutable/);
    expect(() =>
      teamRuntime.update(db, record.id, (draft) => {
        draft.attempts[0]!.attachments = [];
      }),
    ).toThrow(/immutable/);
    expect(() =>
      teamRuntime.update(db, record.id, (draft) => {
        draft.messages.push({ ...message("too-large", 2), body: "x".repeat(MAX_TEAM_MAILBOX_BYTES - 100), attachments: ["x".repeat(200)] });
      }),
    ).toThrow(/2 MiB/);
    expect(() =>
      teamRuntime.update(db, record.id, (draft) => {
        draft.messages.push({ ...message("too-many", 2), attachments: Array.from({ length: 21 }, (_, index) => `/image-${index}.png`) });
      }),
    ).toThrow();
    opened.splice(opened.indexOf(db), 1);
    db.close();
    const reopened = Db.open(file);
    opened.push(reopened);
    expect(teamRuntime.get(reopened, record.id)).toEqual(saved);
  });

  it.each(["actor", "limits"])("reports %s corruption without silently replacing journal history", (kind) => {
    const { db, record } = fixture();
    teamRuntime.create(db, record);
    teamRuntime.update(db, record.id, (draft) => {
      addActor(db, draft);
    });
    if (kind === "actor") db.stmt("UPDATE team_actors SET details = '{}' WHERE execution_id = ? AND id = 'lead'").run(record.id);
    if (kind === "limits") db.stmt("UPDATE team_executions SET limits = '{}' WHERE id = ?").run(record.id);
    expect(() => teamRuntime.get(db, record.id)).toThrow(/journal is invalid; preserve the database/);
    expect(() => teamRuntime.listOpen(db)).toThrow(/journal is invalid/);
    expect(() => teamRuntime.update(db, record.id, () => undefined)).toThrow(/journal is invalid/);
  });

  it.each(["binding", "omitted actor"])("keeps a journal with %s corruption readable but refuses to write over it", (kind) => {
    const { db, record } = fixture();
    teamRuntime.create(db, record);
    const saved = teamRuntime.update(db, record.id, (draft) => {
      addActor(db, draft);
    }).record;
    if (kind === "binding") db.stmt("DELETE FROM team_assignment_bindings WHERE execution_id = ?").run(record.id);
    if (kind === "omitted actor") db.stmt("DELETE FROM team_actors WHERE execution_id = ? AND id = 'worker-1'").run(record.id);
    expect(teamRuntime.get(db, record.id)!.actors).toHaveLength(kind === "binding" ? 2 : 1);
    expect(() => teamRuntime.update(db, record.id, () => undefined)).toThrow(/omits retained task or run bindings/);
    expect(teamRuntime.get(db, record.id)!.revision).toBe(saved.revision);
  });

  it("moves a version 39 journal into rows unchanged, keeps turn prompts beside it and accepts new writes", () => {
    const folder = mkdtempSync(path.join(os.tmpdir(), "team-journal-rows-"));
    folders.push(folder);
    const file = path.join(folder, "ledger.sqlite");
    const raw = new DatabaseSync(file);
    for (const migration of migrations.slice(0, 39)) typeof migration === "string" ? raw.exec(migration) : migration(raw);
    raw.exec("PRAGMA user_version = 39");
    const { db, record } = fixture(new Db(raw));
    legacyTeamRuntime.create(db, { ...record, admission: { scope: "thread", requestKey: "legacy-admission", payloadHash: "c".repeat(64) } });
    const saved = legacyTeamRuntime.update(db, record.id, (draft) => {
      const turn = attempt(draft);
      bindRun(db, draft, turn);
      draft.attempts.push({ ...turn, state: "running", liveDirections: [{ messageId: "live-1", directionVersion: 1, state: "accepted", createdAt: 1_100, settledAt: 1_200, error: null }] });
      draft.actors[0]!.state = "running";
      draft.actors[0]!.directionVersion = 1;
      draft.messages.push({ ...message("live-1", 1), delivery: "immediate", state: "claimed", attemptId: turn.id, createdAt: 1_100, attachments: ["/managed/live.png"] });
      draft.claims = [
        { id: "claim-1", actorId: "lead", path: "src/app.ts", note: "Editing", createdAt: 1_300, releasedAt: null },
        { id: "claim-2", actorId: "lead", path: "README.md", note: null, createdAt: 1_310, releasedAt: 1_400 },
      ];
    }).record;
    opened.splice(opened.indexOf(db), 1);
    db.close();

    const migrated = Db.open(file);
    opened.push(migrated);
    expect(migrated.version).toBe(migrations.length);
    expect(teamRuntime.get(migrated, record.id)).toEqual(saved);
    expect(teamRuntime.prompt(migrated, record.id, saved.attempts[0]!.id)).toBe(LEGACY_TEAM_PROMPT);
    expect(teamRuntime.findAdmission(migrated, { scope: "thread", threadId: record.threadId, requestKey: "legacy-admission" })?.id).toBe(record.id);
    expect(migrated.stmt("SELECT 1 FROM pragma_table_info('team_executions') WHERE name = 'payload'").get()).toBeUndefined();
    expect(migrated.raw.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    const next = teamRuntime.update(migrated, record.id, (draft) => {
      Object.assign(draft.attempts[0]!, { state: "closed", endedAt: 1_500, snapshotId: "captured" });
      Object.assign(draft.messages[0]!, { state: "delivered", deliveredAt: 1_500 });
      draft.claims!.push({ id: "claim-3", actorId: "lead", path: "README.md", note: null, createdAt: 1_600, releasedAt: null });
    }).record;
    expect(() =>
      teamRuntime.update(migrated, record.id, (draft) => {
        draft.claims!.push({ id: "claim-4", actorId: "lead", path: "src/app.ts", note: null, createdAt: 1_700, releasedAt: null });
      }),
    ).toThrow(/Active file claims/);
    expect(teamRuntime.get(migrated, record.id)).toEqual(next);
  });

  it("keeps a settled turn settled whoever writes the journal", () => {
    const { db, record } = fixture();
    teamRuntime.create(db, record);
    const saved = teamRuntime.update(db, record.id, (draft) => {
      const turn = attempt(draft);
      bindRun(db, draft, turn);
      draft.attempts.push({ ...turn, state: "closed", endedAt: 2_000, snapshotId: "captured" });
    }).record;
    for (const state of ["running", "attention", "cancelled"] as const)
      expect(() =>
        teamRuntime.update(db, record.id, (draft) => {
          draft.attempts[0]!.state = state;
        }),
      ).toThrow(/cannot move from closed/);
    expect(teamRuntime.get(db, record.id)).toEqual(saved);
  });

  it("keeps each turn's prompt beside its journal, written once", () => {
    const { db, record } = fixture();
    teamRuntime.create(db, record);
    const turn = teamRuntime.update(db, record.id, (draft) => {
      const next = attempt(draft);
      draft.attempts.push(next);
      return next;
    }).value;
    expect(teamRuntime.prompt(db, record.id, turn.id)).toBeNull();
    teamRuntime.recordPrompt(db, record.id, turn.id, "Exact turn input");
    expect(teamRuntime.prompt(db, record.id, turn.id)).toBe("Exact turn input");
    expect(() => teamRuntime.recordPrompt(db, record.id, turn.id, "Replaced input")).toThrow(/UNIQUE|PRIMARY/);
    expect(() => db.stmt("UPDATE team_attempt_prompts SET prompt = 'Edited' WHERE attempt_id = ?").run(turn.id)).toThrow(/immutable/);
    expect(JSON.stringify(teamRuntime.get(db, record.id))).not.toContain("Exact turn input");
  });

  it("never serves a cached journal after its rows or execution row change underneath it", () => {
    const { db, record } = fixture();
    teamRuntime.create(db, record);
    const saved = teamRuntime.update(db, record.id, (draft) => {
      addActor(db, draft);
    }).record;
    expect(teamRuntime.get(db, record.id)).toEqual(saved);
    db.stmt("UPDATE team_actors SET state = 'waiting' WHERE execution_id = ? AND id = 'worker-1'").run(record.id);
    expect(teamRuntime.get(db, record.id)!.actors[1]!.state).toBe("waiting");
    db.stmt("UPDATE team_executions SET error = 'Repaired by hand' WHERE id = ?").run(record.id);
    expect(teamRuntime.get(db, record.id)!.error).toBe("Repaired by hand");
    // A rolled-back write leaves nothing behind in the cache.
    expect(() =>
      db.transaction(() => {
        teamRuntime.update(db, record.id, (draft) => {
          draft.error = "Rolled back";
        });
        throw new Error("abandon");
      }),
    ).toThrow("abandon");
    expect(teamRuntime.get(db, record.id)!.error).toBe("Repaired by hand");
  });

  it.each(["thread"])("protects individual task/run history while allowing owning %s cleanup", (owner) => {
    const { db, record, project, thread } = fixture();
    teamRuntime.create(db, record);
    const saved = teamRuntime.update(db, record.id, (draft) => {
      const child = addActor(db, draft);
      const item = attempt(draft, child.id);
      bindRun(db, draft, item);
      draft.attempts.push(item);
    }).record;
    expect(() => tasks.delete(db, saved.actors[1]!.taskId!)).toThrow(/FOREIGN KEY/);
    expect(() => db.stmt("DELETE FROM runs WHERE id = ?").run(saved.attempts[0]!.runId)).toThrow(/FOREIGN KEY/);
    expect(() => db.stmt("UPDATE team_run_bindings SET actor_id = 'lead' WHERE run_id = ?").run(saved.attempts[0]!.runId)).toThrow(/immutable/);
    expect(() => db.stmt("UPDATE team_assignment_bindings SET actor_id = 'lead' WHERE task_id = ?").run(saved.actors[1]!.taskId)).toThrow(/immutable/);
    if (owner === "thread") expect(() => threads.delete(db, thread.id)).not.toThrow();
    else expect(() => db.stmt("DELETE FROM projects WHERE id = ?").run(project.id)).not.toThrow();
    expect(teamRuntime.get(db, record.id)).toBeNull();
    expect(teamRuntime.binding(db, saved.attempts[0]!.runId!)).toBeNull();
  });

  it("migrates fixed version 8, preserves saved configuration and existing runs, and reopens the journal", () => {
    const folder = mkdtempSync(path.join(os.tmpdir(), "team-runtime-migration-"));
    folders.push(folder);
    const file = path.join(folder, "ledger.sqlite");
    const raw = new DatabaseSync(file);
    for (const migration of migrations.slice(0, 8)) typeof migration === "string" ? raw.exec(migration) : migration(raw);
    raw.exec("PRAGMA user_version = 8");
    const oldDb = new Db(raw);
    const initial = fixture(oldDb);
    insertLegacyRun(oldDb, { id: "legacy-run", taskId: null, threadId: initial.thread.id, ...settings, fastMode: true, mode: "act", permissionMode: "trusted" });
    oldDb.close();
    opened.splice(opened.indexOf(oldDb), 1);
    const migrated = Db.open(file);
    opened.push(migrated);
    expect(migrated.version).toBe(migrations.length);
    expect(orchestration.get(migrated, initial.team.team.id)).toEqual(initial.team);
    expect(orchestration.getInstance(migrated, initial.thread.id)).toEqual(initial.instance);
    expect(runs.get(migrated, "legacy-run")?.fastMode).toBe(true);
    teamRuntime.create(migrated, initial.record);
    const saved = teamRuntime.update(migrated, initial.record.id, (draft) => {
      const item = attempt(draft);
      item.runId = "legacy-run";
      draft.attempts.push(item);
    }).record;
    migrated.close();
    opened.splice(opened.indexOf(migrated), 1);
    const reopened = Db.open(file);
    opened.push(reopened);
    expect(teamRuntime.get(reopened, initial.record.id)).toEqual(saved);
    expect(teamRuntime.binding(reopened, "legacy-run")?.executionId).toBe(saved.id);
    expect(reopened.raw.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});

describe("retained team direction cancellation", () => {
  it("retains cancelled text and images across reopen without allowing resurrection or timestamp changes", () => {
    const folder = mkdtempSync(path.join(os.tmpdir(), "openorc-team-cancel-"));
    folders.push(folder);
    const file = path.join(folder, "ledger.sqlite");
    const { db, record } = fixture(Db.open(file));
    teamRuntime.create(db, record);
    const direction = { ...message(), attachments: ["/managed/cancelled.png"] };
    teamRuntime.update(db, record.id, (draft) => {
      draft.messages.push(direction);
      draft.actors[0]!.directionVersion++;
    });
    const cancelled = teamRuntime.update(db, record.id, (draft) => {
      draft.messages[0]!.state = "cancelled";
      draft.messages[0]!.cancelledAt = 2_000;
      draft.state = "stopped";
    }).record;
    expect(cancelled.messages[0]).toEqual({ ...direction, state: "cancelled", cancelledAt: 2_000 });
    for (const change of [
      (item: TeamMailboxMessage) => {
        item.state = "pending";
        delete item.cancelledAt;
      },
      (item: TeamMailboxMessage) => {
        item.cancelledAt = 3_000;
      },
      (item: TeamMailboxMessage) => {
        item.body = "Rewrite history";
      },
      (item: TeamMailboxMessage) => {
        item.attachments = [];
      },
    ])
      expect(() => teamRuntime.update(db, record.id, (draft) => change(draft.messages[0]!))).toThrow(/immutable/);
    expect(() =>
      teamRuntime.update(db, record.id, (draft) => {
        draft.messages[0]!.state = "delivered";
      }),
    ).toThrow();
    opened.splice(opened.indexOf(db), 1);
    db.close();
    const reopened = Db.open(file);
    opened.push(reopened);
    expect(teamRuntime.get(reopened, record.id)).toEqual(cancelled);
  });

  it.each([
    { state: "cancelled", senderId: "user", kind: "direction", cancelledAt: 999 },
    { state: "pending", senderId: "user", kind: "direction", cancelledAt: 2_000 },
  ] as const)("rejects malformed cancellation $state / $senderId / $kind / $cancelledAt", (changes) => {
    const { db, record } = fixture();
    teamRuntime.create(db, record);
    expect(() =>
      teamRuntime.update(db, record.id, (draft) => {
        draft.messages.push({ ...message(), ...changes });
      }),
    ).toThrow(/cancellation/);
    expect(teamRuntime.get(db, record.id)?.messages).toEqual([]);
  });
});

function completedAssignment(db: Db, initial: TeamExecutionRecord) {
  teamJournalWriter(db).create(db, initial);
  return teamJournalWriter(db).update(db, initial.id, (draft) => {
    const child = addActor(db, draft);
    child.state = "completed";
    child.result = "Original result";
    const turn = attempt(draft, child.id);
    bindRun(db, draft, turn);
    runs.update(db, turn.runId!, { state: "success", endedAt: 2_000, externalSessionId: "retained-session" });
    turn.state = "closed";
    turn.endedAt = 2_000;
    draft.attempts.push(turn);
    return child;
  });
}
function followup(draft: TeamExecutionRecord, previous: TeamActorRecord, id: string, parentId = previous.parentId!) {
  const next = actor(id, previous.memberKey, previous.taskId, parentId);
  next.input.spec = `Follow-up ${id}`;
  draft.actors.push(next);
  return next;
}
function retainedOutput(db: Db, record: TeamExecutionRecord, child: TeamActorRecord, rootPath = "/tmp/retained-team") {
  const oid = (character: string) => character.repeat(40);
  const leadPath = `${rootPath}/lead`;
  const source = { rootPath, headSha: oid("a"), branch: "refs/heads/main", treeSha: oid("b"), treeRef: "refs/openorc/input/tree", headRef: "refs/openorc/input/head", indexSha256: "c".repeat(64) };
  const workspace = (owner: TeamActorRecord): TeamWorkspaceRecord => ({
    id: randomUUID(),
    executionId: record.id,
    actorId: owner.id,
    taskId: owner.taskId,
    parentActorId: owner.parentId,
    path: owner.id === "lead" ? leadPath : `${rootPath}/worker`,
    source: { ...source, rootPath: owner.id === "lead" ? rootPath : leadPath },
    state: "ready",
    setupState: "completed",
    preparedTree: oid("b"),
    outputTree: owner.id === "lead" ? null : oid("d"),
    error: null,
    createdAt: 3_000,
    updatedAt: 3_000,
  });
  const leadWorkspace = teamWorkspaces.save(db, workspace(record.actors[0]!));
  const childWorkspace = teamWorkspaces.save(db, workspace(child));
  const publication: TeamPublicationRecord = {
    id: randomUUID(),
    executionId: record.id,
    sourceActorId: child.id,
    targetActorId: "lead",
    outputTree: oid("d"),
    destinationPath: leadPath,
    before: { ...source, rootPath: leadPath },
    afterTree: oid("e"),
    scratchPath: `${rootPath}/scratch`,
    state: "planned",
    entries: [],
    includedActorIds: [child.id],
    error: null,
    createdAt: 4_000,
    updatedAt: 4_000,
  };
  return { leadWorkspace, childWorkspace, publication };
}

describe("reserved provider session ownership", () => {
  function establish(db: Db, record: TeamExecutionRecord, actorId = "lead", checkpointId?: string) {
    return teamRuntime.update(db, record.id, (draft) => {
      const source = {
        ...attempt(draft, actorId),
        ...(checkpointId ? { contextCheckpointId: checkpointId, contextSeed: "Canonical context" } : { resumeSessionId: null }),
        state: "closed" as const,
        endedAt: 2_000,
      };
      const runId = bindRun(db, draft, source);
      runs.update(db, runId, { externalSessionId: `session-${runId}`, state: "success", endedAt: 2_000 });
      draft.attempts.push(source);
      return `session-${runId}`;
    }).value;
  }

  it("retains immutable fresh and same-actor resumed choices while reading legacy omitted fields", () => {
    const { db, record } = fixture();
    teamRuntime.create(db, record);
    const session = establish(db, record);
    const resumed = teamRuntime.update(db, record.id, (draft) => {
      draft.attempts.push({ ...attempt(draft), resumeSessionId: session });
    }).record;
    expect(resumed.attempts.map((item) => item.resumeSessionId)).toEqual([null, session]);
    for (const choice of [undefined, null, "changed-session"]) {
      expect(() =>
        teamRuntime.update(db, record.id, (draft) => {
          draft.attempts[1]!.resumeSessionId = choice;
        }),
      ).toThrow(/immutable/);
    }
    expect(() =>
      teamRuntime.update(db, record.id, (draft) => {
        draft.attempts[0]!.resumeSessionId = session;
      }),
    ).toThrow(/immutable/);
    const legacy = teamRuntime.update(db, record.id, (draft) => {
      draft.attempts.push(attempt(draft));
    }).record;
    expect(teamRuntime.get(db, record.id)).toEqual(legacy);
  });

  it("rejects unknown, unbound and other-provider sessions", () => {
    const { db, record } = fixture();
    teamRuntime.create(db, record);
    const session = establish(db, record);
    const outside = runs.insert(db, { id: randomUUID(), taskId: null, threadId: record.threadId, ...settings, mode: "act", permissionMode: "trusted" });
    runs.update(db, outside.id, { externalSessionId: "ordinary-session" });
    for (const id of ["missing", "ordinary-session"]) {
      expect(() =>
        teamRuntime.update(db, record.id, (draft) => {
          draft.attempts.push({ ...attempt(draft), resumeSessionId: id });
        }),
      ).toThrow(/reserved session/);
    }
    expect(() =>
      teamRuntime.update(db, record.id, (draft) => {
        draft.attempts.push({ ...attempt(draft), settings: { ...settings, agent: "claude" }, resumeSessionId: session });
      }),
    ).toThrow(/reserved session/);
  });

  it("does not cross checkpoint boundaries or combine context and ordinary reservations", () => {
    const { db, record, instance } = fixture();
    teamRuntime.create(db, record);
    const context = teamContexts.create(db, {
      instanceId: instance.id,
      executionId: null,
      actorId: "lead",
      originExecutionId: null,
      reason: "compact",
      requestKey: "compact-session",
      seed: "Canonical context",
    });
    const session = establish(db, record, "lead", context.id);
    expect(() =>
      teamRuntime.update(db, record.id, (draft) => {
        draft.attempts.push({ ...attempt(draft), resumeSessionId: session });
      }),
    ).toThrow(/reserved session/);
    expect(() =>
      teamRuntime.update(db, record.id, (draft) => {
        draft.attempts.push({ ...attempt(draft), contextCheckpointId: context.id, contextSeed: "Seed", resumeSessionId: null });
      }),
    ).toThrow(/ordinary session reservation/);
  });

  it("permits lead continuation across its instance while keeping worker sessions inside their execution", () => {
    const { db, record } = fixture();
    const previous = completedAssignment(db, record);
    const leadSession = establish(db, record);
    teamRuntime.update(db, record.id, (draft) => {
      draft.state = "completed";
      draft.actors[0]!.state = "completed";
    });
    const next = teamRuntime.create(db, { ...record, id: randomUUID(), createdAt: 2_000, updatedAt: 2_000 });
    teamRuntime.update(db, next.id, (draft) => {
      followup(draft, previous.value, previous.value.id);
      draft.attempts.push({ ...attempt(draft), resumeSessionId: leadSession, createdAt: 2_000 });
    });
    expect(() =>
      teamRuntime.update(db, next.id, (draft) => {
        draft.attempts.push({ ...attempt(draft, previous.value.id), resumeSessionId: "retained-session", createdAt: 2_000 });
      }),
    ).toThrow(/reserved session/);
    const otherThread = threads.insert(db, { projectId: record.projectId, title: "Other instance", ...settings, mode: "act", permissionMode: "trusted" });
    const instance = orchestration.getInstance(db, record.threadId)!;
    const otherInstance = orchestration.createInstance(db, { threadId: otherThread.id, teamRevisionId: instance.teamRevisionId });
    const other = teamRuntime.create(db, { ...record, id: randomUUID(), threadId: otherThread.id, instanceId: otherInstance.id });
    expect(() =>
      teamRuntime.update(db, other.id, (draft) => {
        draft.attempts.push({ ...attempt(draft), resumeSessionId: leadSession });
      }),
    ).toThrow(/reserved session/);
  });
});

describe("historical assignment ownership", () => {
  it("retains exact bindings and original inputs when a completed task is reused in the same and a later execution", () => {
    const { db, record: initial } = fixture();
    const first = completedAssignment(db, initial);
    const child = first.value;
    const oldRun = first.record.attempts[0]!.runId!;
    const second = teamRuntime.update(db, initial.id, (draft) => followup(draft, child, "second")).record;
    expect(second.actors[1]).toEqual(child);
    expect(teamRuntime.assignment(db, initial.id, child.id)).toEqual({ taskId: child.taskId, executionId: initial.id, actorId: child.id });
    expect(teamRuntime.assignment(db, initial.id, "second")).toEqual({ taskId: child.taskId, executionId: initial.id, actorId: "second" });
    expect(teamRuntime.assignmentForTask(db, child.taskId!)).toEqual({ executionId: initial.id, actorId: "second" });
    expect(teamRuntime.assignmentsForTask(db, child.taskId!)).toHaveLength(2);
    expect(teamRuntime.binding(db, oldRun)?.actorId).toBe(child.id);
    expect(() =>
      teamRuntime.update(db, initial.id, (draft) => {
        draft.actors[1]!.state = "queued";
      }),
    ).toThrow();
    const closed = teamRuntime.update(db, initial.id, (draft) => {
      draft.state = "completed";
      for (const owner of draft.actors) owner.state = "completed";
    }).record;
    expect(teamRuntime.assignmentForTask(db, child.taskId!)).toEqual({ executionId: initial.id, actorId: "second" });
    const next = teamRuntime.create(db, { ...initial, id: randomUUID() });
    const third = teamRuntime.update(db, next.id, (draft) => followup(draft, child, "third")).record;
    expect(teamRuntime.assignmentForTask(db, child.taskId!)).toEqual({ executionId: next.id, actorId: "third" });
    expect(teamRuntime.assignmentsForTask(db, child.taskId!).map((binding) => binding.actorId)).toEqual([child.id, "second", "third"]);
    expect(teamRuntime.get(db, initial.id)).toEqual(closed);
    expect(teamRuntime.get(db, next.id)).toEqual(third);
    expect(tasks.list(db)).toHaveLength(1);
    expect(runs.get(db, oldRun)?.externalSessionId).toBe("retained-session");
  });

  it.each(["run", "descendant", "preparation", "captured output"])("retains ownership while %s evidence is unresolved", (barrier) => {
    const { db, record: initial } = fixture();
    const first = completedAssignment(db, initial);
    const child = first.value;
    if (barrier === "attempt")
      teamRuntime.update(db, initial.id, (draft) => {
        draft.attempts[0]!.endedAt = null;
        draft.attempts[0]!.state = "attention";
      });
    if (barrier === "run") runs.update(db, first.record.attempts[0]!.runId!, { state: "running", endedAt: null });
    if (barrier === "descendant") {
      // A completed manager with a still-live child cannot be reused either.
      const manager = teamRuntime.update(db, initial.id, (draft) => {
        const manager = addActor(db, draft, "manager-original", "manager");
        manager.state = "cancelled";
        addActor(db, draft, "child-active", "reviewer", manager.id);
        return manager;
      }).value;
      expect(() => teamRuntime.update(db, initial.id, (draft) => followup(draft, manager, "manager-reused"))).toThrow(/descendant/);
      return;
    }
    if (["preparation", "captured output", "publication"].includes(barrier)) {
      const retained = retainedOutput(db, first.record, child);
      if (barrier === "preparation") teamWorkspaces.save(db, { ...retained.childWorkspace, state: "attention", setupState: "blocked", error: "Setup did not finish" });
      if (barrier === "publication") teamWorkspaces.savePublication(db, { ...retained.publication, state: "attention", error: "Publication interrupted" });
    }
    const before = teamRuntime.get(db, initial.id);
    expect(() => teamRuntime.update(db, initial.id, (draft) => followup(draft, child, "unsafe"))).toThrow(/closing|recovery|integrated/);
    expect(teamRuntime.get(db, initial.id)).toEqual(before);
    expect(teamRuntime.assignmentsForTask(db, child.taskId!)).toHaveLength(1);
  });

  it("admits reuse after an output receipt becomes applied, retaining immutable integration evidence", () => {
    const { db, record: initial } = fixture();
    const first = completedAssignment(db, initial);
    const retained = retainedOutput(db, first.record, first.value);
    teamWorkspaces.savePublication(db, retained.publication);
    expect(() => teamRuntime.update(db, initial.id, (draft) => followup(draft, first.value, "too-soon"))).toThrow(/integrated/);
    const applied = teamWorkspaces.savePublication(db, { ...retained.publication, state: "applied" });
    teamRuntime.update(db, initial.id, (draft) => followup(draft, first.value, "safe"));
    expect(teamWorkspaces.publications(db, initial.id)).toEqual([applied]);
    expect(teamWorkspaces.get(db, initial.id, first.value.id)).toEqual(retained.childWorkspace);
    expect(teamRuntime.assignmentsForTask(db, first.value.taskId!)).toHaveLength(2);
  });

  it.each(["thread"])("retains all task history until owning %s cleanup", (owner) => {
    const { db, record: initial, instance, thread, project } = fixture();
    const first = completedAssignment(db, initial);
    const retained = retainedOutput(db, first.record, first.value);
    const applied = teamWorkspaces.savePublication(db, { ...retained.publication, state: "applied" });
    teamRuntime.update(db, initial.id, (draft) => followup(draft, first.value, "retained-followup"));
    const checkpoint = teamContexts.create(db, {
      instanceId: instance.id,
      executionId: initial.id,
      actorId: first.value.id,
      originExecutionId: initial.id,
      reason: "fresh_retry",
      requestKey: "retained-context",
      seed: "Original assignment history",
    });
    expect(() => tasks.delete(db, first.value.taskId!)).toThrow(/FOREIGN KEY/);
    expect(teamRuntime.assignmentsForTask(db, first.value.taskId!)).toHaveLength(2);
    if (owner === "thread") threads.delete(db, thread.id);
    else db.stmt("DELETE FROM projects WHERE id = ?").run(project.id);
    expect(teamRuntime.assignmentsForTask(db, first.value.taskId!)).toEqual([]);
    expect(teamRuntime.get(db, initial.id)).toBeNull();
    expect(teamContexts.get(db, checkpoint.id)).toBeNull();
    expect(teamWorkspaces.publications(db, initial.id)).toEqual([]);
    expect(db.stmt("SELECT id FROM team_publications WHERE id = ?").get(applied.id)).toBeUndefined();
    expect(db.raw.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("migrates fixed v11 without changing binding order, contexts, receipts, attempts or sessions", () => {
    const folder = mkdtempSync(path.join(os.tmpdir(), "team-assignment-v12-"));
    folders.push(folder);
    const file = path.join(folder, "ledger.sqlite");
    const raw = new DatabaseSync(file);
    for (const migration of migrations.slice(0, 11)) typeof migration === "string" ? raw.exec(migration) : migration(raw);
    raw.exec("PRAGMA user_version = 11");
    const restore = readLegacyJournals();
    const { db, record: initial, instance } = fixture(new Db(raw));
    const first = completedAssignment(db, initial);
    const checkpoint = teamContexts.create(db, {
      instanceId: instance.id,
      executionId: initial.id,
      actorId: first.value.id,
      originExecutionId: initial.id,
      reason: "fresh_retry",
      requestKey: "old-context",
      seed: "Retained canonical history",
    });
    const retained = retainedOutput(db, first.record, first.value, folder);
    const applied = teamWorkspaces.savePublication(db, { ...retained.publication, state: "applied" });
    const secondTask = legacyTeamRuntime.update(db, initial.id, (draft) => {
      const extra = addActor(db, draft, "another-task", "manager");
      extra.state = "completed";
      return extra;
    }).record;
    const oldRows = db.stmt("SELECT rowid, task_id, execution_id, actor_id FROM team_assignment_bindings ORDER BY rowid").all();
    const oldRun = runs.get(db, first.record.attempts[0]!.runId!)!;
    restore();
    db.close();
    opened.splice(opened.indexOf(db), 1);
    const migrated = Db.open(file);
    opened.push(migrated);
    expect(migrated.version).toBe(migrations.length);
    expect(migrated.stmt("SELECT binding_order AS rowid, task_id, execution_id, actor_id FROM team_assignment_bindings ORDER BY binding_order").all()).toEqual(oldRows);
    expect(teamRuntime.get(migrated, initial.id)).toEqual(secondTask);
    expect(teamRuntime.prompt(migrated, initial.id, first.record.attempts[0]!.id)).toBe(LEGACY_TEAM_PROMPT);
    expect(teamContexts.get(migrated, checkpoint.id)).toEqual(checkpoint);
    expect(teamWorkspaces.publications(migrated, initial.id)).toEqual([applied]);
    expect(runs.get(migrated, oldRun.id)).toEqual({ ...oldRun, workingDirectory: null, commentTurnId: null });
    const updated = teamRuntime.update(migrated, initial.id, (draft) => followup(draft, first.value, "after-migration")).record;
    expect(
      teamContexts.create(migrated, {
        instanceId: instance.id,
        executionId: initial.id,
        actorId: "after-migration",
        originExecutionId: initial.id,
        reason: "fresh_retry",
        requestKey: "new-context",
        seed: "New actor context",
      }).actorId,
    ).toBe("after-migration");
    expect(teamRuntime.assignment(migrated, initial.id, first.value.id)?.taskId).toBe(first.value.taskId);
    expect(teamRuntime.assignmentForTask(migrated, first.value.taskId!)?.actorId).toBe("after-migration");
    migrated.close();
    opened.splice(opened.indexOf(migrated), 1);
    const reopened = Db.open(file);
    opened.push(reopened);
    expect(teamRuntime.get(reopened, initial.id)).toEqual(updated);
    expect(teamRuntime.assignmentsForTask(reopened, first.value.taskId!).map((item) => item.actorId)).toEqual([first.value.id, "after-migration"]);
    expect(reopened.raw.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});

describe("reserved team mode and retained planning hold", () => {
  it("keeps reserved mode immutable and requires the bound provider run to agree", () => {
    const { db, record } = fixture();
    teamRuntime.create(db, record);
    teamRuntime.update(db, record.id, (state) => {
      const turn = attempt(state);
      turn.mode = "act";
      bindRun(db, state, turn);
      state.attempts.push(turn);
    });
    expect(() =>
      teamRuntime.update(db, record.id, (state) => {
        state.attempts[0]!.mode = "plan";
      }),
    ).toThrow(/immutable/);
    expect(() =>
      teamRuntime.update(db, record.id, (state) => {
        const turn = attempt(state);
        turn.mode = "plan";
        bindRun(db, state, turn);
        state.attempts.push(turn);
      }),
    ).toThrow(/run mode differs/);
    expect(() =>
      teamRuntime.update(db, record.id, (state) => {
        const legacy = attempt(state);
        bindRun(db, state, legacy);
        state.attempts.push(legacy);
      }),
    ).not.toThrow();
    expect(teamRuntime.get(db, record.id)!.attempts[1]!.mode).toBeUndefined();
  });

  it("retains a lead planning hold across reopen and rejects attaching one to a worker", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "openorc-mode-hold-"));
    folders.push(directory);
    const file = path.join(directory, "ledger.sqlite");
    const { db, record } = fixture(Db.open(file));
    teamRuntime.create(db, record);
    const retained = teamRuntime.update(db, record.id, (state) => {
      state.actors[0]!.state = "waiting";
      state.actors[0]!.modeHold = "plan";
      addActor(db, state);
    }).record;
    opened.splice(opened.indexOf(db), 1);
    db.close();
    const reopened = Db.open(file);
    opened.push(reopened);
    expect(teamRuntime.get(reopened, record.id)).toEqual(retained);
    expect(() =>
      teamRuntime.update(reopened, record.id, (state) => {
        state.actors[1]!.modeHold = "plan";
      }),
    ).toThrow(/reserved for the lead/);
    const released = teamRuntime.update(reopened, record.id, (state) => {
      delete state.actors[0]!.modeHold;
      state.actors[0]!.state = "queued";
    }).record;
    expect(released.actors[0]!.modeHold).toBeUndefined();
  });
});
