import type { BringState, HostedThreadCommits, ThreadSummary } from "@openorc/protocol";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { queryClient } from "../lib/client";
import { core } from "../lib/rpc";
import { HostedCommitsPanel } from "./HostedCommitsPanel";

vi.mock("../lib/rpc", () => ({ core: { call: vi.fn(), onReady: vi.fn(), onPush: () => () => {} } }));
vi.mock("./HostedPublish", () => ({ HostedPublish: () => null }));
vi.mock("../components/DiffView", () => ({ DiffView: ({ patch }: { patch: string }) => <pre data-testid="commit-diff">{patch}</pre> }));

const at = Date.parse("2026-11-17T09:00:00Z");
const commit = (n: number) => ({ sha: `${n}`.padStart(40, "a"), subject: `Commit ${n}`, author: "Ana Rivera", at: at - n * 60_000 });
let listed: HostedThreadCommits;
let bring: BringState;
const file = { path: "hero.md", oldPath: null, status: "modified" as const, body: { kind: "text" as const, insertions: 1, deletions: 1 }, withheld: false };
const opened = { sha: commit(2).sha, parent: commit(3).sha, totals: { files: 1, insertions: 1, deletions: 1 }, files: [file], unlisted: 0 };

beforeEach(() => {
  queryClient.setDefaultOptions({ queries: { retry: false } });
  listed = { commits: [commit(1), commit(2), commit(3)], total: 3, pushed: commit(2).sha };
  bring = { mac: false };
  vi.mocked(core.call).mockImplementation((async (method: string) => {
    if (method === "hosted.review.commits") return listed;
    if (method === "macProjects.bringState") return bring;
    if (method === "hosted.review.commit") return opened;
    if (method === "hosted.review.file")
      return {
        path: "hero.md",
        oldPath: null,
        status: "modified",
        body: { kind: "text", insertions: 1, deletions: 1 },
        patch: "@@ -1 +1 @@\n-Spring is here.\n+Spring is here. Step outside.",
        cut: null,
        note: null,
      };
    return null;
  }) as never);
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.resetAllMocks();
});

const thread = { id: "thread-1", owner: { reach: "live" } } as unknown as ThreadSummary;
const show = () => render(<QueryClientProvider client={queryClient}>{<HostedCommitsPanel thread={thread} />}</QueryClientProvider>);

it("lists the thread's commits as this Mac's rows, newest first, the ones after its last push not pushed", async () => {
  show();
  expect(await screen.findByText("Commit 1")).toBeTruthy();
  const rows = screen.getAllByRole("listitem");
  expect(rows.map((row) => row.querySelector(".commit-subject")?.textContent)).toEqual(["Commit 1", "Commit 2", "Commit 3"]);
  expect(screen.getAllByRole("img").map((dot) => dot.getAttribute("aria-label"))).toEqual(["Not pushed", "On origin", "On origin"]);
  expect(screen.queryByText("Commit history unavailable")).toBeNull();
});

it("counts the older commits it leaves out", async () => {
  listed = { commits: Array.from({ length: 100 }, (_, i) => commit(i + 1)), total: 140, pushed: null };
  show();
  expect(await screen.findByText("40 more")).toBeTruthy();
  expect(screen.getAllByRole("img")).toHaveLength(100);
});

it("says nothing for a thread with no commits", async () => {
  listed = { commits: [], total: 0, pushed: null };
  show();
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("hosted.review.commits", { threadId: "thread-1" }));
  expect(screen.queryByRole("list")).toBeNull();
  expect(screen.queryByText(/commit/i)).toBeNull();
});

it("marks a project from a folder of a Mac's commits as in the cloud, not unpushed", async () => {
  bring = { mac: true, can: true, ends: [] };
  listed = { commits: [commit(1)], total: 1, pushed: null };
  show();
  await waitFor(() => expect(screen.getByRole("img").getAttribute("aria-label")).toBe("In the cloud"));
});

it("opens a commit as its changes, its file's patch read by the commit, and goes back to the list", async () => {
  show();
  fireEvent.click(await screen.findByRole("button", { name: /Commit 2/ }));
  expect((await screen.findByTestId("commit-diff")).textContent).toContain("+Spring is here. Step outside.");
  expect(screen.getByRole("region", { name: `Commit ${commit(2).sha.slice(0, 7)}` })).toBeTruthy();
  expect(screen.getByText("1 file")).toBeTruthy();
  expect(core.call).toHaveBeenCalledWith("hosted.review.commit", { threadId: "thread-1", sha: commit(2).sha });
  expect(core.call).toHaveBeenCalledWith("hosted.review.file", { threadId: "thread-1", path: "hero.md", commit: commit(2).sha });
  fireEvent.click(screen.getByRole("button", { name: "All commits" }));
  expect(await screen.findByRole("list", { name: "Commits" })).toBeTruthy();
});

it("says in words when a commit's changes can't be read", async () => {
  vi.mocked(core.call).mockImplementation((async (method: string) => {
    if (method === "hosted.review.commits") return listed;
    if (method === "macProjects.bringState") return bring;
    if (method === "hosted.review.commit") throw new Error("This commit's changes can't be read from here.");
    return null;
  }) as never);
  show();
  fireEvent.click(await screen.findByRole("button", { name: /Commit 1/ }));
  expect(await screen.findByText("This commit's changes can't be read from here.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
});
