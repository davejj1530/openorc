import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { BrowserPaneState } from "../../../shared/types";
import { CoversPreview } from "../lib/browser-preview";
import { BrowserPanel } from "./BrowserPanel";

const page: BrowserPaneState = { url: "http://localhost:3000/", title: "App", canGoBack: false, canGoForward: false, loading: false, error: null };
const frame = "data:image/jpeg;base64,cGl4ZWxz";

/**
 * Every call the panel makes into main, in order, noting whether a still was
 * on screen at the time. The order is the whole point: a still painted after
 * the view leaves, or dropped before it returns, is a frame of empty panel.
 */
let calls: string[];
let showing: PromiseWithResolvers<BrowserPaneState>;
let capture: PromiseWithResolvers<string | null>;
let push: (state: BrowserPaneState) => void;

const still = () => document.querySelector("img");
const log = (call: string) => calls.push(still() ? `${call} over still` : call);

beforeEach(() => {
  calls = [];
  showing = Promise.withResolvers();
  capture = Promise.withResolvers();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  HTMLImageElement.prototype.decode = () => Promise.resolve();
  vi.stubGlobal("openorc", {
    browser: {
      onState: (_id: string, cb: (state: BrowserPaneState) => void) => {
        push = cb;
        return () => {};
      },
      show: () => {
        log("show");
        return showing.promise;
      },
      hide: () => log("hide"),
      capture: () => {
        log("capture");
        return capture.promise;
      },
      setBounds: () => {},
    },
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** A panel whose first reveal has landed on `state`. Every later reveal waits on `showing`. */
async function mounted(state = page): Promise<void> {
  render(<BrowserPanel id="thread:a" defaultUrl="http://localhost:3000/" />);
  expect(calls).toEqual(["show"]);
  await act(async () => showing.resolve(state));
  showing = Promise.withResolvers();
}

it("paints the still before the view leaves, and drops it only once the view is back", async () => {
  await mounted();
  const layer = render(<CoversPreview />);
  expect(calls).toEqual(["show", "capture"]);

  capture.resolve(frame);
  await waitFor(() => expect(calls).toEqual(["show", "capture", "hide over still"]));
  expect(still()?.getAttribute("src")).toBe(frame);

  layer.unmount();
  expect(calls).toEqual(["show", "capture", "hide over still", "show over still"]);
  // Main has not put the view back yet, so the still keeps the rectangle.
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(still()).not.toBeNull();

  showing.resolve(page);
  await waitFor(() => expect(still()).toBeNull());
});

it("leaves the view where it is when the layer closes before the still is ready", async () => {
  await mounted();
  render(<CoversPreview />).unmount();
  capture.resolve(frame);
  await waitFor(() => expect(calls).toEqual(["show", "capture", "show"]));
  // Past the frames a late swap would wait out before hiding.
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(calls).toEqual(["show", "capture", "show"]);
  expect(still()).toBeNull();
});

it("keeps a page still loading from landing on top of the layer", async () => {
  await mounted({ ...page, loading: true });
  const layer = render(<CoversPreview />);
  capture.resolve(null);
  await waitFor(() => expect(calls).toEqual(["show", "capture", "hide"]));

  layer.unmount();
  await waitFor(() => expect(calls).toEqual(["show", "capture", "hide", "show"]));
  expect(still()).toBeNull();
});

it("drops the still for the failure that arrived under the layer, without asking for the view back", async () => {
  await mounted();
  const layer = render(<CoversPreview />);
  capture.resolve(frame);
  await waitFor(() => expect(calls).toEqual(["show", "capture", "hide over still"]));

  act(() => push({ ...page, error: "Nothing is listening on localhost:3000 yet." }));
  layer.unmount();
  expect(still()).toBeNull();
  expect(screen.getByText("Could not load the preview")).toBeTruthy();
  expect(calls).toEqual(["show", "capture", "hide over still"]);
});
