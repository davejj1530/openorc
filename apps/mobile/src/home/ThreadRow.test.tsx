// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ThreadAction } from "../thread/thread-actions";
import { flatStyle, nativeProps } from "../test-fixtures/react-native";
import { fixtureThreads } from "./test-fixtures/threads";
import { cloudPlace, ThreadRow } from "./ThreadRow";

const menus = vi.hoisted(() => ({ built: [] as ThreadAction[][][] }));
vi.mock("../generated/icons", async (original) => ({
  ...(await original<object>()),
  CircleDashed: () => <svg aria-label="Neutral status mark" />,
  Cloud: ({ className }: { className?: string }) => <svg aria-label="Cloud glyph" className={className} />,
}));

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

it("marks missing subagent updates with a neutral dashed circle", () => {
  const thread = { ...fixtureThreads[0]!, subagent: { status: "no_updates" as const, agentType: null, toolCallId: null, startedAt: 1, endedAt: 2, stoppable: false } };
  const view = render(<ThreadRow thread={thread} project="openorc" arriving={false} />);
  expect(view.getByLabelText("No updates").contains(view.getByLabelText("Neutral status mark"))).toBe(true);
});

const label = (view: ReturnType<typeof render>) => view.getByRole("button").getAttribute("aria-label") ?? "";

it("puts what a root row needs from you on its title's line, at its end, and says it only in the row's label", () => {
  const plan = fixtureThreads.find((thread) => thread.id === "t-plan")!;
  const view = render(<ThreadRow thread={{ ...plan, activity: "waiting" }} project="openorc" arriving={false} />);
  const question = view.getByLabelText("Needs you");
  expect(view.getByText(plan.title).parentElement?.parentElement?.contains(question)).toBe(true);
  expect(view.queryByText("Needs you")).toBeNull();
  expect(label(view)).toContain("Needs you");
});

it("lights up a working thread's title and says it works in its label, while an idle title stays plain", () => {
  const paging = fixtureThreads.find((thread) => thread.id === "t-paging")!;
  const working = render(<ThreadRow thread={paging} project="openorc" arriving={false} />);
  expect(working.container.querySelector("[data-masked]")?.textContent).toBe(paging.title);
  expect(working.queryByText("Working")).toBeNull();
  expect(label(working)).toContain("Working");
  cleanup();
  const plan = fixtureThreads.find((thread) => thread.id === "t-plan")!;
  const idle = render(<ThreadRow thread={plan} project="Workspace" arriving={false} />);
  expect(idle.container.querySelector("[data-masked]")).toBeNull();
  expect(idle.getByText(plan.title)).toBeTruthy();
});

it("keeps a root row to its title's line: its project, branch and pull request in its label, the pull request's mark in its slot", () => {
  const canvas = fixtureThreads.find((thread) => thread.id === "t-canvas")!;
  const view = render(<ThreadRow thread={canvas} project="immaculate" arriving={false} />);
  expect(view.queryByText("immaculate")).toBeNull();
  expect(view.queryByText("#93")).toBeNull();
  expect(label(view)).toContain("Pull request #93, closed");
  expect(label(view)).toContain("immaculate");
  cleanup();
  const notes = fixtureThreads.find((thread) => thread.id === "t-notes")!;
  const quiet = { ...notes, branch: "fix/menu", prUrl: null, lastActivityAt: Date.now() - 12 * 60_000 };
  const row = render(<ThreadRow thread={quiet} project="openorc" arriving={false} />);
  expect(row.getByTestId("opens-thread").textContent).toBe(`${quiet.title}12m`);
  expect(label(row)).toContain("openorc");
  expect(label(row)).toContain("fix/menu");
});

