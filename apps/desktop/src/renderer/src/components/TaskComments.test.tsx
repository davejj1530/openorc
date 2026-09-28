import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TaskDiscussion } from "@openorc/protocol";
import { core } from "../lib/rpc";
import { TaskComments } from "./TaskComments";
vi.mock("./ThreadImages", () => ({ ThreadRichText: ({ children }: { children: string }) => <div>{children}</div> }));
let discussion: TaskDiscussion;
let failSend = false;
const beforeSend = vi.fn(async () => true);
const api = vi.spyOn(core, "call");
beforeEach(() => {
  localStorage.clear();
  discussion = { comments: [], attempts: [] };
  failSend = false;
  beforeSend.mockReset().mockResolvedValue(true);
  api.mockImplementation(async (method, params) => {
    if (method === "agents.models") return [{ id: "test-model", label: "Test", agent: "codex", efforts: ["high", "low"], defaultEffort: "high", isDefault: true }] as never;
    if (method === "tasks.comments.list") return discussion as never;
    if (method === "tasks.comments.post") {
      if (failSend) throw new Error("Disconnected. Retry your comment.");
      return { id: "new", ...params } as never;
    }
    return null as never;
  });
  api.mockClear();
});
afterEach(cleanup);
function mount(description = "Saved task") {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>
      <TaskComments taskId="task" description={description} beforeSend={beforeSend} />
    </QueryClientProvider>,
  );
}
const input = () => screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Task comment" });
const posted = () => api.mock.calls.filter(([method]) => method === "tasks.comments.post");
it("inserts the model's display name and effort with the keyboard without submitting", async () => {
  mount();
  fireEvent.change(input(), { target: { value: "@test", selectionStart: 5 } });
  await screen.findByRole("option", { name: "@Test - High Codex" });
  fireEvent.keyDown(input(), { key: "Enter" });
  expect(input().value).toBe("@Test - High ");
  expect(posted()).toHaveLength(0);
});
it("flushes the task before posting a plain note with no recipients", async () => {
  mount();
  fireEvent.change(input(), { target: { value: "A note" } });
  fireEvent.click(screen.getByRole("button", { name: "Comment" }));
  await waitFor(() => expect(posted()).toHaveLength(1));
  expect(beforeSend).toHaveBeenCalledOnce();
  expect(posted()[0]![1]).toMatchObject({ body: "A note", recipients: [], source: "comment" });
  await waitFor(() => expect(input().value).toBe(""));
});
it("retains draft and request identity after a failed send and navigation", async () => {
  failSend = true;
  const mounted = mount();
  fireEvent.change(input(), { target: { value: "Important question" } });
  fireEvent.click(screen.getByRole("button", { name: "Comment" }));
  await screen.findByRole("alert");
  const first = posted()[0]![1];
  expect(input().value).toBe("Important question");
  mounted.unmount();
  failSend = false;
  mount();
  expect(input().value).toBe("Important question");
  fireEvent.click(screen.getByRole("button", { name: "Comment" }));
  await waitFor(() => expect(posted()).toHaveLength(2));
  expect(posted()[1]![1]).toEqual(first);
});
it("never dispatches description mentions on mount and requires a successful save", async () => {
  beforeSend.mockResolvedValue(false);
  mount("@codex:test-model-high Plan this");
  await screen.findByText("No comments yet. Leave a note or ask an agent.");
  expect(posted()).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Ask tagged agents" }));
  await screen.findByRole("alert");
  expect(posted()).toHaveLength(0);
  beforeSend.mockResolvedValue(true);
  fireEvent.click(screen.getByRole("button", { name: "Ask tagged agents" }));
  await waitFor(() => expect(posted()).toHaveLength(1));
  expect(posted()[0]![1]).toMatchObject({ source: "description" });
});
it("Reply selects the agent and preserves its response while composing", async () => {
  discussion = {
    comments: [{ id: "c", taskId: "task", requestKey: "c", body: "Question", recipients: [], replyTo: null, source: "comment", context: "", createdAt: 1 }],
    attempts: [
      {
        id: "a",
        taskId: "task",
        commentId: "c",
        recipient: { agent: "codex", model: "test-model", effort: "high" },
        state: "success",
        body: "The answer",
        error: null,
        runId: "r",
        threadId: null,
        executionRunId: null,
        intent: null,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
  };
  mount();
  await screen.findByText("The answer");
  await screen.findByRole("article", { name: "Test - High response" });
  fireEvent.click(screen.getAllByRole("button", { name: "Reply" })[1]!);
  expect(screen.getByText("Replying to Test - High")).toBeTruthy();
  fireEvent.change(input(), { target: { value: "Explain further" } });
  fireEvent.click(screen.getByRole("button", { name: "Comment" }));
  await waitFor(() => expect(posted()).toHaveLength(1));
  expect(posted()[0]![1]).toMatchObject({ replyTo: "a", recipients: [{ agent: "codex", model: "test-model", effort: "high" }] });
});

it("retains reply recipient intent and request identity through a failed post and retry", async () => {
  discussion = {
    comments: [{ id: "c", taskId: "task", requestKey: "c", body: "Question", recipients: [], replyTo: null, source: "comment", context: "", createdAt: 1 }],
    attempts: [
      {
        id: "a",
        taskId: "task",
        commentId: "c",
        recipient: { agent: "codex", model: "test-model", effort: "high" },
        state: "success",
        body: "Answer",
        error: null,
        runId: "r",
        threadId: null,
        executionRunId: null,
        intent: null,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
  };
  failSend = true;
  const mounted = mount();
  await screen.findByText("Answer");
  fireEvent.click(screen.getAllByRole("button", { name: "Reply" })[1]!);
  fireEvent.change(input(), { target: { value: "Explain further" } });
  fireEvent.click(screen.getByRole("button", { name: "Comment" }));
  await screen.findByRole("alert");
  const first = posted()[0]![1];
  expect(first).toMatchObject({ replyTo: "a", recipients: [{ agent: "codex", model: "test-model", effort: "high" }] });
  mounted.unmount();
  failSend = false;
  mount();
  expect(await screen.findByText("Replying to Test - High")).toBeTruthy();
  expect(input().value).toBe("Explain further");
  fireEvent.click(screen.getByRole("button", { name: "Comment" }));
  await waitFor(() => expect(posted()).toHaveLength(2));
  expect(posted()[1]![1]).toEqual(first);
});

it("keeps server comment and response order in the discussion feed", async () => {
  discussion = {
    comments: [
      { id: "second", taskId: "task", requestKey: "2", body: "Second", recipients: [], replyTo: null, source: "comment", context: "", createdAt: 2 },
      { id: "first", taskId: "task", requestKey: "1", body: "First", recipients: [], replyTo: null, source: "comment", context: "", createdAt: 1 },
    ],
    attempts: [],
  };
  mount();
  await screen.findByText("First");
  expect([...document.querySelectorAll(".task-comment")].map((item) => item.id)).toEqual(["comment-second", "comment-first"]);
});

it("hides executor choices once a follow-up was accepted, even with an old sibling choice", async () => {
  discussion = {
    comments: [{ id: "c", taskId: "task", requestKey: "c", body: "Implement this too", recipients: [], replyTo: null, source: "comment", context: "", createdAt: 1 }],
    attempts: [
      {
        id: "a",
        taskId: "task",
        commentId: "c",
        recipient: { agent: "codex", model: "test-model", effort: "high" },
        state: "success",
        body: "Follow-up queued",
        error: null,
        runId: "r",
        threadId: "owner",
        executionRunId: null,
        intent: { intent: "execution", quote: "Implement this too" },
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: "b",
        taskId: "task",
        commentId: "c",
        recipient: { agent: "codex", model: "test-model", effort: "low" },
        state: "choose_executor",
        body: "Ready",
        error: null,
        runId: "s",
        threadId: null,
        executionRunId: null,
        intent: { intent: "execution", quote: "Implement this too" },
        createdAt: 1,
        updatedAt: 1,
      },
    ],
  };
  mount();
  await screen.findByText("Follow-up queued");
  expect(screen.queryByText("Who should implement?")).toBeNull();
  expect(screen.getByRole("button", { name: "Open thread" })).toBeTruthy();
});
