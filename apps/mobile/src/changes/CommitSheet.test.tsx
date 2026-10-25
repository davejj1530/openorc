// @vitest-environment jsdom
import type { Commit, Project, PushState, RpcMethod, ThreadSummary, WorkspaceChanges } from "@openorc/protocol";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { router } from "expo-router";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DROPPED } from "../connection/link-connection";
import type { LinkState } from "../connection/manager";
import type { FakeMac } from "../test-fixtures/fake-mac";
import { flatStyle, nativeProps } from "../test-fixtures/react-native";
import { CommitSheet } from "./CommitSheet";

const studio = { id: "mac-1", name: "Studio" };

const mac = vi.hoisted(() => ({
  phone: null as FakeMac | null,
  state: null as unknown as LinkState,
  reads: {} as Partial<Record<RpcMethod, (params: unknown) => Promise<unknown>>>,
}));

vi.mock("../client", async () => {
  const { fakeMac } = await import("../test-fixtures/fake-mac");
  mac.phone = fakeMac((method, params) => mac.reads[method]?.(params) ?? Promise.reject(new Error(`no ${method}`)));
  return { ...mac.phone.module, useLinkState: () => mac.state, link: { ...mac.phone.module.link, retry: async () => undefined } };
});
const keyboard = vi.hoisted(() => ({ up: false }));
vi.mock("react-native-keyboard-controller", () => ({ useKeyboardState: <T,>(select: (state: { isVisible: boolean }) => T) => select({ isVisible: keyboard.up }) }));
// A phone with a home indicator.
vi.mock("react-native-safe-area-context", async (original) => ({ ...(await original<object>()), useSafeAreaInsets: () => ({ top: 59, right: 0, bottom: 34, left: 0 }) }));
vi.mock("expo-router", () => {
  const Stack = ({ children }: { children?: ReactNode }) => <>{children}</>;
  Stack.Screen = () => null;
  return { router: { push: vi.fn(), back: vi.fn() }, Stack, useLocalSearchParams: () => ({ threadId: "t1" }), useIsFocused: () => true };
});

const head: Commit = { sha: "a1a1a1a1a1", author: "QA", at: 1, subject: "Start" };
const uncommitted: WorkspaceChanges = { comparison: "head", baseSha: null, totals: { files: 3, insertions: 42, deletions: 7 }, files: [], unlisted: 0 };
const push: PushState = { branch: "feat/x", blocked: null, published: false, unpushedCount: 0, unpushed: [], busy: false };
let log: Commit[];
let busy: boolean;

beforeEach(() => {
  mac.state = { kind: "connected", mac: studio, route: { kind: "lan", host: "studio.local", port: 1 }, serial: 1 };
  mac.phone!.saved.clear();
  mac.phone!.module.queryClient.clear();
  vi.mocked(router.back).mockClear();
  log = [head];
  busy = false;
  keyboard.up = false;
  mac.reads = {
    "threads.get": async () =>
      ({ id: "t1", projectId: "p1", title: "Pairing", agent: "codex", activity: "idle", branch: "feat/x", workspaceMode: "worktree", worktreePath: "/w/t1", prUrl: null }) as ThreadSummary,
    "projects.get": async () => ({ id: "p1", name: "Site", gitRemote: null, defaultBranch: "main" }) as Project,
    "review.threadChanges": async () => uncommitted,
    "git.threadLog": async () => log,
    "git.threadPushState": async () => ({ ...push, busy }),
    "system.gh": async () => ({ installed: true }),
  };
});
afterEach(cleanup);

const open = () => render(<CommitSheet />, { wrapper: mac.phone!.wrapper });
const write = (text: string) => act(() => (nativeProps.get(screen.getByLabelText("Commit message"))!.onChangeText as (text: string) => void)(text));
const commitButton = () => screen.getByRole("button", { name: "Commit" });
const layOut = (lines: number) =>
  act(() => (nativeProps.get(screen.getByTestId("notice-measure"))!.onTextLayout as (event: unknown) => void)({ nativeEvent: { lines: Array.from({ length: lines }, () => ({})) } }));

it("keeps the message as a draft, and a commit made closes the sheet and clears it", async () => {
  const commit = vi.fn(async () => ({ sha: "b2c3d4e5f6a7" }));
  mac.reads["review.commitThread"] = commit;
  open();
  await waitFor(() => expect(screen.getByText("3 files")).toBeTruthy());
  fireEvent.click(commitButton());
  expect(commit).not.toHaveBeenCalled();
  write("Fix pairing\n\nWhy it broke.");
  expect(mac.phone!.saved.get("commit.mac-1.t1")).toBe("Fix pairing\n\nWhy it broke.");
  fireEvent.click(commitButton());
  await waitFor(() => expect(router.back).toHaveBeenCalled());
  expect(commit).toHaveBeenCalledWith({ threadId: "t1", message: "Fix pairing\n\nWhy it broke." });
  expect(mac.phone!.saved.has("commit.mac-1.t1")).toBe(false);
});

