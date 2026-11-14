import type { ThreadSummary } from "@openorc/protocol";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("../lib/client", async (original) => ({
  ...(await original<object>()),
  useRpc: (method: string) => (method === "projects.checkoutBranch" ? { isSuccess: true, data: "main" } : { isSuccess: false, data: undefined }),
  useRpcMutation: () => ({ mutate: vi.fn(), isPending: false, error: null }),
}));

import { ThreadPlaceLine } from "./ThreadPlaceLine";

afterEach(cleanup);

const base = { id: "t", projectId: "p", workspaceMode: "current", branch: "fix/menu", hasStarted: true, queued: [] } as unknown as ThreadSummary;
const said = (thread: Partial<ThreadSummary>) => {
  render(<ThreadPlaceLine thread={{ ...base, ...thread }} accounts={{ accounts: [{ id: "a", name: "David's Claude Max", status: "ready" }], current: "a", choose: () => {} } as never} />);
  return document.querySelector(".new-thread-sentence")?.textContent;
};

it.each([
  { place: "the checkout, by the branch it is on now", thread: {}, words: "Works in the local checkout on main" },
  { place: "a worktree", thread: { workspaceMode: "worktree" }, words: "Works in a worktree on fix/menu" },
  { place: "the person's own cloud", thread: { owner: { brain: "cloud", reach: "live" } }, words: "Works in your own cloud, on fix/menu" },
  { place: "OpenOrc Cloud", thread: { owner: { brain: "hosted", reach: "live" } }, words: "Works on OpenOrc Cloud, on fix/menu", account: undefined },
] as { place: string; thread: Partial<ThreadSummary>; words: string; account?: string }[])("says a started thread works in $place, with this Mac's account at the end", (each) => {
  expect(said(each.thread)).toBe(each.words);
  expect(screen.getByRole("button", { name: "Where the thread works" })).toBeTruthy();
  expect(document.querySelector(".thread-place-account")?.textContent).toBe("account" in each ? each.account : "David's Claude Max");
});

it("only says a folder outside any project, which has no place actions", () => {
  expect(said({ projectId: "openorc-workspace", workingDirectory: "/Users/me/notes" } as Partial<ThreadSummary>)).toBe("Works in notes");
  expect(screen.queryByRole("button", { name: "Where the thread works" })).toBeNull();
});

it("dims the place of a thread that cannot be reached", () => {
  said({ owner: { brain: "cloud", reach: "offline" } } as Partial<ThreadSummary>);
  expect(document.querySelector(".thread-place-line")?.hasAttribute("data-dim")).toBe(true);
});
