import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { queryClient } from "../lib/query";
import { readDraft } from "../lib/drafts";
import { useRecoverableTeamSend, useTeamConversationDraft } from "./useTeamConversationMessage";

const rpc = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("../lib/rpc", () => ({ core: { call: rpc.call, onInvalidate: () => {}, onReady: () => {} } }));

const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
afterEach(() => {
  cleanup();
  queryClient.clear();
  localStorage.clear();
  vi.useRealTimers();
  vi.resetAllMocks();
});

it("retries an uncertain send with the same request key and original delivery mode after remount", async () => {
  rpc.call.mockRejectedValueOnce(new Error("Response lost")).mockResolvedValueOnce({});
  const changePrompt = vi.fn();
  const reportDraftError = vi.fn();
  const input = { threadId: "team", waitForSaved: async () => {}, changePrompt, reportDraftError };
  const first = renderHook(() => useRecoverableTeamSend(input), { wrapper });
  await act(async () => {
    await expect(first.result.current.submit("Please review", ["image.png"], true)).rejects.toThrow("Response lost");
  });
  const saved = readDraft("conversation.team.send", { key: "", body: "", attachments: "", now: false });
  expect(saved).toMatchObject({ body: "Please review", attachments: '["image.png"]', now: true });
  expect(saved.key).toBeTruthy();
  first.unmount();

  const second = renderHook(() => useRecoverableTeamSend(input), { wrapper });
  await act(async () => second.result.current.submit("Please review", ["image.png"], false));
  expect(rpc.call.mock.calls.map(([, params]) => ({ key: params.requestKey, now: params.now }))).toEqual([
    { key: saved.key, now: true },
    { key: saved.key, now: true },
  ]);
  expect(readDraft("conversation.team.send", { key: "" }).key).toBe("");
  expect(changePrompt).toHaveBeenCalledWith("");
  expect(reportDraftError).not.toHaveBeenCalled();
});

it("persists a draft locally before the delayed retained-task thread save", async () => {
  vi.useFakeTimers();
  rpc.call.mockResolvedValue({});
  const thread = { id: "team", draft: null };
  const { result } = renderHook(() => useTeamConversationDraft(thread, "saved-task"), { wrapper });
  act(() => result.current.changePrompt("A follow-up"));
  expect(readDraft("conversation.team", { text: "" }).text).toBe("A follow-up");
  await act(async () => vi.advanceTimersByTimeAsync(600));
  expect(rpc.call).toHaveBeenCalledWith("threads.update", { id: "team", taskId: "saved-task", patch: { draft: "A follow-up" } });
  await act(async () => vi.advanceTimersByTimeAsync(600));
  expect(rpc.call).toHaveBeenCalledTimes(1);
});
