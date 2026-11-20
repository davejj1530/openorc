import type { NamedCommit } from "@openorc/protocol";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { queryClient } from "../lib/client";
import { useLayout } from "../lib/layout";
import { core } from "../lib/rpc";
import { ThreadMedia, ThreadRichText, type CommitScope } from "./ThreadImages";

vi.mock("../lib/rpc", () => ({ core: { call: vi.fn(), onReady: vi.fn(), onPush: () => () => {} } }));

const local = "1c4d12fa0000000000000000000000000000aaaa";
const pushed = "6fd405ae0000000000000000000000000000bbbb";
const named: Record<string, NamedCommit> = {
  "1c4d12fa": { commit: { sha: local, subject: "Show the running step", author: "Ada", at: 0 }, url: null },
  "6fd405ae": { commit: { sha: pushed, subject: "Keep the folder in Personal", author: "Ada", at: 0 }, url: `https://github.com/acme/app/commit/${pushed}` },
};

beforeEach(() => {
  vi.mocked(core.call).mockReset();
  vi.mocked(core.call).mockImplementation(async (method, params) => {
    if (method === "git.threadCommit") return named[(params as { sha: string }).sha] ?? null;
    if (method === "hosted.review.commits") return { commits: [{ sha: local, subject: "Show the running step", author: "Ada", at: 0 }], total: 1, pushed: null };
    throw new Error(`unexpected ${method}`);
  });
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.restoreAllMocks();
});

const show = (reply: string, commits: CommitScope | undefined) =>
  render(
    <QueryClientProvider client={queryClient}>
      <ThreadMedia scopeKey="thread" commits={commits}>
        <ThreadRichText>{reply}</ThreadRichText>
      </ThreadMedia>
    </QueryClientProvider>,
  );

it("opens a commit only this Mac has in the thread's Commits, links one origin has to GitHub, and leaves other code alone", async () => {
  const openCommit = vi.spyOn(useLayout.getState(), "openCommit").mockImplementation(() => undefined);
  show("Fixed in `1c4d12fa`, after `6fd405ae`. Not `deadbeef`, `1c4d12f` in a `git log 1c4d12fa`.", { threadId: "t1", hosted: false });

  await waitFor(() => expect(screen.getByText("6fd405ae").closest("a")?.getAttribute("href")).toBe(`https://github.com/acme/app/commit/${pushed}`));
  fireEvent.click(screen.getByText("6fd405ae"));
  expect(openCommit).not.toHaveBeenCalled();

  const link = screen.getByText("1c4d12fa").closest("a");
  expect(link?.getAttribute("data-tip")).toBe("View commit: Show the running step");
  fireEvent.click(screen.getByText("1c4d12fa"));
  expect(openCommit).toHaveBeenCalledWith("t1", local);

  // An id no commit has, and code that only holds an id, stay code.
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("git.threadCommit", { threadId: "t1", sha: "deadbeef" }));
  expect(screen.getByText("deadbeef").closest("a")).toBeNull();
  expect(screen.getByText("git log 1c4d12fa").closest("a")).toBeNull();
});

it("opens a cloud thread's own commit in its Commits, by the commit's whole id", async () => {
  const openCommit = vi.spyOn(useLayout.getState(), "openCommit").mockImplementation(() => undefined);
  show("Fixed in `1c4d12fa`, not `6fd405ae`.", { threadId: "cloud-1", hosted: true });
  await waitFor(() => expect(screen.getByText("1c4d12fa").closest("a")).toBeTruthy());
  fireEvent.click(screen.getByText("1c4d12fa"));
  expect(openCommit).toHaveBeenCalledWith("cloud-1", local);
  expect(screen.getByText("6fd405ae").closest("a")).toBeNull();
  expect(core.call).not.toHaveBeenCalledWith("git.threadCommit", expect.anything());
});

it("asks nothing where the conversation has no commits to open", async () => {
  show("See `1c4d12fa`.", undefined);
  expect((await screen.findByText("1c4d12fa")).closest("a")).toBeNull();
  expect(core.call).not.toHaveBeenCalled();
});
