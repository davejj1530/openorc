import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { felt } from "../test-fixtures/haptics";
import { announced } from "../test-fixtures/react-native";
import { offerCode, openPairing, retryPairing, scanCode, usePairing } from "./pairing";
import type { PairResult } from "../connection/manager";

const mac = vi.hoisted(() => ({ answers: [] as PairResult[], tried: [] as string[] }));
vi.mock("../client", () => ({
  link: {
    pair: (url: string) => {
      mac.tried.push(url);
      return Promise.resolve(mac.answers.shift() ?? { ok: true, mac: { id: "m", name: "Studio" } });
    },
  },
}));

const unreachable: PairResult = { ok: false, message: "Could not reach your Mac. Check that this phone is on its network or tailnet.", spent: false };
const used: PairResult = { ok: false, message: "This code was already used or has expired. Show a new one on your Mac.", spent: true };
let n = 0;
const code = () => `openorc://pair#v1.code-${++n}`;

beforeEach(() => {
  vi.useFakeTimers();
  mac.answers.length = 0;
  mac.tried.length = 0;
  felt.length = 0;
  announced.length = 0;
  usePairing.setState({ pairing: { kind: "idle" } });
});
afterEach(() => vi.useRealTimers());

it("tries a scanned code once, however long the camera keeps seeing it, and again from Try again", async () => {
  const url = code();
  mac.answers.push(unreachable);
  expect(await scanCode(url)).toBe(false);
  expect(usePairing.getState().pairing).toMatchObject({ kind: "failed", spent: false });
  for (let second = 0; second < 5; second++) {
    vi.advanceTimersByTime(1_000);
    expect(await scanCode(url)).toBe(false);
  }
  expect(mac.tried).toEqual([url]);
  expect(felt).toEqual(["selection", "error"]);
  expect(await retryPairing()).toBe(true);
  expect(mac.tried).toEqual([url, url]);
});

it("starts each visit to the Pair screen fresh: no old failure, and the camera may try the code again", async () => {
  const url = code();
  mac.answers.push(unreachable);
  await scanCode(url);
  openPairing();
  expect(usePairing.getState().pairing).toEqual({ kind: "idle" });
  expect(await scanCode(url)).toBe(true);
  expect(mac.tried).toEqual([url, url]);
});

it("takes a pasted link again after it failed, since pasting is asked for", async () => {
  const url = code();
  mac.answers.push(unreachable);
  await offerCode(url);
  expect(await offerCode(url)).toBe(true);
  expect(mac.tried).toEqual([url, url]);
});

it("never sends a code the Mac refused again, but takes a new one", async () => {
  const refused = code();
  mac.answers.push(used);
  await offerCode(refused);
  vi.advanceTimersByTime(60_000);
  expect(await offerCode(refused)).toBe(false);
  expect(await retryPairing()).toBe(false);
  const fresh = code();
  expect(await offerCode(fresh)).toBe(true);
  expect(mac.tried).toEqual([refused, fresh]);
});

it("leaves a code that paired alone on later visits, as the link the camera opened the app with stays the app's opening link", async () => {
  const opened = code();
  expect(await offerCode(opened)).toBe(true);
  openPairing();
  expect(await offerCode(opened)).toBe(false);
  expect(await scanCode(opened)).toBe(false);
  expect(mac.tried).toEqual([opened]);
  expect(usePairing.getState().pairing).toEqual({ kind: "idle" });
  expect(felt).toEqual(["selection", "success"]);
});

it("tries the failed code again from Try again", async () => {
  const url = code();
  mac.answers.push(unreachable);
  await offerCode(url);
  expect(await retryPairing()).toBe(true);
  expect(mac.tried).toEqual([url, url]);
  expect(usePairing.getState().pairing).toEqual({ kind: "idle" });
});

it("taps when a code is read, then confirms or fails, saying each step to VoiceOver", async () => {
  mac.answers.push(unreachable);
  await offerCode(code());
  await offerCode(code());
  expect(felt).toEqual(["selection", "error", "selection", "success"]);
  expect(announced).toEqual(["Pairing…", unreachable.message, "Pairing…", "Paired with Studio"]);
});

it("ignores text that is not a pairing code", async () => {
  expect(await offerCode("https://example.com")).toBe(false);
  expect(mac.tried).toEqual([]);
  expect(felt).toEqual([]);
});
