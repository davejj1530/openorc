// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ThreadAction } from "../thread/thread-actions";
import { fixtureThreads } from "./test-fixtures/threads";
import { MAC_ASLEEP } from "./out-of-reach";
import { ThreadRow } from "./ThreadRow";

const menus = vi.hoisted(() => ({ built: [] as ThreadAction[][][] }));
vi.mock("../generated/icons", async (original) => ({ ...(await original<object>()), CircleDashed: () => <svg aria-label="Neutral status mark" /> }));

vi.mock("expo-router", () => {
  const Link = ({ children }: { children: ReactNode }) => <div data-testid="opens-thread">{children}</div>;
  Link.Trigger = ({ children }: { children: ReactNode }) => <>{children}</>;
  return { Link };
});
vi.mock("../ui/SwipeRow", () => ({ SwipeRow: ({ children }: { children: ReactNode }) => <div data-testid="swipes">{children}</div> }));
vi.mock("./row-run", () => ({ useRowRun: () => undefined }));
vi.mock("../thread/use-thread-actions", () => ({ useThreadActions: () => ({ save: () => undefined, run: () => undefined }) }));
vi.mock("../thread/ThreadMenu", () => ({
  rowMenu: (sections: ThreadAction[][]) => {
    menus.built.push(sections);
    return null;
  },
}));

beforeEach(() => vi.useFakeTimers({ now: new Date(2026, 9, 21, 17) }));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  menus.built.length = 0;
});

const snoozeLabels = (sections: ThreadAction[][] | undefined) => {
  const snooze = sections?.flat().find((action) => action.kind === "menu");
  return snooze?.kind === "menu" ? snooze.actions.map((action) => action.label) : [];
};

it("rebuilds a row's menu on the shared snooze clock, so it stops offering This evening once the evening has begun", () => {
  const plan = fixtureThreads.find((thread) => thread.id === "t-plan")!;
  render(<ThreadRow thread={plan} project="openorc" arriving={false} />);
  expect(snoozeLabels(menus.built.at(-1))).toContain("This evening");
  act(() => void vi.advanceTimersByTime(50 * 60_000));
  expect(snoozeLabels(menus.built.at(-1))).not.toContain("This evening");
});

it("shows a row of a Mac out of reach from its last list: it opens nothing, has no swipes or menu, and says why when pressed", () => {
  const paging = fixtureThreads.find((thread) => thread.id === "t-paging")!;
  const view = render(<ThreadRow thread={{ ...paging, owner: { brain: "mac", reach: "offline", heardAt: 1 } }} project={null} arriving={false} />);
  expect(view.queryByTestId("opens-thread")).toBeNull();
  expect(view.queryByTestId("swipes")).toBeNull();
  expect(menus.built).toEqual([]);
  // Whose it is, not what it was doing when the Mac last answered.
  expect(view.getByText("worktree · Mac asleep")).toBeTruthy();
  expect(view.queryByText(MAC_ASLEEP)).toBeNull();
  fireEvent.click(view.getByRole("button"));
  expect(view.getByText(MAC_ASLEEP)).toBeTruthy();
  cleanup();
  const live = render(<ThreadRow thread={{ ...paging, owner: { brain: "mac", reach: "live", heardAt: 1 } }} project={null} arriving={false} />);
  expect(live.getByTestId("opens-thread")).toBeTruthy();
  expect(live.getByTestId("swipes")).toBeTruthy();
  expect(menus.built.length).toBeGreaterThan(0);
});

it("marks missing subagent updates with a neutral dashed circle", () => {
  const thread = { ...fixtureThreads[0]!, subagent: { status: "no_updates" as const, agentType: null, toolCallId: null, startedAt: 1, endedAt: 2, stoppable: false } };
  const view = render(<ThreadRow thread={thread} project="openorc" arriving={false} />);
  expect(view.getByLabelText("No updates").contains(view.getByLabelText("Neutral status mark"))).toBe(true);
});

it("lights up a working thread's title and still says it works, while an idle title stays plain", () => {
  const paging = fixtureThreads.find((thread) => thread.id === "t-paging")!;
  const working = render(<ThreadRow thread={paging} project="openorc" arriving={false} />);
  expect(working.container.querySelector("[data-masked]")?.textContent).toBe(paging.title);
  expect(working.getByRole("button").getAttribute("aria-label")).toContain("Working");
  cleanup();
  const plan = fixtureThreads.find((thread) => thread.id === "t-plan")!;
  const idle = render(<ThreadRow thread={plan} project="Workspace" arriving={false} />);
  expect(idle.container.querySelector("[data-masked]")).toBeNull();
  expect(idle.getByText(plan.title)).toBeTruthy();
});

it("names a root row's project under its title, with its pull request's state and number at the end", () => {
  const canvas = fixtureThreads.find((thread) => thread.id === "t-canvas")!;
  const view = render(<ThreadRow thread={canvas} project="immaculate" arriving={false} />);
  expect(view.getByText("immaculate")).toBeTruthy();
  expect(view.getByLabelText("Pull request #93, closed").textContent).toBe("#93");
  expect(view.getByRole("button").getAttribute("aria-label")).toContain("Pull request #93, closed");
});

it("says after a root row's project where its thread works: the checkout's branch, a worktree, or the cloud, named once", () => {
  const notes = fixtureThreads.find((thread) => thread.id === "t-notes")!;
  const tokens = fixtureThreads.find((thread) => thread.id === "t-tokens")!;
  expect(render(<ThreadRow thread={{ ...notes, branch: "main" }} project="openorc" arriving={false} />).getByText("openorc · main")).toBeTruthy();
  cleanup();
  expect(render(<ThreadRow thread={tokens} project="immaculate" arriving={false} />).getByText("immaculate · worktree")).toBeTruthy();
  cleanup();
  const cloud = render(<ThreadRow thread={{ ...tokens, owner: { brain: "cloud", reach: "live", heardAt: 1 } }} project="immaculate" arriving={false} />);
  expect(cloud.getByText("immaculate · cloud")).toBeTruthy();
});

it("keeps a parent's disclosure on its own row, beside the link that opens the thread, and asks for the opposite fold", () => {
  const parent = fixtureThreads.find((thread) => thread.id === "t-plan")!;
  const tree = { thread: parent, depth: 0, hasChildren: true, expanded: false, last: true, continuing: [] };
  const onFold = vi.fn();
  const view = render(<ThreadRow thread={parent} project={null} arriving={false} tree={tree} onFold={onFold} />);
  const expand = view.getByRole("button", { name: `Expand ${parent.title}` });
  expect(view.getByTestId("opens-thread").contains(expand)).toBe(false);
  fireEvent.click(expand);
  expect(onFold).toHaveBeenCalledExactlyOnceWith(parent.id, true);
  view.rerender(<ThreadRow thread={parent} project={null} arriving={false} tree={{ ...tree, expanded: true }} onFold={onFold} />);
  fireEvent.click(view.getByRole("button", { name: `Collapse ${parent.title}` }));
  expect(onFold).toHaveBeenLastCalledWith(parent.id, false);
  // While its sub threads fade out, it already reads closed, and pressing it again keeps them.
  view.rerender(<ThreadRow thread={parent} project={null} arriving={false} tree={{ ...tree, expanded: true }} motion={{ folding: true }} onFold={onFold} />);
  fireEvent.click(view.getByRole("button", { name: `Expand ${parent.title}` }));
  expect(onFold).toHaveBeenLastCalledWith(parent.id, true);
});
