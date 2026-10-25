// @vitest-environment jsdom
import type { Commit, FileChangeStat, Project, PushState, RpcMethod, ThreadSummary, WorkspaceChanges } from "@openorc/protocol";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { router } from "expo-router";
import { Fragment, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LinkState } from "../connection/manager";
import type { FakeMac } from "../test-fixtures/fake-mac";
import { nativeProps } from "../test-fixtures/react-native";
import { ChangesScreen } from "./ChangesScreen";

const studio = { id: "mac-1", name: "Studio" };
const connected: LinkState = { kind: "connected", mac: studio, route: { kind: "lan", host: "studio.local", port: 1 }, serial: 1 };

/** A Mac with one worktree thread whose reads and writes a test sets; `title` holds the header the screen drew. */
const mac = vi.hoisted(() => ({
  phone: null as FakeMac | null,
  state: null as unknown as LinkState,
  reads: {} as Partial<Record<RpcMethod, () => Promise<unknown>>>,
  title: null as null | (() => ReactNode),
}));

vi.mock("../client", async () => {
  const { fakeMac } = await import("../test-fixtures/fake-mac");
  mac.phone = fakeMac((method) => mac.reads[method]?.() ?? Promise.reject(new Error(`no ${method}`)));
  return { ...mac.phone.module, useLinkState: () => mac.state, link: { ...mac.phone.module.link, retry: async () => undefined } };
});
vi.mock("expo-router", () => {
  const Stack = ({ children }: { children?: ReactNode }) => <>{children}</>;
  Stack.Screen = ({ options }: { options?: { headerTitle?: () => ReactNode } }) => {
    if (options?.headerTitle) mac.title = options.headerTitle;
    return null;
  };
  const navigation = { setOptions: () => undefined, isFocused: () => true, addListener: () => () => undefined };
  return { router: { push: vi.fn(), back: vi.fn() }, Stack, useLocalSearchParams: () => ({ threadId: "t1" }), useIsFocused: () => true, useNavigation: () => navigation };
});
vi.mock("@legendapp/list/react-native", () => ({
  LegendList: ({ data, renderItem, ListHeaderComponent }: { data: { key: string }[]; renderItem: (info: { item: unknown }) => ReactElement; ListHeaderComponent?: ReactElement }) => (
    <>
      {ListHeaderComponent}
      {data.map((item) => (
        <Fragment key={item.key}>{renderItem({ item })}</Fragment>
      ))}
    </>
  ),
}));

const stat = (path: string, insertions: number, deletions: number): FileChangeStat => ({ path, oldPath: null, status: "modified", body: { kind: "text", insertions, deletions } });
const changes = (files: FileChangeStat[]): WorkspaceChanges => ({
  comparison: "head",
  baseSha: null,
  totals: { files: files.length, insertions: files.reduce((sum, file) => sum + (file.body.kind === "text" ? file.body.insertions : 0), 0), deletions: 1 },
  files,
  unlisted: 0,
});
const thread = (over: Partial<ThreadSummary> = {}) =>
  ({
    id: "t1",
    projectId: "p1",
    title: "Pairing",
    agent: "codex",
    activity: "idle",
    branch: "feat/x",
    baseBranch: "main",
    workspaceMode: "worktree",
    worktreePath: "/w/t1",
    prUrl: null,
    prState: null,
    teamInstanceId: null,
    ...over,
  }) as ThreadSummary;
const project = { id: "p1", name: "Site", gitRemote: "https://github.com/fake/site.git", defaultBranch: "main" } as Project;
const commit: Commit = { sha: "b2c3d4e5f6", author: "QA", at: Date.now() - 60_000, subject: "Add pairing" };
const push = (over: Partial<PushState> = {}): PushState => ({ branch: "feat/x", blocked: null, published: true, unpushedCount: 1, unpushed: [commit.sha], busy: false, ...over });

function world(over: { thread?: ThreadSummary; files?: FileChangeStat[]; log?: Commit[]; push?: PushState } = {}) {
  mac.reads = {
    "threads.get": async () => over.thread ?? thread(),
    "projects.get": async () => project,
    "review.threadChanges": async () => changes(over.files ?? [stat("src/pair.ts", 2, 1), stat("src/link.ts", 1, 0)]),
    "git.threadLog": async () => over.log ?? [commit],
    "git.threadPushState": async () => over.push ?? push(),
    "system.gh": async () => ({ installed: true }),
  };
}

beforeEach(() => {
  mac.state = connected;
  mac.title = null;
  mac.phone!.saved.clear();
  mac.phone!.module.queryClient.clear();
  vi.mocked(router.push).mockClear();
  world();
});
afterEach(cleanup);

const open = () => render(<ChangesScreen />, { wrapper: mac.phone!.wrapper });
const button = (name: string) => screen.getByRole("button", { name });

