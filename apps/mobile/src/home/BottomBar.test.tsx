// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { felt } from "../test-fixtures/haptics";
import { nativeProps } from "../test-fixtures/react-native";
import { BAR_HEIGHT, BottomBar, lensAt, tabAt, tabWidth, type HomeTab } from "./BottomBar";
import { TabLayers } from "./TabLayers";

afterEach(() => {
  cleanup();
  felt.length = 0;
});

/** The bar's lens gesture, as the detector holds it, to run its callbacks as a finger would. */
type Lens = { config: { onBegin: (event: { x: number }) => void; onUpdate: (event: { x: number }) => void; onTouchesCancel: () => void; onFinalize: () => void } };
const lens = () => {
  const detector = Array.from(document.querySelectorAll("div")).find((element) => nativeProps.get(element)?.gesture);
  return nativeProps.get(detector!)!.gesture as Lens;
};
/** The middle of tab `at`, across the capsule, at the screen's tab width. */
const over = (at: number) => 4 + tabWidth(390, 3) * (at + 0.5);

function bar(chosen: HomeTab[], tab: HomeTab = "threads") {
  return render(
    <BottomBar tab={tab} tabs={["threads", "orclings", "tasks"]} onTab={(next) => chosen.push(next)} badge={0} action={{ kind: "press", label: "New thread", onPress: () => undefined }} />,
  );
}

it("shows the tabs as glyphs alone, named for VoiceOver, which chooses one with a double tap", () => {
  const chosen: HomeTab[] = [];
  bar(chosen);
  expect(screen.getAllByRole("tab").map((tab) => tab.getAttribute("aria-label"))).toEqual(["Threads", "Orclings", "Tasks"]);
  expect(screen.queryByText("Threads")).toBeNull();
  const voice = (name: string) => (nativeProps.get(screen.getByRole("tab", { name }))!.onAccessibilityTap as () => void)();
  voice("Threads");
  voice("Tasks");
  expect(chosen).toEqual(["tasks"]);
  expect(felt).toEqual(["selection"]);
});

it("raises a lens under a touch that can slide across the tabs, ticking at each, and chooses the one it is let go over", () => {
  const chosen: HomeTab[] = [];
  bar(chosen);
  const { config } = lens();
  act(() => config.onBegin({ x: over(0) }));
  expect(felt).toEqual([]);
  act(() => config.onUpdate({ x: over(1) }));
  act(() => config.onUpdate({ x: over(2) }));
  act(() => config.onUpdate({ x: over(2) + 4 }));
  expect(felt).toEqual(["selection", "selection"]);
  act(() => config.onFinalize());
  expect(chosen).toEqual(["tasks"]);
});

it("chooses a tab tapped in place, keeps the tab held and let go where it started, and keeps the tab a lost touch was on", () => {
  const chosen: HomeTab[] = [];
  bar(chosen);
  const { config } = lens();
  act(() => config.onBegin({ x: over(1) }));
  act(() => config.onFinalize());
  expect(chosen).toEqual(["orclings"]);
  act(() => config.onBegin({ x: over(0) }));
  act(() => config.onFinalize());
  expect(chosen).toEqual(["orclings"]);
  act(() => config.onBegin({ x: over(2) }));
  act(() => config.onTouchesCancel());
  act(() => config.onFinalize());
  expect(chosen).toEqual(["orclings"]);
});

it("keeps the lens over the tabs however far a finger goes past their ends", () => {
  const width = tabWidth(390, 3);
  expect(lensAt(-40, width, 3)).toBe(0);
  expect(lensAt(1000, width, 3)).toBe(2 * width);
  expect(tabAt(-40, width, 3)).toBe(0);
  expect(tabAt(1000, width, 3)).toBe(2);
});

it("sizes the tabs to fit centered with New clear of them, from a small phone to a large one", () => {
  for (const screenWidth of [375, 393, 402, 440]) {
    const width = tabWidth(screenWidth, 3);
    const capsuleEnd = screenWidth / 2 + (3 * width + 8) / 2;
    const newStart = screenWidth - 16 - BAR_HEIGHT;
    expect(newStart - capsuleEnd, `${screenWidth}`).toBeGreaterThanOrEqual(24);
  }
  expect(tabWidth(440, 3)).toBe(74);
  expect(tabWidth(375, 3)).toBeGreaterThanOrEqual(52);
});

it("does what the tab in front makes at a tap, or opens a menu of it", () => {
  const done: string[] = [];
  const view = render(<BottomBar tab="tasks" tabs={["threads", "tasks"]} onTab={() => undefined} badge={0} action={{ kind: "press", label: "New task", onPress: () => void done.push("task") }} />);
  screen.getByRole("button", { name: "New task" }).click();
  expect(done).toEqual(["task"]);
  const menu = {
    kind: "menu" as const,
    label: "New",
    items: [
      { label: "New Orcling", icon: "face.smiling" as const, onPress: () => void done.push("orcling") },
      { label: "New Thread", icon: "square.and.pencil" as const, onPress: () => void done.push("thread") },
    ],
  };
  view.rerender(<BottomBar tab="orclings" tabs={["threads", "orclings"]} onTab={() => undefined} badge={0} action={menu} />);
  fireEvent.click(screen.getByRole("button", { name: "New" }));
  fireEvent.click(screen.getByRole("button", { name: "New Orcling" }));
  fireEvent.click(screen.getByRole("button", { name: "New Thread" }));
  expect(done).toEqual(["task", "orcling", "thread"]);
});

it("builds a tab when it first shows and keeps it once left, hidden from VoiceOver while another shows", () => {
  const layers = (tab: HomeTab) => <TabLayers tab={tab} render={(each) => <p>{each} list</p>} />;
  const { rerender } = render(layers("threads"));
  expect(screen.queryByText("orclings list")).toBeNull();
  rerender(layers("orclings"));
  expect(screen.getByText("threads list").closest("[aria-hidden]")).not.toBeNull();
  expect(screen.getByText("orclings list").closest("[aria-hidden]")).toBeNull();
  expect(screen.queryByText("tasks list")).toBeNull();
  rerender(layers("threads"));
  expect(screen.getByText("threads list").closest("[aria-hidden]")).toBeNull();
  expect(screen.getByText("orclings list").closest("[aria-hidden]")).not.toBeNull();
});
