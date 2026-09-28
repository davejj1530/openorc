import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ResizeManager } from "@pierre/diffs";

// Exercise the installed library's public setup/cleanup seam. Layout entries
// model a real code column and gutter: applying their widths reflows comments.
class ElementFixture {
  isConnected = true;
  children: ElementFixture[] = [];
  firstElementChild: ElementFixture | null = null;
  values = new Map<string, string>();
  style = {
    setProperty: vi.fn((name: string, value: string) => this.values.set(name, value)),
    removeProperty: vi.fn((name: string) => this.values.delete(name)),
  };
  constructor(readonly tagName: string) {}
  querySelectorAll() {
    return [];
  }
}

describe("diff annotation resize delivery", () => {
  let notify: ResizeObserverCallback;
  let frameId = 0;
  let frames: Map<number, FrameRequestCallback>;
  let managers: ResizeManager[];
  beforeEach(() => {
    frames = new Map();
    managers = [];
    vi.stubGlobal("HTMLElement", ElementFixture);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.set(++frameId, callback);
      return frameId;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          notify = callback;
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
  });
  afterEach(() => {
    managers.forEach((manager) => manager.cleanUp());
    vi.unstubAllGlobals();
  });
  const setup = () => {
    const code = new ElementFixture("CODE"),
      gutter = new ElementFixture("DIV"),
      pre = new ElementFixture("PRE");
    code.firstElementChild = gutter;
    pre.children = [code];
    const manager = new ResizeManager();
    managers.push(manager);
    manager.setup(pre as unknown as HTMLPreElement, { disableAnnotations: true });
    return { manager, code, gutter };
  };
  const resize = (...values: [ElementFixture, number][]) =>
    notify(
      values.map(([target, inlineSize]) => ({ target, contentBoxSize: [{ inlineSize, blockSize: 200 }], borderBoxSize: [{ inlineSize, blockSize: 200 }] })) as unknown as ResizeObserverEntry[],
      {} as ResizeObserver,
    );
  const paint = () => {
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach((callback) => callback(0));
  };

  it("defers column writes and coalesces latest entries per element without losing the gutter measurement", () => {
    const { code, gutter } = setup();
    resize([code, 360], [gutter, 33.2]);
    resize([code, 400]);
    expect(code.style.setProperty).not.toHaveBeenCalled();
    expect(frames.size).toBe(1);
    paint();
    expect(code.values.get("--diffs-column-width")).toBe("400px");
    expect(code.values.get("--diffs-column-number-width")).toBe("34px");
    expect(code.values.get("--diffs-column-content-width")).toBe("366px");
    expect(frames.size).toBe(0);
  });

  it("drops unregistered and disconnected targets while another manager remains live", () => {
    const first = setup(),
      second = setup(),
      detached = setup();
    resize([first.code, 360], [second.code, 420], [detached.code, 480]);
    first.manager.cleanUp();
    detached.code.isConnected = false;
    paint();
    expect(first.code.style.setProperty).not.toHaveBeenCalled();
    expect(detached.code.style.setProperty).not.toHaveBeenCalled();
    expect(second.code.values.get("--diffs-column-width")).toBe("420px");
  });

  it("cancels the queued frame when the final manager cleans up", () => {
    const { manager, code } = setup();
    resize([code, 360]);
    expect(frames.size).toBe(1);
    manager.cleanUp();
    expect(frames.size).toBe(0);
    paint();
    expect(code.style.setProperty).not.toHaveBeenCalled();
  });
});
