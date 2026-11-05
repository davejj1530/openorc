import type { ThreadSummary } from "@openorc/protocol";
import { NOT_ON_BRAIN, WORKSPACE_ID } from "@openorc/protocol";
import { expect, it } from "vitest";
import { canMoveToCloud, cloudPlaceLabel, cloudStartBlocked, cloudStartSteps, threadMoveCard, type StartingCloudThread } from "./cloud-start.js";

const thread = (more: Partial<ThreadSummary>) => ({ agent: "claude", projectId: "openorc", teamInstanceId: null, cloud: undefined, ...more }) as ThreadSummary;

it("moves a project's conversation on this Mac, whichever agent it has, and nothing else", () => {
  for (const agent of ["claude", "codex", "opencode"] as const) expect(canMoveToCloud(thread({ agent }))).toBe(true);
  expect(canMoveToCloud(thread({ agent: "acp" }))).toBe(false);
  expect(canMoveToCloud(thread({ projectId: WORKSPACE_ID }))).toBe(false);
  expect(canMoveToCloud(thread({ teamInstanceId: "team-1" }))).toBe(false);
  expect(canMoveToCloud(thread({ cloud: { provider: "vercel", state: "ready", step: null, setup: false, error: null } }))).toBe(false);
});

it("names where a cloud thread runs, or that its sandbox is gone", () => {
  const cloud = { provider: "vercel", state: "ready", step: null, setup: false, error: null } as const;
  expect(cloudPlaceLabel(cloud)).toBe("Vercel Sandbox");
  expect(cloudPlaceLabel({ ...cloud, provider: "local" })).toBe("Simulated sandbox");
  expect(cloudPlaceLabel({ ...cloud, state: "removed" })).toBe("Sandbox removed");
});

it("starts a new cloud thread on the cloud brain only for a project it has a copy of; without a brain, anywhere", () => {
  const brain = { host: "brain-key", projects: [{ mac: "openorc", cloud: "brain-openorc" }] };
  expect(cloudStartBlocked({ brain }, "openorc")).toBeNull();
  expect(cloudStartBlocked({ brain }, "website")).toBe(NOT_ON_BRAIN);
  expect(cloudStartBlocked({ brain: null }, "website")).toBeNull();
  expect(cloudStartBlocked({}, "website")).toBeNull();
  expect(cloudStartBlocked(undefined, "website")).toBeNull();
});

it("starts a thread on the cloud brain by waking it, updated first when this Mac carries a newer one, then the brain's own steps", () => {
  const starting = (cloud: Partial<StartingCloudThread["cloud"]>, more: Partial<ThreadSummary> = {}) =>
    thread({
      owner: { brain: "cloud", reach: "waking", heardAt: 1 },
      queued: [{ id: "m", text: "Fix it", attachments: [], queuedAt: 1 }],
      cloud: { provider: "agent37", state: "preparing", step: null, setup: true, error: null, ...cloud },
      ...more,
    }) as StartingCloudThread;
  const steps = (each: StartingCloudThread) => cloudStartSteps(each).map(({ label, state }) => `${label}: ${state}`);
  expect(steps(starting({ brain: "waking" }))).toEqual([
    "Waking the cloud brain: running",
    "Starting an Agent37 instance: pending",
    "Sending your code: pending",
    "Running the setup script: pending",
    "Starting Claude: pending",
  ]);
  expect(steps(starting({ brain: "updating" }))[0]).toBe("Updating the cloud brain: running");
  expect(steps(starting({ step: "code" }, { owner: { brain: "cloud", reach: "live", heardAt: 1 } })).slice(0, 3)).toEqual([
    "Waking the cloud brain: done",
    "Starting an Agent37 instance: done",
    "Sending your code: running",
  ]);
  // One on this Mac has no brain to wake.
  expect(steps(starting({ step: "sandbox" }, { owner: undefined }))[0]).toBe("Starting an Agent37 instance: running");
  // Its start card says the brain wakes; no second card does.
  expect(threadMoveCard(starting({ brain: "waking" }))).toBeNull();
});
