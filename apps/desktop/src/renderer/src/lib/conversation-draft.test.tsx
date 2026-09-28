import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useConversationDraft } from "./conversation-draft";
import { readDraft } from "./drafts";

const mutation = vi.hoisted(() => ({ mutate: vi.fn(), error: null }));
vi.mock("./query", () => ({ useRpcMutation: () => mutation }));
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.useRealTimers();
  vi.clearAllMocks();
});

it("keeps the local draft across navigation before its delayed server save", () => {
  vi.useFakeTimers();
  const input = { draftKey: "conversation", threadId: "thread", initialText: "saved" };
  const first = renderHook(() => useConversationDraft(input));
  act(() => first.result.current.setPrompt("unsaved changes"));
  first.unmount();
  act(() => {
    vi.advanceTimersByTime(600);
  });
  expect(mutation.mutate).not.toHaveBeenCalled();
  const reopened = renderHook(() => useConversationDraft(input));
  expect(reopened.result.current.prompt).toBe("unsaved changes");
  act(() => {
    vi.advanceTimersByTime(600);
  });
  expect(mutation.mutate).toHaveBeenCalledExactlyOnceWith({ id: "thread", patch: { draft: "unsaved changes" } });
});

it("cancels the delayed draft when an accepted message clears it", () => {
  vi.useFakeTimers();
  const { result } = renderHook(() => useConversationDraft({ draftKey: "accepted", threadId: "thread", initialText: "" }));
  act(() => result.current.setPrompt("send this"));
  act(() => {
    vi.advanceTimersByTime(500);
  });
  act(() => result.current.clearDraft());
  act(() => {
    vi.advanceTimersByTime(1000);
  });
  expect(mutation.mutate).toHaveBeenCalledExactlyOnceWith({ id: "thread", patch: { draft: null } });
  expect(readDraft("accepted", { text: "absent" }).text).toBe("absent");
});
