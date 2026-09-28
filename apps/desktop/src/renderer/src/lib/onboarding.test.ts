import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeOnboardingState, readOnboardingState, resolveOnboarding, writeOnboardingState } from "./onboarding";

afterEach(() => vi.unstubAllGlobals());

describe("onboarding persistence", () => {
  it("migrates a legacy default into the selected harness list", () => {
    const stored = {
      version: 1,
      step: "project",
      completedAt: null,
      defaultHarness: "claude",
    };

    const decoded = decodeOnboardingState(stored);

    expect(decoded).toEqual({ ...stored, selectedHarnesses: ["claude"] });
    expect(decoded).not.toBe(stored);
  });

  it("drops a default that is not one of the selected harnesses", () => {
    expect(
      decodeOnboardingState({
        version: 1,
        step: "default",
        completedAt: null,
        selectedHarnesses: ["codex"],
        defaultHarness: "claude",
      }),
    ).toEqual({
      version: 1,
      step: "default",
      completedAt: null,
      selectedHarnesses: ["codex"],
      defaultHarness: null,
    });
  });

  it.each([
    { version: 0, step: "done", completedAt: 1, defaultHarness: "claude" },
    { version: 2, step: "done", completedAt: 1, defaultHarness: "claude" },
    { version: 1, step: "unknown", completedAt: null, defaultHarness: null },
    { version: 1, step: "done", completedAt: -1, defaultHarness: "claude" },
    { version: 1, step: "done", completedAt: 1, defaultHarness: "pi" },
  ])("treats missing, older, newer, or malformed state as fresh", (stored) => {
    expect(decodeOnboardingState(stored)).toEqual({
      version: 1,
      step: "scan",
      completedAt: null,
      selectedHarnesses: null,
      defaultHarness: null,
    });
  });

  it("round-trips the live state through one stable storage key", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
    const state = {
      version: 1,
      step: "done",
      completedAt: 42,
      selectedHarnesses: ["claude", "codex"],
      defaultHarness: "codex",
    } as const;

    expect(writeOnboardingState(state)).toBe(true);
    expect([...values.keys()]).toEqual(["openorc.onboarding"]);
    expect(readOnboardingState()).toEqual(state);
  });

  it("falls back safely when persisted JSON is malformed", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => "{not-json",
    });

    expect(readOnboardingState()).toEqual({
      version: 1,
      step: "scan",
      completedAt: null,
      selectedHarnesses: null,
      defaultHarness: null,
    });
  });

  it("reports when browser storage cannot save progress", () => {
    vi.stubGlobal("localStorage", {
      setItem: () => {
        throw new Error("quota exceeded");
      },
    });

    expect(
      writeOnboardingState({
        version: 1,
        step: "done",
        completedAt: 42,
        selectedHarnesses: ["claude"],
        defaultHarness: "claude",
      }),
    ).toBe(false);
  });
});

describe("onboarding resolution", () => {
  it("keeps a new user on the scan until a harness is ready", () => {
    expect(
      resolveOnboarding({
        persisted: null,
        harnesses: [
          { id: "claude", state: "sign_in" },
          { id: "codex", state: "not_found" },
        ],
        projectCount: 0,
      }),
    ).toEqual({
      mode: "first_run",
      step: "scan",
      reason: "harness_required",
      state: {
        version: 1,
        step: "scan",
        completedAt: null,
        selectedHarnesses: [],
        defaultHarness: null,
      },
    });
  });

  it("does not report a failed check as a missing harness", () => {
    expect(
      resolveOnboarding({
        persisted: null,
        harnesses: [
          { id: "claude", state: "check_failed" },
          { id: "codex", state: "not_found" },
        ],
        projectCount: 0,
      }),
    ).toMatchObject({
      mode: "first_run",
      step: "scan",
      reason: "harness_check_failed",
    });
  });

  it("requires a default only after multiple selected harnesses leave the scan", () => {
    expect(
      resolveOnboarding({
        persisted: {
          version: 1,
          step: "default",
          completedAt: null,
          selectedHarnesses: ["claude", "codex"],
          defaultHarness: null,
        },
        harnesses: [
          { id: "claude", state: "ready" },
          { id: "codex", state: "ready" },
        ],
        projectCount: 0,
      }),
    ).toMatchObject({
      mode: "first_run",
      step: "default",
      reason: "default_required",
    });
  });

  it("keeps an explicit empty selection on the scan after rescanning", () => {
    expect(
      resolveOnboarding({
        persisted: {
          version: 1,
          step: "scan",
          completedAt: null,
          selectedHarnesses: [],
          defaultHarness: null,
        },
        harnesses: [
          { id: "claude", state: "ready" },
          { id: "codex", state: "ready" },
        ],
        projectCount: 0,
      }),
    ).toMatchObject({
      step: "scan",
      state: { selectedHarnesses: [], defaultHarness: null },
    });
  });

  it("resumes the optional theme step without changing the mode or reason", () => {
    expect(
      resolveOnboarding({
        persisted: {
          version: 1,
          step: "theme",
          completedAt: null,
          selectedHarnesses: ["claude", "codex"],
          defaultHarness: "claude",
        },
        harnesses: [
          { id: "claude", state: "ready" },
          { id: "codex", state: "ready" },
        ],
        projectCount: 0,
      }),
    ).toEqual({
      mode: "first_run",
      step: "theme",
      reason: "project_required",
      state: {
        version: 1,
        step: "theme",
        completedAt: null,
        selectedHarnesses: ["claude", "codex"],
        defaultHarness: "claude",
      },
    });
  });

  it("sends an existing user with no ready harness to recovery instead of replaying setup", () => {
    expect(
      resolveOnboarding({
        persisted: null,
        harnesses: [
          { id: "claude", state: "sign_in" },
          { id: "codex", state: "not_found" },
        ],
        projectCount: 3,
      }),
    ).toEqual({
      mode: "recovery",
      step: "scan",
      reason: "harness_recovery",
      state: {
        version: 1,
        step: "scan",
        completedAt: null,
        selectedHarnesses: null,
        defaultHarness: null,
      },
    });
  });

  it("does not replay completed steps for an existing user with a usable harness and project", () => {
    expect(
      resolveOnboarding({
        persisted: {
          version: 0,
          step: "project",
          completedAt: null,
          defaultHarness: null,
        },
        harnesses: [
          { id: "claude", state: "ready" },
          { id: "codex", state: "not_found" },
        ],
        projectCount: 2,
      }),
    ).toEqual({
      mode: "done",
      step: "done",
      reason: "complete",
      state: {
        version: 1,
        step: "done",
        completedAt: null,
        selectedHarnesses: ["claude"],
        defaultHarness: "claude",
      },
    });
  });
});
