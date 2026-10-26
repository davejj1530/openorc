import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PreviewFocus, PreviewInput } from "@openorc/protocol";
import { InputQueue, type QueuedInput } from "./input-queue";

const target = { pane: "0123456789ab", frame: { width: 786, height: 566 } };
const other = { pane: "ffffffffffff", frame: { width: 786, height: 566 } };
const scroll = (dy: number, x = 393): PreviewInput => ({ kind: "scroll", x, y: 283, dx: 0, dy });

/** A Mac that answers each input when the test says so. */
function mac() {
  const sent: QueuedInput[] = [];
  const replies: { resolve: (focus: PreviewFocus | null) => void; reject: (error: Error) => void }[] = [];
  const send = (item: QueuedInput) => {
    sent.push(item);
    return new Promise<{ focus: PreviewFocus | null }>((resolve, reject) => replies.push({ resolve: (focus) => resolve({ focus }), reject }));
  };
  const answer = async (focus: PreviewFocus | null = null) => {
    replies.shift()!.resolve(focus);
    await vi.advanceTimersByTimeAsync(0);
  };
  const refuse = async (message: string) => {
    replies.shift()!.reject(new Error(message));
    await vi.advanceTimersByTimeAsync(0);
  };
  return { sent, send, answer, refuse };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function queued() {
  const fake = mac();
  const focus = vi.fn();
  const refused = vi.fn();
  const queue = new InputQueue({ send: fake.send, onFocus: focus, onRefused: refused });
  return { ...fake, queue, focus, refused };
}

it("sends one input at a time, in the order they came, and hands on the Mac's focus", async () => {
  const { queue, sent, answer, focus } = queued();
  queue.push(target, { kind: "tap", x: 10, y: 10, count: 1 });
  queue.push(target, { kind: "text", text: "a" });
  expect(sent.map((item) => item.input.kind)).toEqual(["tap"]);
  const field = { kind: "text", keyboard: "default", enter: "default", secure: false, multiline: false } as const;
  await answer(field);
  expect(focus).toHaveBeenLastCalledWith(field, { kind: "tap", x: 10, y: 10, count: 1 });
  expect(sent.map((item) => item.input.kind)).toEqual(["tap", "text"]);
});

it("merges a drag's scrolls while one is out, at the newest point, and paces them 50 ms apart", async () => {
  const { queue, sent, answer } = queued();
  queue.push(target, scroll(10));
  queue.push(target, scroll(20, 400));
  queue.push(target, scroll(30, 410));
  await answer();
  expect(sent).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(50);
  expect(sent.map((item) => item.input)).toEqual([scroll(10), scroll(50, 410)]);
});

it("merges text and Backspaces typed while one is out", async () => {
  const { queue, sent, answer } = queued();
  queue.push(target, { kind: "text", text: "He" });
  queue.push(target, { kind: "text", text: "ll" });
  queue.push(target, { kind: "text", text: "o" });
  queue.push(target, { kind: "key", key: "Backspace", count: 1 });
  queue.push(target, { kind: "key", key: "Backspace", count: 2 });
  queue.push(target, { kind: "key", key: "Enter", count: 1 });
  await answer();
  await answer();
  await answer();
  expect(sent.map((item) => item.input)).toEqual([
    { kind: "text", text: "He" },
    { kind: "text", text: "llo" },
    { kind: "key", key: "Backspace", count: 3 },
    { kind: "key", key: "Enter", count: 1 },
  ]);
});

it("never merges inputs for different panes, nor points from frames of different sizes", async () => {
  const { queue, sent, answer } = queued();
  queue.push(target, { kind: "tap", x: 1, y: 1, count: 1 });
  queue.push(target, scroll(10));
  queue.push(other, scroll(20));
  await answer();
  await vi.advanceTimersByTimeAsync(50);
  await answer();
  await vi.advanceTimersByTimeAsync(50);
  expect(sent.map((item) => [item.target.pane, item.input.kind])).toEqual([
    [target.pane, "tap"],
    [target.pane, "scroll"],
    [other.pane, "scroll"],
  ]);
  queue.push(target, { kind: "tap", x: 1, y: 1, count: 1 });
  queue.push(target, scroll(10));
  queue.push({ ...target, frame: { width: 1572, height: 1132 } }, scroll(20));
  await answer();
  await answer();
  await vi.advanceTimersByTimeAsync(50);
  await answer();
  await vi.advanceTimersByTimeAsync(50);
  expect(sent.slice(3).map((item) => [item.target.frame.width, item.input.kind])).toEqual([
    [786, "tap"],
    [786, "scroll"],
    [1572, "scroll"],
  ]);
});

it("drops what waits once the Mac refuses one, and says why, unless the page only changed", async () => {
  const { queue, sent, refuse, refused, focus } = queued();
  queue.push(target, scroll(10));
  queue.push(target, scroll(10));
  await refuse("The page changed.");
  await vi.advanceTimersByTimeAsync(100);
  expect(sent).toHaveLength(1);
  expect(refused).toHaveBeenCalledExactlyOnceWith("The page changed.", false);
  expect(focus).not.toHaveBeenCalled();
  queue.push(target, { kind: "tap", x: 1, y: 1, count: 1 });
  queue.push(target, { kind: "tap", x: 2, y: 2, count: 1 });
  await refuse("The agent is using this page.");
  expect(refused).toHaveBeenLastCalledWith("The agent is using this page.", true);
  expect(sent).toHaveLength(2);
});

it("lets go of everything when cleared, and sends nothing more", async () => {
  const { queue, sent, answer } = queued();
  queue.push(target, { kind: "tap", x: 1, y: 1, count: 1 });
  queue.push(target, { kind: "tap", x: 2, y: 2, count: 1 });
  queue.clear();
  await answer();
  await vi.advanceTimersByTimeAsync(100);
  expect(sent).toHaveLength(1);
});
