import type { ThreadSummary } from "@openorc/protocol";
import { WORKSPACE_ID } from "@openorc/protocol";
import { expect, it } from "vitest";
import { canMoveToCloud, cloudPlaceLabel } from "./cloud-start.js";

const thread = (more: Partial<ThreadSummary>) => ({ agent: "claude", projectId: "openorc", teamInstanceId: null, cloud: undefined, ...more }) as ThreadSummary;

it("moves a project's Claude or Codex conversation on this Mac, and nothing else", () => {
  expect(canMoveToCloud(thread({}))).toBe(true);
  expect(canMoveToCloud(thread({ agent: "codex" }))).toBe(true);
  expect(canMoveToCloud(thread({ agent: "opencode" }))).toBe(false);
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
