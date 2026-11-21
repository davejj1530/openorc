import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { queryClient } from "./client";
import { addToConversationDraft, useConversationDraft } from "./conversation-draft";
import { conversationDraftKey, readDraft } from "./drafts";

const mutation = vi.hoisted(() => ({ mutate: vi.fn(), error: null }));
vi.mock("./client", async (original) => ({ ...(await original<object>()), useRpcMutation: () => mutation }));
afterEach(() => {
  cleanup();
  localStorage.clear();
  queryClient.clear();
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

const key = conversationDraftKey("thread");

it("opens a box with nothing typed here on the thread's saved draft, which ends with the added message, keeping no copy here", () => {
  queryClient.setQueryData(["threads.get", { id: "thread" }], { id: "thread", draft: "Earlier note" });
  addToConversationDraft("thread", "Review this.", "Earlier note\n\nReview this.");
  expect(readDraft(key, null)).toBeNull();
  const thread = queryClient.getQueryData<{ draft: string }>(["threads.get", { id: "thread" }]);
  const { result } = renderHook(() => useConversationDraft({ draftKey: key, threadId: "thread", initialText: thread?.draft ?? "" }));
  expect(result.current.prompt).toBe("Earlier note\n\nReview this.");
});

it("adds the message after what this window typed in the box", () => {
  const { result } = renderHook(() => useConversationDraft({ draftKey: key, threadId: "thread", initialText: "" }));
  act(() => result.current.setPrompt("Look at the tests too."));
  act(() => addToConversationDraft("thread", "Review this.", "Review this."));
  expect(result.current.prompt).toBe("Look at the tests too.\n\nReview this.");
  expect(readDraft(key, { text: "" }).text).toBe("Look at the tests too.\n\nReview this.");
});

it("puts the message in a box already showing the thread, and in no other thread's", () => {
  const shown = renderHook(() => useConversationDraft({ draftKey: key, threadId: "thread", initialText: "Earlier note" }));
  const other = renderHook(() => useConversationDraft({ draftKey: conversationDraftKey("other"), threadId: "other", initialText: "" }));
  act(() => addToConversationDraft("thread", "Review this.", "Earlier note\n\nReview this."));
  expect(shown.result.current.prompt).toBe("Earlier note\n\nReview this.");
  expect(other.result.current.prompt).toBe("");
  expect(readDraft(key, null)).toBeNull();
});
