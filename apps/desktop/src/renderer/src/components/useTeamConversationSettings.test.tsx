import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { queryClient } from "../lib/query";
import { useTeamConversationSettings } from "./useTeamConversationSettings";

const rpc = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("../lib/rpc", () => ({ core: { call: rpc.call, onInvalidate: () => {}, onReady: () => {} } }));

const thread = { id: "thread", mode: "act" as const, permissionMode: "trusted" as const, updatedAt: 1 };
const data = { instance: { leadOverrides: {}, configurationVersion: 1 } };
const leadSettings = { agent: "codex" as const, model: "gpt-6-sol", effort: "medium", fastMode: false };
const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;

afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.resetAllMocks();
});

it("serializes rapid lead and policy writes before allowing the message", async () => {
  let finishLead!: (value: unknown) => void;
  let finishPolicy!: (value: unknown) => void;
  rpc.call.mockImplementation((method: string) => {
    if (method === "orchestration.configureLead") return new Promise((resolve) => (finishLead = resolve));
    if (method === "threads.update") return new Promise((resolve) => (finishPolicy = resolve));
    throw new Error(`Unexpected ${method}`);
  });
  const { result } = renderHook(() => useTeamConversationSettings({ thread, data, leadSettings }), { wrapper });
  act(() => {
    result.current.lead.change({ ...leadSettings, effort: "high" });
    result.current.policy.change({ mode: "plan" });
  });
  const settled = result.current.waitForSaved();
  await waitFor(() => expect(rpc.call.mock.calls.map(([method]) => method)).toEqual(["orchestration.configureLead"]));
  await act(async () => finishLead({ instance: { leadOverrides: { effort: "high" }, configurationVersion: 2 } }));
  await waitFor(() => expect(rpc.call.mock.calls.map(([method]) => method)).toEqual(["orchestration.configureLead", "threads.update"]));
  await act(async () => finishPolicy({ mode: "plan", permissionMode: "trusted", updatedAt: 2 }));
  await settled;
  expect(rpc.call.mock.calls[1]?.[1].patch).toEqual({ mode: "plan" });
  expect(result.current.lead.error).toBeNull();
  expect(result.current.policy.error).toBeNull();
});

it("blocks a message after a failed policy save until retry or reset", async () => {
  rpc.call.mockRejectedValueOnce(new Error("Save refused"));
  const { result } = renderHook(() => useTeamConversationSettings({ thread, data, leadSettings }), { wrapper });
  act(() => result.current.policy.change({ permissionMode: "review" }));
  await waitFor(() => expect(result.current.policy.error).toBe("Save refused"));
  await expect(result.current.waitForSaved()).rejects.toThrow("Save or reset the selected settings before sending. Save refused");
  act(() => result.current.policy.reset());
  await expect(result.current.waitForSaved()).resolves.toBeUndefined();
  expect(result.current.policy.editing).toBeNull();
});

it("keeps the latest rapid policy selection while serial saves finish", async () => {
  const finish: ((value: unknown) => void)[] = [];
  rpc.call.mockImplementation((method: string) => {
    if (method !== "threads.update") throw new Error(`Unexpected ${method}`);
    return new Promise((resolve) => finish.push(resolve));
  });
  const { result } = renderHook(() => useTeamConversationSettings({ thread, data, leadSettings }), { wrapper });
  act(() => {
    result.current.policy.change({ mode: "plan" });
    result.current.policy.change({ mode: "act" });
  });
  await waitFor(() => expect(finish).toHaveLength(1));
  await act(async () => finish[0]!({ mode: "plan", permissionMode: "trusted", updatedAt: 2 }));
  await waitFor(() => expect(finish).toHaveLength(2));
  await act(async () => finish[1]!({ mode: "act", permissionMode: "trusted", updatedAt: 2 }));
  await waitFor(() => expect(result.current.policy.editing).toBeNull());
  expect(rpc.call.mock.calls.map(([, input]) => input.patch)).toEqual([{ mode: "plan" }, { mode: "act" }]);
  expect(result.current.policy.value.mode).toBe("act");
});