it("lists the files and the branch's commits, with Commit in ink and Push after it", async () => {
  open();
  await waitFor(() => expect(screen.getByText("src/pair.ts")).toBeTruthy());
  expect(screen.getByText("Commits · feat/x")).toBeTruthy();
  expect(screen.getByText("Not pushed")).toBeTruthy();
  expect(screen.getByRole("menuitemradio", { name: "Uncommitted" }).getAttribute("aria-checked")).toBe("true");
  await waitFor(() => expect(button("Push 1 commit")).toBeTruthy());
  render(<>{mac.title?.()}</>, { wrapper: mac.phone!.wrapper });
  expect(screen.getByLabelText("Changes, 2 files · +3 −1")).toBeTruthy();
  fireEvent.click(button("Commit"));
  expect(router.push).toHaveBeenCalledWith({ pathname: "/commit", params: { threadId: "t1" } });
  fireEvent.click(button("src/pair.ts, Modified, +2 −1"));
  expect(router.push).toHaveBeenCalledWith({ pathname: "/diff", params: { threadId: "t1", path: "src/pair.ts", comparison: "head" } });
});

it("says Clean workspace with nothing to commit, push or open", async () => {
  world({ files: [], log: [], push: push({ unpushedCount: 0, unpushed: [] }), thread: thread({ branch: "main" }) });
  open();
  await waitFor(() => expect(screen.getByText("Clean workspace")).toBeTruthy());
  expect(screen.getByText("Edits the agent makes in this thread's worktree show up here, ready to commit.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Commit" })).toBeNull();
});

it("says why the pills are dim while the agent works", async () => {
  world({ thread: thread({ activity: "running" }) });
  open();
  await waitFor(() => expect(button("Commit")).toBeTruthy());
  fireEvent.click(button("Commit"));
  expect(router.push).not.toHaveBeenCalled();
  expect(screen.getByText("Wait for Codex to finish.")).toBeTruthy();
});

/** The notice's hidden copy lays out at `lines` lines, as the phone measures whether the shown three cut it. */
const layOut = (lines: number) =>
  act(() => (nativeProps.get(screen.getByTestId("notice-measure"))!.onTextLayout as (event: unknown) => void)({ nativeEvent: { lines: Array.from({ length: lines }, () => ({})) } }));

it("pushes at once, then holds what Git said: success until new commits, a refusal with Details once it is cut", async () => {
  world({ files: [] });
  const pushThread = vi.fn(async () => ({ remote: "origin", branch: "feat/x" }));
  mac.reads["review.pushThread"] = pushThread;
  open();
  await waitFor(() => expect(button("Push 1 commit")).toBeTruthy());
  mac.reads["git.threadPushState"] = async () => push({ unpushedCount: 0, unpushed: [] });
  fireEvent.click(button("Push 1 commit"));
  await waitFor(() => expect(screen.getByText("Pushed feat/x to origin")).toBeTruthy());
  expect(pushThread).toHaveBeenCalledOnce();

  mac.reads["git.threadPushState"] = async () => push();
  mac.reads["review.pushThread"] = async () => {
    throw new Error("origin has newer commits on feat/x. Pull them in first, then push again.");
  };
  await act(() => mac.phone!.module.queryClient.invalidateQueries());
  await waitFor(() => expect(button("Push 1 commit")).toBeTruthy());
  fireEvent.click(button("Push 1 commit"));
  await waitFor(() => expect(screen.getByTestId("notice-measure")).toBeTruthy());
  // Two lines are the whole sentence: no Details.
  await layOut(2);
  expect(screen.getByText("origin has newer commits on feat/x. Pull them in first, then push again.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Details" })).toBeNull();

  const output = "tests failed\n" + Array.from({ length: 6 }, (_, index) => `  case ${index} expected 1 got 2`).join("\n");
  mac.reads["review.pushThread"] = async () => {
    throw new Error(output);
  };
  fireEvent.click(button("Push 1 commit"));
  await waitFor(() => expect(screen.getByTestId("notice-measure")).toBeTruthy());
  await layOut(7);
  fireEvent.click(button("Details"));
  expect(router.push).toHaveBeenCalledWith({ pathname: "/details", params: { threadId: "t1" } });
});

it("leaves a team's publishing to the Mac, and says when the workspace could not be read", async () => {
  world({ thread: thread({ teamInstanceId: "team-1" }) });
  open();
  await waitFor(() => expect(screen.getByText("Publish a team's work on your Mac.")).toBeTruthy());
  expect(screen.queryByRole("button", { name: "Commit" })).toBeNull();
  cleanup();
  mac.phone!.module.queryClient.clear();
  mac.reads["review.threadChanges"] = async () => {
    throw new Error("This conversation was deleted.");
  };
  open();
  await waitFor(() => expect(screen.getByText("Could not read the workspace")).toBeTruthy(), { timeout: 4000 });
  expect(button("Retry")).toBeTruthy();
});
