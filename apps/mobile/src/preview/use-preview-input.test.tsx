// @vitest-environment jsdom
import type { PreviewFocus } from "@openorc/protocol";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { felt } from "../test-fixtures/haptics";
import type { PreviewImage } from "./use-preview";
import { usePreviewInput } from "./use-preview-input";

/** The Mac's session: each input it heard, answered by the test's `answer`. */
const mac = vi.hoisted(() => ({
  heard: [] as unknown[],
  answer: (_params: unknown): Promise<unknown> => Promise.resolve({ focus: null }),
}));
vi.mock("../client", () => ({
  link: {
    connection: {
      session: (method: string, params: unknown) => {
        if (method !== "preview.input") return Promise.reject(new Error(`no ${method}`));
        mac.heard.push(params);
        return mac.answer(params);
      },
    },
  },
}));

const frame = (pane = "0123456789ab"): PreviewImage => ({ seq: 1, uri: "data:image/jpeg;base64,1", width: 786, height: 566, pane });
const field: PreviewFocus = { kind: "text", keyboard: "email", enter: "go", secure: false, multiline: false };

beforeEach(() => {
  vi.useFakeTimers();
  mac.heard.length = 0;
  mac.answer = () => Promise.resolve({ focus: null });
  felt.length = 0;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const settle = () => act(() => vi.advanceTimersByTimeAsync(0));
const hooked = (shown: PreviewImage | null = frame()) => renderHook(({ image }) => usePreviewInput("t1", image), { initialProps: { image: shown } });

it("sends a tap on the shown frame for its pane, in that frame's pixels, with nothing felt", async () => {
  const { result } = hooked();
  act(() => result.current.tap({ x: 393, y: 283 }));
  await settle();
  expect(mac.heard).toEqual([{ threadId: "t1", pane: "0123456789ab", frame: { width: 786, height: 566 }, input: { kind: "tap", x: 393, y: 283, count: 1 } }]);
  expect(felt).toEqual([]);
});

it("counts a second tap near the first and soon after as a double click, and a late one as a new click", async () => {
  const { result } = hooked();
  act(() => result.current.tap({ x: 100, y: 100 }));
  await act(() => vi.advanceTimersByTimeAsync(200));
  act(() => result.current.tap({ x: 106, y: 103 }));
  await act(() => vi.advanceTimersByTimeAsync(1_000));
  act(() => result.current.tap({ x: 106, y: 103 }));
  await settle();
  expect(mac.heard.map((params) => (params as { input: { count: number } }).input.count)).toEqual([1, 2, 1]);
});

it("follows the Mac's focus: a field to type into, a new one after each tap, none once the focus leaves", async () => {
  const { result } = hooked();
  mac.answer = () => Promise.resolve({ focus: field });
  act(() => result.current.tap({ x: 10, y: 10 }));
  await settle();
  expect(result.current.focus).toEqual(field);
  const first = result.current.field;
  act(() => result.current.type([{ kind: "text", text: "a" }]));
  await settle();
  expect(result.current.field).toBe(first);
  act(() => result.current.type([{ kind: "key", key: "Tab", count: 1 }]));
  await settle();
  expect(result.current.field).toBe(first + 1);
  mac.answer = () => Promise.resolve({ focus: null });
  act(() => result.current.tap({ x: 10, y: 10 }));
  await settle();
  expect(result.current.focus).toBeNull();
});

it("says why the Mac refused, with a warning, and lets the words go after 2 s; a page that changed says nothing", async () => {
  const { result } = hooked();
  mac.answer = () => Promise.reject(new Error("The agent is using this page."));
  act(() => result.current.tap({ x: 10, y: 10 }));
  await settle();
  expect(result.current.notice).toBe("The agent is using this page.");
  expect(felt).toEqual(["warning"]);
  await act(() => vi.advanceTimersByTimeAsync(2_000));
  expect(result.current.notice).toBeNull();
  mac.answer = () => Promise.reject(new Error("The page changed."));
  act(() => result.current.scroll({ x: 10, y: 10 }, 0, 40));
  await settle();
  expect(result.current.notice).toBeNull();
  expect(felt).toEqual(["warning"]);
});

it("starts the phone's field over after a refusal, as the typing it dropped never reached the Mac", async () => {
  const { result } = hooked();
  mac.answer = () => Promise.resolve({ focus: field });
  act(() => result.current.tap({ x: 10, y: 10 }));
  await settle();
  const typing = result.current.field;
  let refuse!: () => void;
  mac.answer = () => new Promise((_resolve, reject) => (refuse = () => reject(new Error("Too many inputs at once."))));
  act(() => result.current.type([{ kind: "text", text: "Hello" }]));
  act(() => result.current.type([{ kind: "text", text: " world" }]));
  await act(async () => refuse());
  await settle();
  // " world" waited behind "Hello" and was dropped: the phone's field must not still hold it.
  expect(mac.heard).toHaveLength(2);
  expect(result.current.field).toBe(typing + 1);
  expect(result.current.focus).toEqual(field);
});

it("forgets the focus once another tab's frame comes, and sends nothing without a frame", async () => {
  const { result, rerender } = hooked();
  mac.answer = () => Promise.resolve({ focus: field });
  act(() => result.current.tap({ x: 10, y: 10 }));
  await settle();
  rerender({ image: frame("ffffffffffff") });
  expect(result.current.focus).toBeNull();
  rerender({ image: null });
  act(() => result.current.tap({ x: 10, y: 10 }));
  await settle();
  expect(mac.heard).toHaveLength(1);
});

it("chooses an option of the focused select with a selection tick, and closes the choice", async () => {
  const { result } = hooked();
  const choice: PreviewFocus = {
    kind: "choice",
    options: [
      { label: "Free", disabled: false },
      { label: "Pro", disabled: false },
    ],
    selected: 0,
  };
  mac.answer = () => Promise.resolve({ focus: choice });
  act(() => result.current.tap({ x: 10, y: 10 }));
  await settle();
  expect(result.current.focus).toEqual(choice);
  mac.answer = () => Promise.resolve({ focus: { ...choice, selected: 1 } });
  act(() => result.current.choose(1));
  await settle();
  expect(felt).toEqual(["selection"]);
  expect((mac.heard.at(-1) as { input: unknown }).input).toEqual({ kind: "choose", index: 1 });
  expect(result.current.focus).toBeNull();
});