it("stays open with the hook's words when the commit is refused, with Details only once they are cut", async () => {
  mac.reads["review.commitThread"] = async () => {
    throw new Error("lint failed: token [redacted:github-token] is checked in");
  };
  open();
  write("Fix pairing");
  fireEvent.click(commitButton());
  await waitFor(() => expect(screen.getByTestId("notice-measure")).toBeTruthy());
  await layOut(1);
  expect(screen.getByText("lint failed: token [redacted:github-token] is checked in")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Details" })).toBeNull();
  mac.reads["review.commitThread"] = async () => {
    throw new Error(Array.from({ length: 5 }, (_, index) => `src/${index}.ts: no-console`).join("\n"));
  };
  fireEvent.click(commitButton());
  await waitFor(() => expect(screen.getByTestId("notice-measure")).toBeTruthy());
  await layOut(5);
  expect(screen.getByRole("button", { name: "Details" })).toBeTruthy();
  expect(router.back).not.toHaveBeenCalled();
  expect(mac.phone!.saved.get("commit.mac-1.t1")).toBe("Fix pairing");
});

it("never sends a commit lost with the link again, and settles it from the log once the link is back", async () => {
  const commit = vi.fn(async () => {
    throw new Error(DROPPED);
  });
  mac.reads["review.commitThread"] = commit;
  open();
  write("Fix pairing");
  await waitFor(() => expect(screen.getByText("3 files")).toBeTruthy());
  fireEvent.click(commitButton());
  await waitFor(() => expect(screen.getByText("Lost Studio before it answered.")).toBeTruthy());
  fireEvent.click(screen.getByRole("button", { name: "Committing…" }));
  await new Promise((resolve) => setTimeout(resolve, 5));
  log = [{ sha: "c3d4e5f6a7b8", author: "QA", at: 2, subject: "Fix pairing" }, head];
  await act(() => mac.phone!.module.queryClient.invalidateQueries());
  await waitFor(() => expect(router.back).toHaveBeenCalled());
  expect(commit).toHaveBeenCalledOnce();
  expect(mac.phone!.saved.has("commit.mac-1.t1")).toBe(false);
});

it("waits for a write the Mac still runs after the link came back, then settles it", async () => {
  mac.reads["review.commitThread"] = async () => {
    throw new Error(DROPPED);
  };
  open();
  write("Fix pairing");
  await waitFor(() => expect(screen.getByText("3 files")).toBeTruthy());
  fireEvent.click(commitButton());
  await waitFor(() => expect(screen.getByText("Lost Studio before it answered.")).toBeTruthy());
  await new Promise((resolve) => setTimeout(resolve, 5));
  // Back while the hook still runs: the log has no new commit yet, and the lease is held.
  busy = true;
  await act(() => mac.phone!.module.queryClient.invalidateQueries());
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(screen.getByText("Lost Studio before it answered.")).toBeTruthy();
  expect(router.back).not.toHaveBeenCalled();
  // The hook ends and the commit lands; the core's pushes read everything again.
  busy = false;
  log = [{ sha: "c3d4e5f6a7b8", author: "QA", at: 2, subject: "Fix pairing" }, head];
  await act(() => mac.phone!.module.queryClient.invalidateQueries());
  await waitFor(() => expect(router.back).toHaveBeenCalled());
  expect(mac.phone!.saved.has("commit.mac-1.t1")).toBe(false);
});

it("fits its content over the keyboard, where the home indicator's inset does not apply", async () => {
  const sheetRoom = () => {
    const scroll = Array.from(document.querySelectorAll("div")).find((element) => nativeProps.get(element)?.contentContainerStyle);
    return flatStyle(nativeProps.get(scroll!)!.contentContainerStyle).paddingBottom;
  };
  keyboard.up = true;
  open();
  await waitFor(() => expect(screen.getByText("3 files")).toBeTruthy());
  expect(sheetRoom()).toBe(16);
  cleanup();
  keyboard.up = false;
  open();
  await waitFor(() => expect(screen.getByText("3 files")).toBeTruthy());
  expect(sheetRoom()).toBe(50);
});

it("reads the log again once the Mac says the workspace is free, so a log read while the hook ran does not settle it", async () => {
  mac.reads["review.commitThread"] = async () => {
    throw new Error(DROPPED);
  };
  open();
  write("Fix pairing");
  await waitFor(() => expect(screen.getByText("3 files")).toBeTruthy());
  fireEvent.click(commitButton());
  await waitFor(() => expect(screen.getByText("Lost Studio before it answered.")).toBeTruthy());
  await new Promise((resolve) => setTimeout(resolve, 5));
  // The log is read just before the commit lands, the push state just after.
  let landed = false;
  const made: Commit = { sha: "c3d4e5f6a7b8", author: "QA", at: 2, subject: "Fix pairing" };
  mac.reads["git.threadLog"] = async () => {
    const seen = landed;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return seen ? [made, head] : [head];
  };
  mac.reads["git.threadPushState"] = async () => {
    landed = true;
    return { ...push, busy: false };
  };
  await act(() => mac.phone!.module.queryClient.invalidateQueries());
  await waitFor(() => expect(router.back).toHaveBeenCalled());
  expect(mac.phone!.saved.has("commit.mac-1.t1")).toBe(false);
});
