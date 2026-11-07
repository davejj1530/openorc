import type { ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CodeExplanation } from "@openorc/protocol";
import { DiagramView } from "./DiagramView";

vi.mock("../../components/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../components/ui")>()),
  Tooltip: ({ children }: { children: ReactNode }) => children,
}));

const diagram: Extract<CodeExplanation, { view: "diagram" }> = {
  view: "diagram",
  summary: "Loads the settings file and falls back to defaults.",
  nodes: [
    { id: "start", label: "Load settings", kind: "entry", summary: "Called once at startup.", detail: "Runs before the window opens.", lines: { start: 12, end: 30 } },
    { id: "exists", label: "File exists?", kind: "decision", summary: "Checks the settings path.", detail: "Uses **stat** rather than reading the file.", lines: { start: 14, end: 14 } },
    { id: "defaults", label: "Use defaults", kind: "output", summary: "Returns the built-in values.", detail: "Nothing is written back to disk.", lines: null },
  ],
  edges: [
    { from: "start", to: "exists", label: null },
    { from: "exists", to: "defaults", label: "no" },
    { from: "exists", to: "exists", label: "retry" },
  ],
};

/* jsdom has no PointerEvent, and without one fireEvent drops button, pointerId and the coordinates. */
class TestPointerEvent extends MouseEvent {
  readonly pointerId: number;
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 0;
  }
}

const onShowLines = vi.fn();
beforeEach(() => {
  vi.stubGlobal("PointerEvent", TestPointerEvent);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  Object.assign(HTMLElement.prototype, { setPointerCapture: () => {} });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const node = (label: string) => screen.getByRole("button", { name: label });
const detail = (label: string) => screen.queryByRole("region", { name: label });
const closed = () => waitFor(() => expect(screen.queryByRole("region", { hidden: true })).toBeNull());

it("shows every node as a button named by its label, with its summary, under the diagram's summary", () => {
  render(<DiagramView diagram={diagram} onShowLines={onShowLines} />);
  expect(screen.getByText(diagram.summary)).toBeTruthy();
  for (const { label, summary } of diagram.nodes) {
    expect(within(node(label)).getByText(summary)).toBeTruthy();
    expect(node(label).getAttribute("aria-expanded")).toBe("false");
  }
  expect(screen.getByText("no")).toBeTruthy();
  expect(screen.getByText("retry")).toBeTruthy();
});

it("opens one node's detail at a time, with its markdown rendered", async () => {
  render(<DiagramView diagram={diagram} onShowLines={onShowLines} />);
  fireEvent.click(node("Load settings"));
  expect(within(detail("Load settings")!).getByText("Runs before the window opens.")).toBeTruthy();
  expect(node("Load settings").getAttribute("aria-expanded")).toBe("true");

  fireEvent.click(node("File exists?"));
  const open = detail("File exists?")!;
  expect(within(open).getByText("stat").closest("p")?.textContent).toBe("Uses stat rather than reading the file.");
  expect(within(open).queryByText("**stat**", { exact: false })).toBeNull();
  expect(detail("Load settings")).toBeNull();
  expect(node("Load settings").getAttribute("aria-expanded")).toBe("false");
  expect(screen.getAllByRole("region")).toHaveLength(1);

  fireEvent.click(node("File exists?"));
  expect(detail("File exists?")).toBeNull();
  await closed();
});

it("shows a node's lines on request, naming the span", () => {
  render(<DiagramView diagram={diagram} onShowLines={onShowLines} />);
  fireEvent.click(node("Load settings"));
  fireEvent.click(within(detail("Load settings")!).getByRole("button", { name: "Show lines 12–30" }));
  expect(onShowLines).toHaveBeenCalledExactlyOnceWith({ start: 12, end: 30 });

  fireEvent.click(node("File exists?"));
  expect(within(detail("File exists?")!).getByRole("button", { name: "Show line 14" })).toBeTruthy();
});

it("offers no lines for a node without a span", () => {
  render(<DiagramView diagram={diagram} onShowLines={onShowLines} />);
  fireEvent.click(node("Use defaults"));
  const open = detail("Use defaults")!;
  expect(within(open).getByText("Nothing is written back to disk.")).toBeTruthy();
  expect(within(open).queryByRole("button", { name: /^Show line/ })).toBeNull();
});

it("closes the detail on Escape, on its close button, and on a click on the canvas background", async () => {
  render(<DiagramView diagram={diagram} onShowLines={onShowLines} />);
  fireEvent.click(node("Load settings"));
  fireEvent.keyDown(node("Load settings"), { key: "Escape" });
  expect(detail("Load settings")).toBeNull();
  expect(node("Load settings").getAttribute("aria-expanded")).toBe("false");
  await closed();

  fireEvent.click(node("Use defaults"));
  const close = within(detail("Use defaults")!).getByRole("button", { name: "Close" });
  close.focus();
  fireEvent.click(close);
  expect(detail("Use defaults")).toBeNull();
  expect(document.activeElement).toBe(node("Use defaults"));
  await closed();

  fireEvent.click(node("File exists?"));
  const canvas = screen.getByRole("group", { name: "Diagram" });
  fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, clientX: 5, clientY: 5 });
  fireEvent.pointerUp(canvas, { button: 0, pointerId: 1, clientX: 5, clientY: 5 });
  expect(detail("File exists?")).toBeNull();
  await closed();
});

it("keeps the detail open when the background is dragged rather than clicked", () => {
  render(<DiagramView diagram={diagram} onShowLines={onShowLines} />);
  fireEvent.click(node("File exists?"));
  const canvas = screen.getByRole("group", { name: "Diagram" });
  fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, clientX: 5, clientY: 5 });
  fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 60, clientY: 40 });
  fireEvent.pointerUp(canvas, { button: 0, pointerId: 1, clientX: 60, clientY: 40 });
  expect(detail("File exists?")).toBeTruthy();
});

it("has zoom in, zoom out and fit controls, and stops zooming in at the limit", () => {
  render(<DiagramView diagram={diagram} onShowLines={onShowLines} />);
  const zoom = screen.getByRole("group", { name: "Zoom" });
  const zoomIn = within(zoom).getByRole("button", { name: "Zoom in" });
  expect(within(zoom).getByRole("button", { name: "Zoom out" })).toBeTruthy();
  expect(within(zoom).getByRole("button", { name: "Fit to view" })).toBeTruthy();
  for (let press = 0; press < 3; press++) {
    expect((zoomIn as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(zoomIn);
  }
  fireEvent.click(zoomIn);
  expect((zoomIn as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(within(zoom).getByRole("button", { name: "Fit to view" }));
  expect((zoomIn as HTMLButtonElement).disabled).toBe(false);
});
