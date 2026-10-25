// @vitest-environment jsdom
import type { Commit, Project, PushState, RpcMethod, RpcParams, ThreadSummary, WorkspaceChanges } from "@openorc/protocol";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { router } from "expo-router";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { FakeMac } from "../test-fixtures/fake-mac";
import { publishStore } from "./publishing";
import { PullRequestSheet } from "./PullRequestSheet";

const mac = vi.hoisted(() => ({ phone: null as FakeMac | null, reads: {} as Partial<Record<RpcMethod, (params: unknown) => Promise<unknown>>> }));

vi.mock("../client", async () => {
  const { fakeMac } = await import("../test-fixtures/fake-mac");
  mac.phone = fakeMac((method, params) => mac.reads[method]?.(params) ?? Promise.reject(new Error(`no ${method}`)));
  return { ...mac.phone.module, useLinkState: () => ({ kind: "connected", mac: { id: "mac-1", name: "Studio" }, route: { kind: "lan", host: "s", port: 1 }, serial: 1 }) };
});
vi.mock("react-native-keyboard-controller", () => ({ useKeyboardState: <T,>(select: (state: { isVisible: boolean }) => T) => select({ isVisible: false }) }));
vi.mock("expo-router", () => {
  const Stack = ({ children }: { children?: ReactNode }) => <>{children}</>;
  Stack.Screen = () => null;
  return { router: { push: vi.fn(), back: vi.fn() }, Stack, useLocalSearchParams: () => ({ threadId: "t1" }), useIsFocused: () => true, useFocusEffect: () => undefined };
});

const commit: Commit = { sha: "b2c3d4e", author: "QA", at: 1, subject: "Tighten the pairing copy" };
const push: PushState = { branch: "feat/x", blocked: null, published: true, unpushedCount: 0, unpushed: [], busy: false };
const clean: WorkspaceChanges = { comparison: "head", baseSha: null, totals: { files: 0, insertions: 0, deletions: 0 }, files: [], unlisted: 0 };
const branches = (count: number) => ["main", ...Array.from({ length: count - 1 }, (_, i) => `release/${i}`)];
let create: ReturnType<typeof vi.fn<(params: RpcParams<"review.createThreadPr">) => Promise<{ url: string }>>>;

function world(count: number) {
  create = vi.fn(async () => ({ url: "https://github.com/fake/site/pull/3" }));
  mac.reads = {
    "threads.get": async () =>
      ({
        id: "t1",
        projectId: "p1",
        title: "Pairing",
        agent: "codex",
        activity: "idle",
        branch: "feat/x",
        baseBranch: "main",
        workspaceMode: "worktree",
        worktreePath: "/w",
        prUrl: null,
      }) as ThreadSummary,
    "projects.get": async () => ({ id: "p1", name: "Site", gitRemote: "https://github.com/fake/site.git", defaultBranch: "main" }) as Project,
    "review.threadChanges": async () => clean,
    "git.threadLog": async () => [commit],
    "git.threadPushState": async () => push,
    "system.gh": async () => ({ installed: true }),
    "review.threadPrTemplate": async () => ({ body: "## What changed\n" }),
    "pulls.branches": async () => ({ defaultBranch: "main", branches: branches(count), truncated: false }),
    "review.createThreadPr": create as never,
  };
}

beforeEach(() => {
  mac.phone!.saved.clear();
  mac.phone!.module.queryClient.clear();
  vi.mocked(router.back).mockClear();
  vi.mocked(router.push).mockClear();
});
afterEach(cleanup);

it("opens the pull request with the newest commit's subject, the template and where the work started", async () => {
  world(3);
  render(<PullRequestSheet />, { wrapper: mac.phone!.wrapper });
  // The target is a native menu at this size: its button opens the items.
  await waitFor(() => expect(screen.getByRole("button", { name: "Target branch, main" }).getAttribute("aria-expanded")).toBe("false"));
  await waitFor(() => expect(mac.phone!.module.queryClient.getQueryData(["review.threadPrTemplate", { threadId: "t1" }])).toBeTruthy());
  fireEvent.click(screen.getByRole("button", { name: "Open PR" }));
  await waitFor(() => expect(router.back).toHaveBeenCalled());
  expect(create).toHaveBeenCalledWith({ threadId: "t1", title: "Tighten the pairing copy", body: "## What changed\n", base: "main" });
  expect(publishStore.get("t1")).toMatchObject({ kind: "notice", text: "Opened pull request #3" });
});

it("searches for the target in its own sheet past 20 branches", async () => {
  world(25);
  render(<PullRequestSheet />, { wrapper: mac.phone!.wrapper });
  // Once GitHub's 25 branches are known, the row leaves the menu for the search sheet.
  await waitFor(() => expect(screen.getByRole("button", { name: "Target branch, main" }).hasAttribute("aria-expanded")).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "Target branch, main" }));
  expect(router.push).toHaveBeenCalledWith({ pathname: "/branch", params: { threadId: "t1" } });
});
