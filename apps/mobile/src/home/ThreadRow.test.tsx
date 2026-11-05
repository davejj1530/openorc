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
  // Where it works, not what it was doing when the Mac last answered.
  expect(view.getByText("perf/transcript-paging · Mac asleep")).toBeTruthy();
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
