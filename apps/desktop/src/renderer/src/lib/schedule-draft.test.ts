import { Schedule } from "@openorc/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  beginScheduleTrigger,
  finishScheduleTrigger,
  readScheduleTrigger,
  scheduleDraftIssue,
  scheduleModelTarget,
  scheduleTarget,
  scheduleTargetChoice,
  scheduleTargetPayload,
} from "./schedule-draft";
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
    expect(scheduleTargetPayload(target)).toEqual({ executionTarget: null, agent: "codex", model: null, effort: null });
  });

  it("uses an explicit model target for effort and Fast, without team or legacy fields", () => {
    const target = scheduleModelTarget({ agent: "claude", model: "fixture-model", effort: "high", fastMode: true });
    expect(scheduleTargetPayload(target)).toEqual({ executionTarget: { kind: "model", settings: { agent: "claude", model: "fixture-model", effort: "high", fastMode: true } } });
    expect(() => scheduleTargetPayload(scheduleTarget(null))).toThrow("Choose a model");
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

it("requires a new model when editing a retired team schedule", () => {
  const target = scheduleTarget({ ...schedule(), retiredTeam: true });
  expect(target).toEqual({ kind: "unselected" });
  expect(scheduleDraftIssue("project", ["project"], target).targetIssue).toBe("Choose a model.");
});
