import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PullRequestReview, PullRequestSummary, ThreadSummary } from "@openorc/protocol";
import { core } from "../lib/rpc";
import { useLayout } from "../lib/layout";
import { queryClient } from "../lib/client";
import { useRouter } from "../lib/router";
import { spaceNavigation } from "../lib/space-navigation";
import { PullRequestList } from "./PullRequestList";

vi.mock("../lib/rpc", () => ({ core: { call: vi.fn(), onReady: vi.fn(), onPush: () => () => {} } }));
vi.mock("../components/TopBar", () => ({ TopBar: () => null }));

const pull = (number: number, title: string, more: Partial<PullRequestSummary> = {}) =>
  ({
    number,
    title,
    url: `https://github.com/acme/studio/pull/${number}`,
    state: "open",
    isDraft: false,
    reviewDecision: null,
    author: "mara",
    headRefName: `branch-${number}`,
    baseRefName: "main",
    additions: 3,
    deletions: 1,
    updatedAt: 1,
    ...more,
  }) as unknown as PullRequestSummary;

let lists: Record<string, Record<string, PullRequestSummary[]>>;
let reviews: Record<number, Partial<PullRequestReview>>;
let threads: Partial<ThreadSummary>[];

beforeEach(() => {
  queryClient.setDefaultOptions({ queries: { retry: false } });
  useLayout.setState({ workspace: "all" });
  lists = {
    studio: { open: [pull(1, "Create the welcome flow"), pull(2, "Polish the picker")], review_requested: [], authored: [], closed: [] },
    atlas: { open: [pull(3, "Speed up search")], review_requested: [], authored: [], closed: [] },
  };
  reviews = {};
  threads = [];
  vi.mocked(core.call).mockImplementation(async (method, params) => {
    const p = params as { projectId: string; filter: string; number: number };
    if (method === "system.info") return { gh: { installed: true, loggedIn: true } } as never;
    if (method === "projects.list")
      return [
        { id: "studio", name: "studio", gitRemote: "git@github.com:acme/studio.git" },
        { id: "atlas", name: "atlas", gitRemote: "https://github.com/acme/atlas" },
      ] as never;
    if (method === "pulls.list") return lists[p.projectId]![p.filter] as never;
    if (method === "pulls.review.get") return (reviews[p.number] ? { comments: [], threadId: null, ...reviews[p.number] } : null) as never;
    if (method === "threads.list") return threads as never;
    if (method === "orclings.list") return [] as never;
    throw new Error(`Unexpected RPC: ${method}`);
  });
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.resetAllMocks();
});

const renderPage = () =>
  render(
    <QueryClientProvider client={queryClient}>
      <PullRequestList />
    </QueryClientProvider>,
  );

it("groups every project's pull requests and folds a group away like a task group", async () => {
  renderPage();
  const studio = await screen.findByRole("region", { name: "studio pull requests" });
  await within(studio).findByRole("button", { name: /Create the welcome flow/ });
  const heading = within(studio).getByRole("button", { name: /studio/ });
  fireEvent.click(heading);
  expect(heading.getAttribute("aria-expanded")).toBe("false");
  expect(within(studio).queryByRole("button", { name: /Create the welcome flow/ })).toBeNull();
  expect(screen.getByRole("button", { name: /Speed up search/ })).toBeTruthy();
});

