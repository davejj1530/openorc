import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useCloudThreadSettings } from "./task-thread-action";

const reads = vi.hoisted(() => ({
  permission: { permission: "trusted", ready: true },
  models: [
    { id: "gpt-6-sol", label: "GPT-6 Sol", agent: "codex", isDefault: true, efforts: ["medium"], defaultEffort: "medium" },
    { id: "claude-sonnet-5", label: "Sonnet 5", agent: "claude", isDefault: true, efforts: ["medium"], defaultEffort: "medium" },
  ],
}));
vi.mock("./client", async (original) => ({
  ...(await original<object>()),
  useRpc: (method: string) => ({ data: method === "agents.models" ? reads.models : {} }),
  usePermissionSelection: () => reads.permission,
}));
vi.mock("./default-harness", () => ({ useDefaultHarness: () => "claude" }));
beforeEach(() => {
  reads.permission = { permission: "trusted", ready: true };
});
afterEach(cleanup);

it("opens a task's new thread with the person's own permission, as their other cloud threads start", () => {
  const { result } = renderHook(() => useCloudThreadSettings());
  expect(result.current).toEqual({ agent: "claude", model: "claude-sonnet-5", effort: "medium", mode: "act", permissionMode: "trusted" });
});

it("sends no settings until the person's permission is read, so the server's default never stands in for it", () => {
  reads.permission = { permission: "autonomous", ready: false };
  const { result } = renderHook(() => useCloudThreadSettings());
  expect(result.current).toBeNull();
});
