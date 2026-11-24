import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDictation, type Recognizer, type RecognizerEvents } from "./dictation";

/** A recognizer that hears what the test says. */
function fakeRecognizer({ microphone = true, language = "en-US" as string | null } = {}) {
  let events: RecognizerEvents | null = null;
  const calls: string[] = [];
  const recognizer: Recognizer = {
    microphone: async () => microphone,
    language: async () => language,
    start: (locale, heard) => {
      calls.push(`start ${locale}`);
      events = heard;
    },
    stop: () => void calls.push("stop"),
    abort: () => void calls.push("abort"),
  };
  return { recognizer, calls, hears: () => events! };
}

/** A draft that records what is spoken into it. */
function draft() {
  const said: string[] = [];
  const ended: boolean[] = [];
  return { said, ended, speak: () => ({ say: (words: string) => void said.push(words), end: (keep: boolean) => void ended.push(keep) }) };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("writes the words into the draft as they are heard, and keeps them when the recording is finished", async () => {
  const { recognizer, calls, hears } = fakeRecognizer();
  const dictation = createDictation(recognizer, () => 1000);
  const page = draft();
  await dictation.start("thread", page.speak);
  expect(dictation.store.getState().take).toEqual({ owner: "thread", phase: "starting", since: null });
  hears().start();
  expect(dictation.store.getState().take).toEqual({ owner: "thread", phase: "listening", since: 1000 });
  hears().words("open the", false);
  hears().words("Open the composer.", true);
  hears().words(" Then run", false);
  expect(page.said).toEqual(["open the", "Open the composer.", "Open the composer. Then run"]);

  const finished = dictation.finish();
  expect(dictation.store.getState().take?.phase).toBe("finishing");
  expect(calls).toEqual(["start en-US", "stop"]);
  hears().words(" Then run the checks.", true);
  hears().end();
  await expect(finished).resolves.toBe(true);
  expect(page.said.at(-1)).toBe("Open the composer. Then run the checks.");
  expect(page.ended).toEqual([true]);
  expect(dictation.store.getState()).toEqual({ take: null, notice: null });
});

it("takes the words back out when the recording is cancelled, and a waiting send hears it was", async () => {
  const { recognizer, calls, hears } = fakeRecognizer();
  const dictation = createDictation(recognizer);
  const page = draft();
  await dictation.start("thread", page.speak);
  hears().start();
  hears().words("never mind", false);
  const finished = dictation.finish();
  dictation.cancel();
  await expect(finished).resolves.toBe(false);
  expect(page.ended).toEqual([false]);
  expect(calls.at(-1)).toBe("abort");
  // The recognizer's own end, after the cancel, changes nothing.
  hears().end();
  expect(page.ended).toEqual([false]);
});

it("says the microphone was refused, or that the device cannot recognize by itself, and records nothing", async () => {
  const refused = fakeRecognizer({ microphone: false });
  const first = createDictation(refused.recognizer);
  const page = draft();
  await first.start("thread", page.speak);
  expect(first.store.getState()).toEqual({ take: null, notice: { owner: "thread", kind: "microphone" } });
  expect(refused.calls).toEqual([]);

  const without = fakeRecognizer({ language: null });
  const second = createDictation(without.recognizer);
  await second.start("thread", page.speak);
  expect(second.store.getState()).toEqual({ take: null, notice: { owner: "thread", kind: "unavailable" } });
  expect(without.calls).toEqual([]);
  expect(page.said).toEqual([]);
});

it("keeps what was heard when a recording breaks off, and says it stopped", async () => {
  const { recognizer, hears } = fakeRecognizer();
  const dictation = createDictation(recognizer);
  const page = draft();
  await dictation.start("thread", page.speak);
  hears().start();
  hears().words("half a thought", false);
  hears().error("interrupted");
  hears().end();
  expect(page.ended).toEqual([true]);
  expect(dictation.store.getState()).toEqual({ take: null, notice: { owner: "thread", kind: "stopped" } });
});

it("does not wait for last words a recognizer never sends", async () => {
  const { recognizer, calls, hears } = fakeRecognizer();
  const dictation = createDictation(recognizer);
  const page = draft();
  await dictation.start("thread", page.speak);
  hears().start();
  hears().words("said this", false);
  const finished = dictation.finish();
  vi.advanceTimersByTime(2500);
  await expect(finished).resolves.toBe(true);
  expect(page.ended).toEqual([true]);
  expect(calls).toEqual(["start en-US", "stop", "abort"]);
});

it("gives the recording to the composer that asks for it last", async () => {
  const { recognizer, hears } = fakeRecognizer();
  const dictation = createDictation(recognizer);
  const one = draft();
  const two = draft();
  await dictation.start("one", one.speak);
  hears().start();
  hears().words("for the first", false);
  await dictation.start("two", two.speak);
  expect(one.ended).toEqual([false]);
  expect(dictation.store.getState().take?.owner).toBe("two");
});