it("ends a row in the person's move, leads the group with it, and counts it on the label and on To review", async () => {
  const asked = pull(2, "Polish the picker", { reviewDecision: "review_required" });
  lists.studio = {
    open: [pull(1, "Create the welcome flow"), asked, pull(4, "Fix the dark theme", { author: "you", reviewDecision: "changes_requested" })],
    review_requested: [asked],
    authored: [pull(4, "Fix the dark theme")],
    closed: [],
  };
  threads = [{ id: "t-4", prUrl: "https://github.com/acme/studio/pull/4", activity: "idle" }];
  renderPage();
  const studio = await screen.findByRole("region", { name: "studio pull requests" });
  await within(studio).findByRole("button", { name: "Review" });
  expect(within(studio).getByLabelText("2 waiting on you")).toBeTruthy();
  expect(within(studio).getByRole("button", { name: /Polish the picker, #2, Review required/ })).toBeTruthy();
  const titles = within(studio)
    .getAllByRole("button", { name: /, #\d+, / })
    .map((row) => row.getAttribute("aria-label")!.split(",")[0]);
  expect(titles).toEqual(["Polish the picker", "Fix the dark theme", "Create the welcome flow"]);
  expect(screen.getByRole("radio", { name: "To review 1" })).toBeTruthy();
  fireEvent.click(within(studio).getByRole("button", { name: "Open thread" }));
  expect(useRouter.getState().route).toMatchObject({ view: "thread", threadId: "t-4" });
});

it("offers Finish review on a draft waiting on this Mac and no move while a reviewer is still at work", async () => {
  lists.studio = { open: [pull(1, "Create the welcome flow"), pull(2, "Polish the picker")], review_requested: [pull(2, "Polish the picker")], authored: [], closed: [] };
  reviews = { 1: { comments: [{ id: "c" }, { id: "d" }] as never }, 2: { threadId: "review-2" } };
  threads = [{ id: "review-2", activity: "running", agent: "codex", model: "gpt" }];
  renderPage();
  const studio = await screen.findByRole("region", { name: "studio pull requests" });
  await within(studio).findByRole("button", { name: "Finish review" });
  expect(within(studio).getByRole("button", { name: /Create the welcome flow, #1, 2 draft comments/ })).toBeTruthy();
  expect(await within(studio).findByRole("button", { name: /Polish the picker, #2, gpt is reviewing/ })).toBeTruthy();
  expect(within(studio).queryByRole("button", { name: "Review" })).toBeNull();
});

it("offers no Open thread while the thread that opened the pull request still works", async () => {
  const mine = pull(4, "Fix the dark theme", { author: "you", reviewDecision: "changes_requested" });
  lists.studio = { open: [mine], review_requested: [], authored: [mine], closed: [] };
  threads = [{ id: "t-4", prUrl: mine.url, activity: "running" }];
  renderPage();
  const studio = await screen.findByRole("region", { name: "studio pull requests" });
  await within(studio).findByRole("button", { name: /Fix the dark theme, #4, Changes requested/ });
  expect(within(studio).queryByRole("button", { name: "Open thread" })).toBeNull();
});

it("lists the pull requests of an organization's project that lives only in the cloud, read on GitHub by its name", async () => {
  const before = spaceNavigation.getState();
  spaceNavigation.setState({ current: "org:altalogy", inventory: [{ id: "org:altalogy", accountId: "account-a", personal: false, projects: [], threads: [], taskIds: [] }] } as never);
  lists["cloud-project"] = { open: [pull(4, "Export the activity log")], review_requested: [], authored: [], closed: [] };
  const answered = vi.mocked(core.call).getMockImplementation()!;
  vi.mocked(core.call).mockImplementation(async (method, params) => {
    if (method === "spaces.projects")
      return [{ key: "cloud-project", localProjectId: null, hostedProjectId: "server-project", name: "openorc-cloud-test", repo: "acme/cloud", connected: true }] as never;
    if (method === "projects.get") return { id: "cloud-project", name: "openorc-cloud-test", rootPath: "", gitRemote: "https://github.com/acme/cloud" } as never;
    if (method === "projects.list") return [] as never;
    return answered(method, params);
  });
  try {
    renderPage();
    expect(await screen.findByRole("button", { name: /Export the activity log/ })).toBeTruthy();
    expect(screen.queryByText("No GitHub projects")).toBeNull();
  } finally {
    spaceNavigation.setState(before, true);
  }
});
