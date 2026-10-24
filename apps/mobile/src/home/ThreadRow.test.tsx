// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ThreadAction } from "../thread/thread-actions";
import { fixtureThreads } from "./test-fixtures/threads";
import { ThreadRow } from "./ThreadRow";

const menus = vi.hoisted(() => ({ built: [] as ThreadAction[][][] }));

vi.mock("expo-router", () => {
  const Link = ({ children }: { children: ReactNode }) => <>{children}</>;
  Link.Trigger = ({ children }: { children: ReactNode }) => <>{children}</>;
  return { Link };
});
vi.mock("../ui/SwipeRow", () => ({ SwipeRow: ({ children }: { children: ReactNode }) => <>{children}</> }));
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
