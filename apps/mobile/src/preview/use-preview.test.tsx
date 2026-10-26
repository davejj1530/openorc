// @vitest-environment jsdom
import type { AssetRef, PreviewState } from "@openorc/protocol";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LinkState } from "../connection/manager";
import { appState } from "../test-fixtures/react-native";
import { usePreview } from "./use-preview";

const studio = { id: "mac-1", name: "Studio" };
const lan: LinkState = { kind: "connected", mac: studio, route: { kind: "lan", host: "studio.local", port: 1 }, serial: 1 };
const page = (seq: number | null, pane = "p1"): PreviewState => ({
  open: true,
  pane,
  address: "http://127.0.0.1:47831/tick",
  title: "QA Tick",
  phase: "live",
  error: null,
  frame: seq === null ? null : { seq, width: 786, height: 566 },
});

/** A Mac the hook watches: its answers, the frames asked of it (each held until a test sends its bytes), its pushes. */
const mac = vi.hoisted(() => {
  const links = new Set<() => void>();
  const previews = new Set<(push: unknown) => void>();
  return {
    link: null as unknown as LinkState,
    links,
    focused: true,
    answer: (_params: unknown): Promise<unknown> => Promise.resolve(null),
    calls: [] as [string, unknown][],
    fetches: [] as { ref: AssetRef; send: (bytes: number[]) => void; fail: (message?: string) => void }[],
    previews,
    setLink(next: LinkState) {
      this.link = next;
      links.forEach((listener) => listener());
    },
  };
});

vi.mock("expo-router", () => ({ useIsFocused: () => mac.focused }));
vi.mock("../client", async () => {
  const { useSyncExternalStore } = await import("react");
  const connection = {
    session: (method: string, params: unknown) => {
      mac.calls.push([method, params]);
      return method === "preview.watch" ? mac.answer(params) : Promise.resolve(null);
    },
    asset: (ref: AssetRef) =>
      new Promise((resolve, reject) => {
        mac.fetches.push({
          ref,
          send: (bytes) => resolve({ mime: "image/jpeg", bytes: Uint8Array.from(bytes) }),
          fail: (message = "The connection to your Mac dropped before it answered.") => reject(new Error(message)),
        });
      }),
    onPreview: (listener: (push: unknown) => void) => {
      mac.previews.add(listener);
      return () => mac.previews.delete(listener);
    },
  };
  const subscribe = (listener: () => void) => {
    mac.links.add(listener);
    return () => mac.links.delete(listener);
  };
  return { link: { connection }, useLinkState: () => useSyncExternalStore(subscribe, () => mac.link) };
});

beforeEach(() => {
  mac.link = lan;
  mac.focused = true;
  mac.answer = () => Promise.resolve(page(null));
  mac.calls.length = 0;
  mac.fetches.length = 0;
  appState.set("active");
});
afterEach(cleanup);

const watches = () => mac.calls.filter(([method]) => method === "preview.watch").map(([, params]) => params);
const unwatches = () => mac.calls.filter(([method]) => method === "preview.unwatch").length;
const asked = () => mac.fetches.map((fetch) => (fetch.ref.kind === "preview" ? fetch.ref.seq : null));
const push = (state: PreviewState, threadId = "t1") => act(() => mac.previews.forEach((listener) => listener({ type: "preview", threadId, state })));
const ended = (message: string, threadId = "t1") => act(() => mac.previews.forEach((listener) => listener({ type: "preview.ended", threadId, message })));
const watch = async () => {
  const hook = renderHook(() => usePreview("t1"));
  await waitFor(() => expect(hook.result.current.state).toBeDefined());
  return hook;
};

it("watches the thread while the screen is in front, at twice the view's width, at the route's pace", async () => {
  const { result } = await watch();
  expect(watches()).toEqual([{ threadId: "t1", width: 780, pace: "lan" }]);
  expect(result.current).toMatchObject({ state: page(null), refused: null, frame: null, connected: true, active: true });
});

it("fetches the frame the watch answered with, then the newest one announced, one at a time and never from a cache", async () => {
  mac.answer = () => Promise.resolve(page(1));
  const { result } = await watch();
  await waitFor(() => expect(asked()).toEqual([1]));
  push(page(2));
  push(page(3));
  expect(asked()).toEqual([1]);
  await act(async () => mac.fetches[0]!.send([1, 2, 3]));
  expect(result.current.frame).toEqual({ seq: 1, uri: "data:image/jpeg;base64,AQID", width: 786, height: 566, pane: "p1" });
  await waitFor(() => expect(asked()).toEqual([1, 3]));
  await act(async () => mac.fetches[1]!.send([4]));
  expect(result.current.frame).toMatchObject({ seq: 3, uri: "data:image/jpeg;base64,BA==" });
  push(page(3));
  expect(asked()).toEqual([1, 3]);
});

it("ends the watch and drops its frames when the screen is covered or the app leaves the front", async () => {
  mac.answer = () => Promise.resolve(page(1));
  const hook = await watch();
  await waitFor(() => expect(asked()).toEqual([1]));
  await act(async () => mac.fetches[0]!.send([1]));
  act(() => appState.set("inactive"));
  expect(hook.result.current.frame).toBeNull();
  expect(hook.result.current.active).toBe(false);
  expect(unwatches()).toBe(1);
  act(() => appState.set("active"));
  await waitFor(() => expect(watches()).toHaveLength(2));
  mac.focused = false;
  hook.rerender();
  expect(unwatches()).toBe(2);
  hook.unmount();
  expect(unwatches()).toBe(2);
});

