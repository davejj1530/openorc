// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { noteReader, type ReadingWindow } from "./note-reading";

type Seen = (entries: { target: Element; isIntersecting: boolean }[]) => void;

let seen: Seen;
let focused: boolean;
let changed: () => void;
const read = vi.fn(async (_ids: string[]) => {});
const win: ReadingWindow = {
  focused: () => focused,
  onChange: (listener) => {
    changed = listener;
    return () => {};
  },
};

function reader() {
  return noteReader(read, { window: win, delay: 100, observe: (callback) => ((seen = callback), { observe() {}, unobserve() {}, disconnect() {} }) });
}

beforeEach(() => {
  vi.useFakeTimers();
  focused = true;
  read.mockClear();
  read.mockImplementation(async () => {});
});
afterEach(() => vi.useRealTimers());

it("marks read the notes on screen in the focused window, once, and never one only loaded", async () => {
  const notes = reader();
  const [a, b] = [document.createElement("article"), document.createElement("article")];
  notes.watch(a, "n1");
  notes.watch(b, "n2");
  seen([{ target: a, isIntersecting: true }]);
  await vi.advanceTimersByTimeAsync(100);
  expect(read.mock.calls).toEqual([[["n1"]]]);
  seen([{ target: a, isIntersecting: true }]);
  await vi.advanceTimersByTimeAsync(100);
  expect(read).toHaveBeenCalledTimes(1);
});

it("waits for the window to be the person's before marking what is on screen", async () => {
  const notes = reader();
  const a = document.createElement("article");
  notes.watch(a, "n1");
  focused = false;
  seen([{ target: a, isIntersecting: true }]);
  await vi.advanceTimersByTimeAsync(500);
  expect(read).not.toHaveBeenCalled();
  focused = true;
  changed();
  await vi.advanceTimersByTimeAsync(100);
  expect(read.mock.calls).toEqual([[["n1"]]]);
});

it("forgets a note that left the screen before it was read, and sends one that failed again when next seen", async () => {
  const notes = reader();
  const [a, b] = [document.createElement("article"), document.createElement("article")];
  notes.watch(a, "n1");
  notes.watch(b, "n2");
  seen([{ target: a, isIntersecting: true }]);
  seen([{ target: a, isIntersecting: false }]);
  read.mockRejectedValueOnce(new Error("offline"));
  seen([{ target: b, isIntersecting: true }]);
  await vi.advanceTimersByTimeAsync(100);
  expect(read.mock.calls).toEqual([[["n2"]]]);
  seen([{ target: b, isIntersecting: true }]);
  await vi.advanceTimersByTimeAsync(100);
  expect(read.mock.calls).toEqual([[["n2"]], [["n2"]]]);
});

it("sends at most a hundred notes at once, and the rest after", async () => {
  const notes = reader();
  const elements = Array.from({ length: 120 }, (_, i) => {
    const element = document.createElement("article");
    notes.watch(element, `n${i}`);
    return element;
  });
  seen(elements.map((target) => ({ target, isIntersecting: true })));
  await vi.advanceTimersByTimeAsync(100);
  await vi.advanceTimersByTimeAsync(100);
  expect(read.mock.calls.map(([ids]) => ids.length)).toEqual([100, 20]);
});
