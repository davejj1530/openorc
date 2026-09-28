import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { queryClient } from "./query";
import { useConversationSettings } from "./conversation-settings";

const rpc = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("./rpc", () => ({ core: { call: rpc.call, onInvalidate: () => {}, onReady: () => {} } }));
const thread = { id: "thread", agent: "codex" as const, model: "gpt-6-sol", effort: "medium", fastMode: false, mode: "act" as const, permissionMode: "trusted" as const };
const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.resetAllMocks();
});

it("saves rapid choices in order and holds send until both writes finish", async () => {
  const finish: ((value: unknown) => void)[] = [];
  rpc.call.mockImplementation((method: string) => {
    if (method === "threads.update") return new Promise((resolve) => finish.push(resolve));
    return Promise.resolve({});
  });
  const { result } = renderHook(() => useConversationSettings({ thread, activeRun: undefined }), { wrapper });
  act(() => {
    result.current.selectMode("plan");
    result.current.selectMode("act");
  });
  const sent = vi.fn();
  const saving = result.current.waitForSave().then(sent);
  await waitFor(() => expect(finish).toHaveLength(1));
  await act(async () => finish[0]!({}));
  await waitFor(() => expect(finish).toHaveLength(2));
  expect(sent).not.toHaveBeenCalled();
  await act(async () => {
    finish[1]!({});
    await saving;
  });
  expect(sent).toHaveBeenCalledOnce();
  expect(rpc.call.mock.calls.filter(([method]) => method === "threads.update").map(([, input]) => input.patch)).toEqual([{ mode: "plan" }, { mode: "act" }]);
});

it("blocks send after a failed save and recovers on the next selection", async () => {
  rpc.call.mockImplementation((method: string) => (method === "threads.update" ? Promise.reject(new Error("Save refused")) : Promise.resolve({})));
  const { result } = renderHook(() => useConversationSettings({ thread, activeRun: undefined }), { wrapper });
  act(() => result.current.selectMode("plan"));
  await expect(result.current.waitForSave()).rejects.toThrow("Save refused");
  await waitFor(() => expect(result.current.error?.message).toBe("Save refused"));
  rpc.call.mockResolvedValue({});
  act(() => result.current.selectMode("act"));
  await act(async () => {
    await result.current.waitForSave();
  });
  expect(result.current.mode).toBe("act");
});