it("keeps the age and the mark in columns of their own on every row, so they line up down the list", () => {
  const plan = { ...fixtureThreads.find((thread) => thread.id === "t-plan")!, branch: null, prUrl: null };
  const ages = ["now", "12m", "11mo"];
  for (const [index, at] of [Date.now(), Date.now() - 12 * 60_000, Date.now() - 340 * 86_400_000].entries()) {
    const view = render(<ThreadRow thread={{ ...plan, lastActivityAt: at, activity: index ? "idle" : "waiting" }} project={null} arriving={false} />);
    expect(flatStyle(nativeProps.get(view.getByText(ages[index]!))!.style).width).toBe(32);
    // The mark's box is there with a mark and without one, so the age ends at one place.
    expect(Array.from(view.container.querySelectorAll("div")).filter((element) => /\bw-7\b/.test(String(nativeProps.get(element)?.className)))).toHaveLength(1);
    cleanup();
  }
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

it("leaves the cloud to a group label that wears it, and keeps the age and the mark at their columns with the cloud or without", () => {
  const plan = { ...fixtureThreads.find((thread) => thread.id === "t-plan")!, branch: null, prUrl: null, lastActivityAt: Date.now() - 12 * 60_000 };
  const cloud = { ...plan, id: "cloud", unread: true, owner: { brain: "hosted" as const, reach: "live" as const, heardAt: 1 } };
  for (const cloudLabel of [true, false]) {
    const view = render(<ThreadRow thread={cloud} project={null} cloudLabel={cloudLabel} arriving={false} />);
    expect(view.queryByLabelText("Cloud glyph") === null).toBe(cloudLabel);
    expect(flatStyle(nativeProps.get(view.getByText("12m"))!.style).width).toBe(32);
    expect(Array.from(view.container.querySelectorAll("div")).filter((element) => /\bw-7\b/.test(String(nativeProps.get(element)?.className)))).toHaveLength(1);
    // The label still says where it lives.
    expect(label(view)).toContain("OpenOrc Cloud");
    cleanup();
  }
});

it("marks an OpenOrc Cloud thread with the cloud and the face of the teammate who started it, says where in its label, and organizes it from its menu", () => {
  const mine = { ...fixtureThreads.find((thread) => thread.id === "t-plan")!, branch: null, prUrl: null };
  const cloud = { ...mine, id: "cloud", owner: { brain: "hosted" as const, reach: "live" as const, heardAt: 1, startedBy: { name: "Mara Okafor", image: null } } };
  const row = render(<ThreadRow thread={cloud} project="Canvas" arriving={false} />);
  expect(row.getByLabelText("Cloud glyph")).toBeTruthy();
  expect(row.getByText("MO")).toBeTruthy();
  expect(row.queryByText("Canvas · Mara")).toBeNull();
  expect(row.queryByText("OpenOrc Cloud")).toBeNull();
  expect(label(row)).toContain("Canvas, OpenOrc Cloud, started by Mara Okafor");
  // Pin, snooze, read state, rename and resolve, as on the Mac's own threads; OpenOrc Cloud starts no thread under another.
  const labels = menus.built
    .at(-1)!
    .flat()
    .map((action) => action.label);
  expect(labels).toEqual(expect.arrayContaining(["Pin", "Snooze", "Mark as Unread", "Rename…", "Resolve"]));
  expect(labels).not.toContain("New Subthread");
  row.unmount();

  const own = render(<ThreadRow thread={mine} project="Canvas" arriving={false} />);
  expect(own.queryByLabelText("Cloud glyph")).toBeNull();
  expect(menus.built.length).toBeGreaterThan(0);
});

it("says whose turn it is on a cloud thread someone else is in, in its label, and dims its cloud while the Mac cannot reach OpenOrc Cloud", () => {
  const mara = { id: "u-mara", name: "Mara Okafor", image: null };
  const working = { ...fixtureThreads.find((thread) => thread.id === "t-plan")!, branch: null, prUrl: null, activity: "running" as const };
  const owner = {
    brain: "hosted" as const,
    reach: "live" as const,
    heardAt: 1,
    startedBy: { name: "Mara Okafor", image: null },
    collaboration: {
      viewer: { id: "u-riley", name: "Riley Chen", image: null },
      canWrite: true,
      live: { id: "turn-1", sender: mara, startedAt: 1, stopping: false },
      send: "now" as const,
      handoff: null,
      canPostNote: true,
      canStop: true,
      ask: null,
      queue: [],
      mentions: { unread: false, firstUnreadNoteId: null },
      noteHead: 0,
    },
  };
  const row = render(<ThreadRow thread={{ ...working, id: "cloud", owner }} project="Canvas" arriving={false} />);
  expect(row.queryByText("Mara's turn")).toBeNull();
  expect(label(row)).toContain("Mara's turn");
  row.unmount();
  const cloud = { ...working, id: "cloud", owner };
  expect(cloudPlace(cloud, "Canvas")).toMatchObject({ offline: false });
  expect(cloudPlace(cloud, "Canvas", true)).toMatchObject({ offline: true });
  expect(cloudPlace({ ...cloud, owner: { ...owner, reach: "offline" } }, "Canvas")).toMatchObject({ offline: true });
  expect(cloudPlace(working, "Canvas")).toBeNull();
});
