import { cleanup, fireEvent, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useTabReorder, type ReorderTab } from "./use-tab-reorder";

const WIDTH = 100;
const GAP = 2;
const ids = ["a", "b", "c"];

function Strip({ reorder, onSelect }: { reorder: ReorderTab; onSelect: (id: string) => void }) {
  const strip = useRef<HTMLDivElement>(null);
  return (
    <div ref={strip} data-testid="strip" onPointerDown={useTabReorder(strip, reorder)}>
      {ids.map((id) => (
        <div key={id} data-tab={id}>
          <button onClick={() => onSelect(id)}>{id}</button>
        </div>
      ))}
    </div>
  );
}

/* jsdom has no PointerEvent, and without one fireEvent drops button, pointerId and the coordinates. */
class TestPointerEvent extends MouseEvent {
  readonly pointerId: number;
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 0;
  }
}

beforeEach(() => {
  vi.stubGlobal("PointerEvent", TestPointerEvent);
  HTMLElement.prototype.getAnimations = () => [];
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const index = ids.indexOf(this.dataset.tab ?? "");
    const left = index < 0 ? 0 : index * (WIDTH + GAP);
    return new DOMRect(left, 0, index < 0 ? ids.length * (WIDTH + GAP) : WIDTH, 30);
  });
});
afterEach(async () => {
  cleanup();
  // A drag stops swallowing clicks a moment after it ends.
  await new Promise((done) => setTimeout(done));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mount() {
  const reorder = vi.fn<ReorderTab>();
  const onSelect = vi.fn();
  const { container } = render(<Strip reorder={reorder} onSelect={onSelect} />);
  const tab = (id: string) => container.querySelector<HTMLElement>(`[data-tab="${id}"]`)!;
  const face = (id: string) => tab(id).querySelector("button")!;
  const drag = (id: string, from: number, to: number) => {
    fireEvent.pointerDown(face(id), { button: 0, pointerId: 1, clientX: from });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: to });
  };
  const release = (id: string) => {
    fireEvent.pointerUp(window, { pointerId: 1 });
    fireEvent.click(face(id));
  };
  return { reorder, onSelect, tab, drag, release };
}

it("drops a tab past each neighbour whose middle it crossed, the neighbours stepping aside meanwhile", () => {
  const { reorder, tab, drag, release } = mount();
  drag("a", 50, 110);
  expect(tab("a").style.transform).toBe("translateX(60px)");
  expect(tab("b").style.transform).toBe("translateX(-102px)");
  expect(tab("c").style.transform).toBe("translateX(0px)");
  release("a");
  expect(reorder).toHaveBeenCalledExactlyOnceWith("a", "c");
  expect(tab("a").style.transform).toBe("");
  expect(tab("b").style.transform).toBe("");
});

it("carries the last tab to the front, and no further than the strip's ends", () => {
  const { reorder, tab, drag, release } = mount();
  drag("c", 250, -400);
  expect(tab("c").style.transform).toBe("translateX(-204px)");
  expect(tab("a").style.transform).toBe("translateX(102px)");
  expect(tab("b").style.transform).toBe("translateX(102px)");
  release("c");
  expect(reorder).toHaveBeenCalledExactlyOnceWith("c", "a");
});

it("leaves the order alone when the tab is dropped where it was, or the drag is cancelled", () => {
  const { reorder, drag, release } = mount();
  drag("b", 150, 170);
  release("b");
  drag("a", 50, 290);
  fireEvent.pointerCancel(window, { pointerId: 1 });
  expect(reorder).not.toHaveBeenCalled();
});

it("keeps a press that barely moves a click, and a drag from clicking the tab it dropped", () => {
  const { reorder, onSelect, drag, release } = mount();
  drag("b", 150, 152);
  release("b");
  expect(onSelect).toHaveBeenCalledExactlyOnceWith("b");
  expect(reorder).not.toHaveBeenCalled();
  drag("b", 150, 20);
  release("b");
  expect(onSelect).toHaveBeenCalledTimes(1);
  expect(reorder).toHaveBeenCalledExactlyOnceWith("b", "a");
});
