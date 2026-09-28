import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Commit, PushState, RpcMethod, RpcParams, RpcResults, ThreadSummary } from "@openorc/protocol";
import { CommitsPanel } from "./CommitsPanel";
import { core } from "../lib/rpc";
import { invalidateTags, queryClient } from "../lib/query";

const thread: ThreadSummary = {
  id: "thread",
  projectId: "project",
  title: "Site",
  agent: "codex",
  model: null,
  effort: null,
  fastMode: false,
  mode: "act",
  permissionMode: "review",
  workspaceMode: "current",
  branch: null,
  worktreePath: null,
  baseSha: null,
  pinnedAt: null,
  seenAt: null,
  doneAt: null,
  snoozedUntil: null,
  prUrl: null,
  prState: null,
  forkedFromId: null,
  forkedAtRunId: null,
  draft: "",
  importedFrom: null,
  createdAt: 0,
  updatedAt: 0,
  lastActivityAt: 0,
  archivedAt: null,
  activity: "idle",
  unread: false,
  session: { status: "idle", message: null },
  context: null,
  queued: [],
  lastAgentEventAt: null,
  taskCount: 0,
  openTaskCount: 0,
};
const commits: Commit[] = [
  { sha: "b".repeat(40), author: "David C", at: 2, subject: "perf: site overall improvements" },
  { sha: "a".repeat(40), author: "David C", at: 1, subject: "fix: site ui bugs" },
];
let state: PushState;
let pushError: Error | null;
let teamReason: string | null;

beforeEach(() => {
  state = { branch: "site-refresh", blocked: null, published: true, unpushedCount: 1, unpushed: [commits[0]!.sha] };
  pushError = null;
  teamReason = null;
  queryClient.clear();
  queryClient.setDefaultOptions({ queries: { retry: false, staleTime: Infinity } });
  vi.spyOn(core, "call").mockImplementation(async <M extends RpcMethod>(method: M, _params: RpcParams<M>): Promise<RpcResults[M]> => {
    if (method === "git.threadLog") return commits as RpcResults[M];
    if (method === "git.threadPushState") return state as RpcResults[M];
    if (method === "review.pushThread") {
      if (pushError) throw pushError;
      state = { ...state, published: true, unpushedCount: 0, unpushed: [] };
      return { remote: "origin", branch: "site-refresh" } as RpcResults[M];
    }
    if (method === "orchestration.runtime") {
      const action = { allowed: !teamReason, reason: teamReason };
      return { actions: { commit: action, push: action, createPr: action } } as RpcResults[M];
    }
    return [] as unknown as RpcResults[M];
  });
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.restoreAllMocks();
});

const mount = (source: ThreadSummary = thread) =>
  render(
    <QueryClientProvider client={queryClient}>
      <CommitsPanel source={{ kind: "thread", thread: source }} />
    </QueryClientProvider>,
  );
const row = (subject: string) => screen.getByText(subject).closest(".grid") as HTMLElement;

it("marks the commits origin lacks and pushes them once everything is committed", async () => {
  mount();
  const button = await screen.findByRole("button", { name: "Push 1 commit" });
  expect(within(row("perf: site overall improvements")).getByText("Not pushed")).toBeTruthy();
  expect(within(row("fix: site ui bugs")).queryByText("Not pushed")).toBeNull();

  fireEvent.click(button);
  expect(await screen.findByRole("status")).toHaveProperty("textContent", "Pushed site-refresh to origin");
  expect(vi.mocked(core.call)).toHaveBeenCalledWith("review.pushThread", { threadId: thread.id });
  expect(((await screen.findByRole("button", { name: "Push" })) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByText("Not pushed")).toBeNull();

  // The next commit makes the success stale.
  state = { ...state, unpushedCount: 1, unpushed: [commits[0]!.sha] };
  invalidateTags([`threadlog:${thread.id}`], { immediate: true });
  expect(await screen.findByRole("button", { name: "Push 1 commit" })).toBeTruthy();
  expect(screen.queryByText("Pushed site-refresh to origin")).toBeNull();
});

it("publishes a branch origin doesn't have yet", async () => {
  state = { ...state, published: false, unpushedCount: 2, unpushed: commits.map((commit) => commit.sha) };
  mount();
  expect(((await screen.findByRole("button", { name: "Publish branch" })) as HTMLButtonElement).disabled).toBe(false);
  expect(screen.getAllByText("Not pushed")).toHaveLength(2);
});

it("says why it can't push", async () => {
  state = { branch: "site-refresh", blocked: "This repository has no origin remote to push to.", published: false, unpushedCount: 0, unpushed: [] };
  mount();
  expect(await screen.findByText("This repository has no origin remote to push to.")).toBeTruthy();
  expect((screen.getByRole("button", { name: "Push" }) as HTMLButtonElement).disabled).toBe(true);
});

it("waits for the team's go-ahead before pushing its workspace", async () => {
  teamReason = "Team is working";
  mount({ ...thread, teamInstanceId: "team" });
  expect(((await screen.findByRole("button", { name: "Push 1 commit" })) as HTMLButtonElement).disabled).toBe(true);
  expect(await screen.findByText("Team is working")).toBeTruthy();
});

it("shows a rejected push and keeps the commits marked", async () => {
  pushError = new Error("origin has newer commits on site-refresh. Pull them in first, then push again.");
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Push 1 commit" }));
  expect((await screen.findByRole("alert")).textContent).toBe("origin has newer commits on site-refresh. Pull them in first, then push again.");
  expect(screen.getByText("Not pushed")).toBeTruthy();
});
