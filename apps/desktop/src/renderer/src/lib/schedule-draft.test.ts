import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_TEAM_LIMITS, Schedule, TeamRevision } from "@openorc/protocol";
import {
  beginScheduleTrigger,
  finishScheduleTrigger,
  readScheduleTrigger,
  scheduleDraftIssue,
  scheduleModelTarget,
  scheduleTarget,
  scheduleTargetChoice,
  scheduleTargetPayload,
  scheduleTargetSettings,
  scheduleTeamTarget,
} from "./schedule-draft";

const revision = TeamRevision.parse({
  id: "revision-1",
  teamId: "team",
  projectId: "project",
  number: 1,
  createdAt: 1,
  name: "Saved team",
  members: [{ key: "lead", name: "Lead", managerKey: null, responsibility: "Coordinate", settings: { agent: "codex", model: "fixture-model", effort: "medium", fastMode: false } }],
  limits: DEFAULT_TEAM_LIMITS,
});
function schedule() {
  return Schedule.parse({
    id: "schedule",
    projectId: "project",
    title: "Review",
    prompt: "Inspect the repository",
    agent: "codex",
    model: null,
    effort: null,
    mode: "plan",
    permissionMode: "trusted",
    workspaceMode: "current",
    everyMinutes: 60,
    version: 1,
    enabled: true,
    lastRunAt: null,
    nextRunAt: 2,
    lastThreadId: null,
    createdAt: 1,
    updatedAt: 1,
  });
}

describe("schedule target retention", () => {
  it("preserves a legacy provider default on an unrelated edit", () => {
    const target = scheduleTarget(schedule());
    expect(scheduleTargetChoice(target)).toBeNull();
    expect(scheduleTargetPayload(target, "project")).toEqual({ executionTarget: null, agent: "codex", model: null, effort: null });
  });

  it("keeps the exact archived revision and overrides without needing an online catalog", () => {
    const saved = {
      ...schedule(),
      executionTarget: { kind: "team" as const, teamRevisionId: revision.id, initialLeadOverrides: { effort: "high", fastMode: true } },
      team: { revision, archived: true },
    };
    const target = scheduleTarget(saved);
    expect(target).toMatchObject({ kind: "team", revision: { id: "revision-1", number: 1 }, archived: true });
    expect(scheduleTargetChoice(target)).toEqual({ agent: "codex", model: "fixture-model", effort: "high", fastMode: true });
    expect(scheduleTargetPayload(target, "project")).toEqual({ executionTarget: saved.executionTarget, workspaceMode: "worktree" });
    expect(revision.members[0]!.settings).toMatchObject({ effort: "medium", fastMode: false });
  });

  it("retains unavailable team metadata and rejects a project mismatch instead of substituting a model", () => {
    const target = scheduleTarget({ ...schedule(), executionTarget: { kind: "team", teamRevisionId: "older-revision" } });
    expect(scheduleTargetChoice(target)).toBeNull();
    expect(scheduleTargetPayload(target, "project")).toEqual({ executionTarget: { kind: "team", teamRevisionId: "older-revision" }, workspaceMode: "worktree" });
    expect(() => scheduleTargetPayload(target, "other-project")).toThrow("belongs to another project");
    expect(target.kind).toBe("team");
  });

  it("uses an explicit model target for effort and Fast, without team or legacy fields", () => {
    const target = scheduleModelTarget({ agent: "claude", model: "fixture-model", effort: "high", fastMode: true });
    expect(scheduleTargetPayload(target, "project")).toEqual({ executionTarget: { kind: "model", settings: { agent: "claude", model: "fixture-model", effort: "high", fastMode: true } } });
    expect(() => scheduleTargetPayload(scheduleTarget(null), "project")).toThrow("Choose a model");
  });

  it("retains a selected team through a project mismatch and changes only its lead overrides", () => {
    const target = scheduleTeamTarget(revision);
    const changed = scheduleTargetSettings(target, { agent: "codex", model: "fixture-model", effort: "high", fastMode: true });
    expect(changed).toMatchObject({ kind: "team", target: { teamRevisionId: "revision-1", initialLeadOverrides: { effort: "high", fastMode: true } } });
    expect(scheduleDraftIssue("other-project", ["project", "other-project"], changed, false, false).targetIssue).toContain("belongs to another project");
    expect(scheduleDraftIssue("project", ["project"], changed, true, false).targetIssue).toContain("archived");
    expect(scheduleDraftIssue("project", ["project"], changed, true, true)).toEqual({ projectIssue: null, targetIssue: null });
    expect(scheduleTargetPayload(changed, "project")).toMatchObject({ executionTarget: { teamRevisionId: "revision-1" } });
  });
});

describe("durable manual schedule requests", () => {
  let storage: Map<string, string>;
  beforeEach(() => {
    storage = new Map();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
      removeItem: (key: string) => {
        storage.delete(key);
      },
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("reuses a lost-response key after reload and schedule edits, then permits a new intentional run", () => {
    expect(beginScheduleTrigger("schedule", () => "first")).toBe("first");
    expect(readScheduleTrigger("schedule")).toBe("first");
    expect(beginScheduleTrigger("schedule", () => "would-duplicate")).toBe("first");
    expect(beginScheduleTrigger("another-schedule", () => "separate")).toBe("separate");
    expect(finishScheduleTrigger("schedule", "first")).toBe(true);
    expect(beginScheduleTrigger("schedule", () => "next-intent")).toBe("next-intent");
  });

  it("cannot start without durable storage and cannot erase another request", () => {
    vi.spyOn(localStorage, "setItem").mockImplementationOnce(() => {
      throw new Error("full");
    });
    expect(() => beginScheduleTrigger("schedule", () => "unsaved")).toThrow("no run was requested");
    expect(readScheduleTrigger("schedule")).toBeNull();
    beginScheduleTrigger("schedule", () => "newer");
    expect(finishScheduleTrigger("schedule", "older")).toBe(false);
    expect(readScheduleTrigger("schedule")).toBe("newer");
  });

  it("retains confirmed requests when cleanup fails and refuses to replace corrupt recovery records", () => {
    beginScheduleTrigger("schedule", () => "accepted");
    vi.spyOn(localStorage, "removeItem").mockImplementationOnce(() => {
      throw new Error("storage unavailable");
    });
    expect(finishScheduleTrigger("schedule", "accepted")).toBe(false);
    expect(beginScheduleTrigger("schedule", () => "duplicate")).toBe("accepted");
    storage.set("openorc.draft.schedule.schedule.trigger", "broken JSON");
    expect(() => beginScheduleTrigger("schedule", () => "duplicate")).toThrow("retained to prevent duplicate");
    expect(storage.get("openorc.draft.schedule.schedule.trigger")).toBe("broken JSON");
  });
});
