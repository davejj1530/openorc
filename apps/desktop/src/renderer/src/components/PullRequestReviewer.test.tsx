import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { defaultOrclingLook, type ModelCatalog, type PullRequestDetail, type PullRequestReview, type RpcMethod, type RpcResults } from "@openorc/protocol";
import { core } from "../lib/rpc";
import { queryClient } from "../lib/client";
import { PullRequestReviewer } from "./PullRequestReviewer";

const pull = { number: 7, title: "Add retries", url: "https://github.com/acme/app/pull/7", headSha: "c".repeat(40), body: "" } as PullRequestDetail;
const mac: ModelCatalog = { models: [{ id: "claude-sonnet-5", label: "Sonnet 5", agent: "claude", isDefault: true, efforts: [], defaultEffort: null }], providers: [] };
const cloud: ModelCatalog = {
  models: [
    { id: "", label: "Claude Code default", agent: "claude", isDefault: true, efforts: [], defaultEffort: null },
    { id: "gpt-5.5", label: "GPT-5.5", agent: "codex", isDefault: true, efforts: [], defaultEffort: null },
  ],
  providers: [],
};
let rootPath: string;

beforeEach(() => {
  rootPath = "";
  queryClient.clear();
  queryClient.setDefaultOptions({ queries: { retry: false, staleTime: Infinity } });
  // The last reviewer chosen, on a Mac project: a Mac model, by way of an Orcling.
  localStorage.setItem("openorc.pull-reviewer", JSON.stringify({ kind: "model", choice: { agent: "claude", model: "claude-sonnet-5", effort: null }, orclingId: "rook" }));
  vi.spyOn(core, "call").mockImplementation(async <M extends RpcMethod>(method: M): Promise<RpcResults[M]> => {
    if (method === "projects.get") return { id: "project", name: "app", rootPath, gitRemote: "https://github.com/acme/app" } as RpcResults[M];
    if (method === "cloudModels.catalog") return cloud as RpcResults[M];
    if (method === "agents.modelCatalog") return mac as RpcResults[M];
    if (method === "orclings.list")
      return [{ id: "rook", name: "Rook", look: defaultOrclingLook, settings: { agent: "claude", model: "claude-sonnet-5", effort: null, fastMode: false } }] as RpcResults[M];
    if (method === "pulls.review.start") return { threadId: "review" } as RpcResults[M];
    if (method === "system.info" || method === "app.settings.get" || method === "threads.get") return null as RpcResults[M];
    return [] as unknown as RpcResults[M];
  });
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  localStorage.clear();
  vi.restoreAllMocks();
});

const DRAFT_ON_ANOTHER_ACCOUNT = "This review's draft was written on another Claude account, and accounts are kept separate, so post or discard it before reviewing on another account.";

const started = () =>
  vi
    .mocked(core.call)
    .mock.calls.filter(([method]) => method === "pulls.review.start")
    .map(([, params]) => params);

it("reviews a project only OpenOrc Cloud has with a model the cloud runs, and no Orcling", async () => {
  render(
    <QueryClientProvider client={queryClient}>
      <PullRequestReviewer projectId="project" pull={pull} review={null} />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(screen.getByRole("button", { name: "Reviewer" }).textContent).toContain("Claude Code default"));
  fireEvent.click(screen.getByRole("button", { name: /Start review/ }));
  await waitFor(() => expect(started()).toEqual([{ projectId: "project", number: 7, reviewer: { agent: "claude", model: "", effort: null, fastMode: false } }]));
});

it("keeps the reviewer last chosen for a project on this Mac", async () => {
  rootPath = "/work/app";
  render(
    <QueryClientProvider client={queryClient}>
      <PullRequestReviewer projectId="project" pull={pull} review={null} />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(screen.getByRole("button", { name: "Reviewer" }).textContent).toContain("Rook"));
  fireEvent.click(screen.getByRole("button", { name: /Start review/ }));
  await waitFor(() => expect(started()).toEqual([{ projectId: "project", number: 7, reviewer: { agent: "claude", model: "claude-sonnet-5", effort: null, fastMode: false }, orclingId: "rook" }]));
});

it("starts a fresh review for an Orcling on another Claude account while accounts are kept separate, and holds it while the draft was written there", async () => {
  rootPath = "/work/app";
  const conversation = { id: "review", title: "Review #7", agent: "claude", model: "claude-sonnet-5", claudeAccountId: "work", archivedAt: null, activity: "idle", orclingId: null };
  const orclings = [
    { id: "rook", name: "Rook", look: defaultOrclingLook, claudeAccountId: "client", settings: { agent: "claude", model: "claude-sonnet-5", effort: null, fastMode: false } },
    { id: "ivy", name: "Ivy", look: defaultOrclingLook, claudeAccountId: "work", settings: { agent: "claude", model: "claude-sonnet-5", effort: null, fastMode: false } },
  ];
  const call = vi.mocked(core.call).getMockImplementation()!;
  vi.mocked(core.call).mockImplementation(async (method, params) => {
    if (method === "app.settings.get") return { claudeAccountsSeparate: true } as never;
    if (method === "threads.get") return conversation as never;
    if (method === "orclings.list") return orclings as never;
    return call(method, params);
  });
  const review = (comments: number) =>
    ({
      projectId: "project",
      number: 7,
      commitId: "c".repeat(40),
      summary: "",
      modelSummary: null,
      threadId: "review",
      baseCommit: null,
      comments: Array.from({ length: comments }, () => ({})),
      updatedAt: 1,
    }) as never;
  const { rerender } = render(
    <QueryClientProvider client={queryClient}>
      <PullRequestReviewer projectId="project" pull={pull} review={review(0)} />
    </QueryClientProvider>,
  );
  // Rook is on Client and the conversation on Work: an empty draft starts a fresh review rather than another round.
  await waitFor(() => expect(screen.getByRole("button", { name: /Start review/ })).toBeTruthy());
  rerender(
    <QueryClientProvider client={queryClient}>
      <PullRequestReviewer projectId="project" pull={pull} review={review(1)} />
    </QueryClientProvider>,
  );
  const start = screen.getByRole<HTMLButtonElement>("button", { name: /Start review/ });
  expect(start.disabled).toBe(true);
  expect(start.getAttribute("data-tip")).toBe(DRAFT_ON_ANOTHER_ACCOUNT);
  // Ivy is on the conversation's account, so she goes on with it.
  fireEvent.click(screen.getByRole("button", { name: "Reviewer" }));
  fireEvent.click(await screen.findByRole("button", { name: /Ivy/ }));
  await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: /Review again/ }).disabled).toBe(false));
});