it("watches again on every new session, and fetches the answer's frame though it shows, which gives the Mac its credit back", async () => {
  mac.answer = () => Promise.resolve(page(4));
  const { result } = await watch();
  await waitFor(() => expect(asked()).toEqual([4]));
  await act(async () => mac.fetches[0]!.send([1]));
  act(() => mac.setLink({ ...lan, serial: 2 }));
  await waitFor(() => expect(watches()).toHaveLength(2));
  await waitFor(() => expect(asked()).toEqual([4, 4]));
  expect(result.current.frame?.seq).toBe(4);
  expect(unwatches()).toBe(0);
});

it("keeps the last frame and fetches nothing while the Mac is out of reach", async () => {
  mac.answer = () => Promise.resolve(page(1));
  const { result } = await watch();
  await waitFor(() => expect(asked()).toEqual([1]));
  await act(async () => mac.fetches[0]!.send([1]));
  act(() => mac.setLink({ kind: "waiting", mac: studio, why: "unreachable", retryAt: null }));
  push(page(2));
  expect(asked()).toEqual([1]);
  expect(result.current).toMatchObject({ connected: false, frame: { seq: 1 } });
});

it("says why the Mac refused the watch, and asks again on a new session", async () => {
  mac.answer = () => Promise.reject(new Error("This thread is gone."));
  const hook = renderHook(() => usePreview("t1"));
  await waitFor(() => expect(hook.result.current.refused).toBe("This thread is gone."));
  mac.answer = () => Promise.resolve(page(null));
  act(() => mac.setLink({ ...lan, serial: 2 }));
  await waitFor(() => expect(hook.result.current.refused).toBeNull());
});

it("asks for frames twice as wide once a pinch settles past 1.75 times, and paces a tailnet route leanly", async () => {
  mac.link = { ...lan, route: { kind: "tailnet", host: "studio.tail.ts.net", port: 1 } };
  const { result } = await watch();
  act(() => result.current.onZoom(1.9, false));
  expect(watches()).toHaveLength(1);
  act(() => result.current.onZoom(2, true));
  await waitFor(() =>
    expect(watches()).toEqual([
      { threadId: "t1", width: 780, pace: "tailnet" },
      { threadId: "t1", width: 1560, pace: "tailnet" },
    ]),
  );
});

it("drops the frame when the page closes, and hears no other thread", async () => {
  mac.answer = () => Promise.resolve(page(1));
  const { result } = await watch();
  await waitFor(() => expect(asked()).toEqual([1]));
  await act(async () => mac.fetches[0]!.send([1]));
  push(page(9), "t2");
  expect(asked()).toEqual([1]);
  push({ open: false });
  expect(result.current).toMatchObject({ state: { open: false }, frame: null });
});

it("leaves the watch of a Preview opened over this one to that one, as the Mac keeps one watch per phone", async () => {
  const first = await watch();
  const second = renderHook(() => usePreview("t2"));
  await waitFor(() => expect(watches()).toHaveLength(2));
  first.unmount();
  expect(unwatches()).toBe(0);
  second.unmount();
  expect(unwatches()).toBe(1);
});

it("shows no frame that arrives after its page closed", async () => {
  mac.answer = () => Promise.resolve(page(1));
  const { result } = await watch();
  await waitFor(() => expect(asked()).toEqual([1]));
  push({ open: false });
  await act(async () => mac.fetches[0]!.send([1]));
  expect(result.current.frame).toBeNull();
});

it("asks again for a frame the Mac refused, since it captures nothing more until that one is fetched", async () => {
  mac.answer = () => Promise.resolve(page(1));
  const { result } = await watch();
  await waitFor(() => expect(asked()).toEqual([1]));
  await act(async () => mac.fetches[0]!.fail("Too many images at once."));
  push(page(1));
  expect(asked()).toEqual([1]);
  await waitFor(() => expect(asked()).toEqual([1, 1]));
  await act(async () => mac.fetches[1]!.send([7]));
  expect(result.current.frame).toMatchObject({ seq: 1, uri: "data:image/jpeg;base64,Bw==" });
  push(page(2));
  await waitFor(() => expect(asked()).toEqual([1, 1, 2]));
});

it("asks for the newest frame, not the refused one, when a newer one is named while it waits", async () => {
  mac.answer = () => Promise.resolve(page(1));
  const { result } = await watch();
  await waitFor(() => expect(asked()).toEqual([1]));
  await act(async () => mac.fetches[0]!.fail("Too many images at once."));
  push(page(2));
  await waitFor(() => expect(asked()).toEqual([1, 2]));
  await act(async () => mac.fetches[1]!.send([2]));
  await new Promise((resolve) => setTimeout(resolve, 700));
  expect(asked()).toEqual([1, 2]);
  expect(result.current.frame?.seq).toBe(2);
});

it("says the Mac's words when it ends the watch, as when it refuses one, and drops the frame and the page", async () => {
  mac.answer = () => Promise.resolve(page(1));
  const { result } = await watch();
  await waitFor(() => expect(asked()).toEqual([1]));
  await act(async () => mac.fetches[0]!.send([1]));
  ended("This thread is gone.", "t2");
  expect(result.current.refused).toBeNull();
  ended("This thread is gone.");
  expect(result.current).toMatchObject({ refused: "This thread is gone.", frame: null, state: { open: false } });
});
