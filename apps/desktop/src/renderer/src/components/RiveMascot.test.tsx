import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RiveMascot } from "./RiveMascot";
import type { CanvasAnimationInput } from "./canvas-animation";
import { useTheme } from "../lib/theme";

const player = vi.hoisted(() => ({
  ready: () => {},
  failed: () => {},
  create: vi.fn(),
  react: vi.fn(),
  cleanup: vi.fn(),
  setPlaying: vi.fn(),
  resize: vi.fn(),
  syncColors: vi.fn(),
}));

/** The most recent viewport observer. A test delivers one entry per state, oldest first, as a browser queues them. */
const viewport = vi.hoisted(() => ({ deliver: (..._intersecting: boolean[]) => {}, disconnected: false }));

vi.mock("./mascot-runtime", () => ({
  createMascotAnimation: ({ canvas, onReady, onError }: CanvasAnimationInput) => {
    player.create(canvas);
    player.ready = onReady;
    player.failed = onError;
    return player;
  },
}));

function setPageHidden(hidden: boolean) {
  Object.defineProperty(document, "hidden", { configurable: true, value: hidden });
  document.dispatchEvent(new Event("visibilitychange"));
}

/** A reduced-motion setting the test can change while the mascot is mounted. */
function stubReducedMotion(initial: boolean) {
  let matches = initial;
  const listeners = new Set<EventListenerOrEventListenerObject>();
  vi.spyOn(window, "matchMedia").mockImplementation((media): MediaQueryList => ({
    media,
    get matches() {
      return matches;
    },
    onchange: null,
    addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => void listeners.add(listener),
    removeEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => void listeners.delete(listener),
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => true,
  }));
  return (reduce: boolean) => {
    matches = reduce;
    const change = new Event("change");
    for (const listener of listeners) {
      if (typeof listener === "function") listener(change);
      else listener.handleEvent(change);
    }
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(private callback: (entries: { isIntersecting: boolean }[]) => void) {}
      observe() {
        viewport.disconnected = false;
        viewport.deliver = (...intersecting) => this.callback(intersecting.map((isIntersecting) => ({ isIntersecting })));
        viewport.deliver(true);
      }
      disconnect() {
        viewport.disconnected = true;
      }
    },
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(document, "hidden");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("shared Rive mascot", () => {
  it("plays the latest setup reaction once ready and reuses the player for later choices", async () => {
    const view = render(<RiveMascot reaction="Thinking" reactionKey="scan" />);
    await waitFor(() => expect(player.create).toHaveBeenCalledOnce());
    expect(player.react).not.toHaveBeenCalled();
    view.rerender(<RiveMascot reaction="Happy" reactionKey="ready" />);
    act(() => player.ready());
    expect(player.react).toHaveBeenLastCalledWith("Happy");
    view.rerender(<RiveMascot reaction="Happy" reactionKey="appearance" />);
    expect(player.react).toHaveBeenCalledTimes(2);
    expect(player.create).toHaveBeenCalledOnce();
    act(() => useTheme.setState({ choice: "dark" }));
    expect(player.syncColors).toHaveBeenCalledOnce();
    view.unmount();
    expect(player.cleanup).toHaveBeenCalledOnce();
  });

  it("keeps the matching still on failure and ignores callbacks after unmount", async () => {
    const view = render(<RiveMascot reaction="Working" />);
    await waitFor(() => expect(player.create).toHaveBeenCalledOnce());
    act(() => player.ready());
    expect(view.container.firstElementChild?.getAttribute("data-ready")).toBe("true");
    act(() => player.failed());
    expect(view.container.firstElementChild?.getAttribute("data-ready")).toBe("false");
    expect(view.container.querySelector("svg")).toBeTruthy();
    view.unmount();
    act(() => player.ready());
    expect(player.cleanup).toHaveBeenCalledOnce();
  });

  it("does not initialize Rive when reduced motion is requested", async () => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    vi.spyOn(window, "matchMedia").mockReturnValue({ ...media, matches: true });
    const view = render(<RiveMascot reaction="Happy" />);
    await act(async () => {});
    expect(player.create).not.toHaveBeenCalled();
    expect(view.container.firstElementChild?.getAttribute("data-ready")).toBe("false");
    expect(view.container.querySelector("svg")).toBeTruthy();
  });

  it("releases Rive under reduced motion and shows a new instance only after its own first frame", async () => {
    const setReducedMotion = stubReducedMotion(false);
    const view = render(<RiveMascot />);
    const frame = () => view.container.firstElementChild?.getAttribute("data-ready");
    await waitFor(() => expect(player.create).toHaveBeenCalledOnce());
    const released = { ready: player.ready, failed: player.failed };
    act(() => player.ready());
    expect(frame()).toBe("true");

    act(() => setReducedMotion(true));
    expect(player.cleanup).toHaveBeenCalledOnce();
    expect(frame()).toBe("false");

    act(() => setReducedMotion(false));
    await waitFor(() => expect(player.create).toHaveBeenCalledTimes(2));
    act(() => released.ready());
    expect(frame()).toBe("false");
    act(() => player.ready());
    expect(frame()).toBe("true");
    act(() => released.failed());
    expect(frame()).toBe("true");
  });

  it("plays only while on screen in a visible window and stops listening once unmounted", async () => {
    const view = render(<RiveMascot />);
    await waitFor(() => expect(player.create).toHaveBeenCalledOnce());
    expect(player.setPlaying).toHaveBeenLastCalledWith(true);

    act(() => viewport.deliver(false));
    expect(player.setPlaying).toHaveBeenLastCalledWith(false);
    act(() => viewport.deliver(true));
    expect(player.setPlaying).toHaveBeenLastCalledWith(true);
    act(() => setPageHidden(true));
    expect(player.setPlaying).toHaveBeenLastCalledWith(false);
    act(() => setPageHidden(false));
    expect(player.setPlaying).toHaveBeenLastCalledWith(true);
    window.dispatchEvent(new Event("resize"));
    expect(player.resize).toHaveBeenCalledOnce();

    view.unmount();
    expect(viewport.disconnected).toBe(true);
    vi.clearAllMocks();
    // A browser may still deliver an entry it queued before the observer disconnected.
    viewport.deliver(false);
    setPageHidden(true);
    window.dispatchEvent(new Event("resize"));
    act(() => useTheme.setState({ choice: "light" }));
    expect(player.setPlaying).not.toHaveBeenCalled();
    expect(player.resize).not.toHaveBeenCalled();
    expect(player.syncColors).not.toHaveBeenCalled();
  });

  it("follows the newest viewport entry when several arrive in one callback", async () => {
    render(<RiveMascot />);
    await waitFor(() => expect(player.create).toHaveBeenCalledOnce());
    act(() => viewport.deliver(false, true));
    expect(player.setPlaying).toHaveBeenLastCalledWith(true);
    act(() => viewport.deliver(true, false));
    expect(player.setPlaying).toHaveBeenLastCalledWith(false);
  });

  it("never creates Rive after unmounting while the runtime is still loading", async () => {
    const view = render(<RiveMascot />);
    view.unmount();
    await vi.dynamicImportSettled();
    await act(async () => {});
    expect(player.create).not.toHaveBeenCalled();
  });
});