const account = (id: string, name: string) => ({ id, name, kind: "managed", enabled: true, createdAt: 1, status: "ready", email: null, organization: null, message: null });
const work = account("work", "Work");
const client = account("client", "Client");
const draft = (comments: number) =>
  ({
    projectId: "project",
    number: 7,
    commitId: "c".repeat(40),
    summary: "",
    modelSummary: null,
    threadId: "review",
    baseCommit: null,
    comments: Array.from({ length: comments }, () => ({})),
    updatedAt: 1,
  }) as never;
const calls = (wanted: RpcMethod) => vi.mocked(core.call).mock.calls.filter(([method]) => method === wanted);

/** A model reviews a project on this Mac with these Claude accounts, its last round in a conversation on Work. */
function modelReviews(accounts: ReturnType<typeof account>[], { agent = "claude", separate = false } = {}) {
  rootPath = "/work/app";
  localStorage.setItem("openorc.pull-reviewer", JSON.stringify({ kind: "model", choice: { agent, model: agent === "claude" ? "claude-sonnet-5" : "gpt-5.5", effort: null }, orclingId: null }));
  const conversation = { id: "review", title: "Review #7", agent: "claude", model: "claude-sonnet-5", claudeAccountId: "work", archivedAt: null, activity: "idle", orclingId: null };
  const call = vi.mocked(core.call).getMockImplementation()!;
  vi.mocked(core.call).mockImplementation(async (method, params) => {
    if (method === "claude.accounts.list") return { defaultId: "client", accounts } as never;
    if (method === "app.settings.get") return { claudeAccountsSeparate: separate } as never;
    if (method === "threads.get") return conversation as never;
    if (method === "providers.usage") return new Promise(() => {}) as never;
    return call(method, params);
  });
}

const showReviewer = (review: PullRequestReview | null) =>
  render(
    <QueryClientProvider client={queryClient}>
      <PullRequestReviewer projectId="project" pull={pull} review={review} />
    </QueryClientProvider>,
  );

async function accountRows() {
  fireEvent.click(screen.getByRole("button", { name: "Reviewer" }));
  return within(await screen.findByRole("group", { name: "Claude account" }));
}

it("offers a Claude model the project's accounts, checked on the review conversation's, and starts a fresh review on another", async () => {
  modelReviews([work, client]);
  showReviewer(draft(0));
  await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: /Review again/ }).disabled).toBe(false));
  const rows = await accountRows();
  expect(rows.getByRole("button", { name: /^Work/ }).getAttribute("aria-pressed")).toBe("true");
  expect(rows.getByRole("button", { name: /^Client/ }).getAttribute("aria-pressed")).toBe("false");

  fireEvent.click(rows.getByRole("button", { name: /^Client/ }));
  expect(rows.getByRole("button", { name: /^Client/ }).getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: /Start review/ }));
  await waitFor(() =>
    expect(started()).toEqual([{ projectId: "project", number: 7, reviewer: { agent: "claude", model: "claude-sonnet-5", effort: null, fastMode: false }, claudeAccountId: "client" }]),
  );
});

it("holds a review on another account while accounts are kept separate and the draft was written on the conversation's", async () => {
  modelReviews([work, client], { separate: true });
  showReviewer(draft(1));
  await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: /Review again/ }).disabled).toBe(false));
  const rows = await accountRows();

  fireEvent.click(rows.getByRole("button", { name: /^Client/ }));
  const start = screen.getByRole<HTMLButtonElement>("button", { name: /Start review/ });
  expect(start.disabled).toBe(true);
  expect(start.getAttribute("data-tip")).toBe(DRAFT_ON_ANOTHER_ACCOUNT);
  // Back on the conversation's account, the round goes on there, draft and all.
  fireEvent.click(rows.getByRole("button", { name: /^Work/ }));
  expect(screen.getByRole<HTMLButtonElement>("button", { name: /Review again/ }).disabled).toBe(false);
});

it("offers no accounts to another agent's model, and none where the project uses one", async () => {
  modelReviews([work, client], { agent: "codex" });
  const { unmount } = showReviewer(null);
  fireEvent.click(await screen.findByRole("button", { name: /Start review/ }));
  await waitFor(() => expect(started()).toEqual([{ projectId: "project", number: 7, reviewer: { agent: "codex", model: "gpt-5.5", effort: null, fastMode: false } }]));
  expect(calls("claude.accounts.list")).toEqual([]);
  unmount();

  modelReviews([work]);
  showReviewer(null);
  await waitFor(() => expect(calls("claude.accounts.list")).not.toEqual([]));
  fireEvent.click(screen.getByRole("button", { name: "Reviewer" }));
  await screen.findByRole("button", { name: /Sonnet 5/ });
  expect(screen.queryByRole("group", { name: "Claude account" })).toBeNull();
});
