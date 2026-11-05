import type { ThreadSummary } from "@openorc/protocol";
import { NOT_ON_BRAIN, WORKSPACE_ID } from "@openorc/protocol";
import { expect, it } from "vitest";
import { canMoveToCloud, cloudPlaceLabel, cloudStartBlocked } from "./cloud-start.js";

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
