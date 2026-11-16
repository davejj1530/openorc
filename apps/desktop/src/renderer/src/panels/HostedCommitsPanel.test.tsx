import type { BringState, HostedThreadCommits, ThreadSummary } from "@openorc/protocol";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { queryClient } from "../lib/client";
import { core } from "../lib/rpc";
import { HostedCommitsPanel } from "./HostedCommitsPanel";

vi.mock("../lib/rpc", () => ({ core: { call: vi.fn(), onReady: vi.fn(), onPush: () => () => {} } }));
vi.mock("./HostedPublish", () => ({ HostedPublish: () => null }));

const at = Date.parse("2026-11-17T09:00:00Z");
const commit = (n: number) => ({ sha: `${n}`.padStart(40, "a"), subject: `Commit ${n}`, author: "Ana Rivera", at: at - n * 60_000 });
let listed: HostedThreadCommits;
let bring: BringState;

beforeEach(() => {
  listed = { commits: [commit(1), commit(2), commit(3)], total: 3, pushed: commit(2).sha };
  bring = { mac: false };
  vi.mocked(core.call).mockImplementation((async (method: string) => {
    if (method === "hosted.review.commits") return listed;
    if (method === "macProjects.bringState") return bring;
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
