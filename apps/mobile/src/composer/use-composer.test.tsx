// @vitest-environment jsdom
import type { RpcMethod } from "@openorc/protocol";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { FakeMac } from "../test-fixtures/fake-mac";
import { felt } from "../test-fixtures/haptics";
import { KEYBOARD_LEFTOVER_MS } from "./keyboard-leftover";
import { useComposer, type ComposerInput } from "./use-composer";

/** A Mac whose `runs.start` answers when the test says, recording each start. */
const mac = vi.hoisted(() => ({ phone: null as FakeMac | null, starts: [] as { text: string; done: (value: unknown) => void; fail: (error: Error) => void }[] }));

vi.mock("../client", async () => {
  const { fakeMac } = await import("../test-fixtures/fake-mac");
  mac.phone = fakeMac((method: RpcMethod, params) =>
    method === "runs.start" ? new Promise((done, fail) => mac.starts.push({ text: (params as { prompt: string }).prompt, done, fail })) : Promise.resolve(null),
  );
  return mac.phone.module;
});
vi.mock("./use-image-attach", () => ({ useImageAttach: () => ({ uploading: 0, chooseImages: () => undefined }) }));

const input = (disabledReason: string | null = null): ComposerInput => ({
  threadId: "t1",
  request: {
    target: { kind: "thread", threadId: "t1" },
    working: false,
    live: false,
    activeRun: undefined,
    agentsUsed: [],
    choice: { agent: "codex", model: "gpt", effort: null },
    mode: "act",
    permission: "trusted",
    permissionReady: true,
    compacting: false,
    waitForSave: () => Promise.resolve(),
  },
  live: null,
  working: false,
  canSteer: false,
  disabledReason,
  onSent: () => undefined,
});

/** A moment passes, as it does before a person types again after Send. */
const aMomentLater = () => vi.setSystemTime(Date.now() + 1_000);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  mac.starts.length = 0;
  felt.length = 0;
  mac.phone!.saved.clear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("empties the prompt as it sends, so what is written during the send goes once, as the next message", async () => {
  const composer = renderHook(() => useComposer(input()), { wrapper: mac.phone!.wrapper });
  act(() => composer.result.current.setText("Run the tests"));
  act(() => composer.result.current.primary());
  await waitFor(() => expect(mac.starts).toHaveLength(1));
  aMomentLater();
  act(() => composer.result.current.setText(`${composer.result.current.draft.text}and the lint`));
  await act(async () => mac.starts[0]!.done({ id: "r1", threadId: "t1" }));
  await waitFor(() => expect(composer.result.current.sending).toBe(false));
  expect(composer.result.current.draft.text).toBe("and the lint");
  act(() => composer.result.current.primary());
  await waitFor(() => expect(mac.starts).toHaveLength(2));
  expect(mac.starts.map((start) => start.text)).toEqual(["Run the tests", "and the lint"]);
  expect(felt).toEqual(["success"]);
});

it("keeps out the autocorrection iOS lands in the emptied prompt as it sends, but not what is typed next", async () => {
  const composer = renderHook(() => useComposer(input()), { wrapper: mac.phone!.wrapper });
  act(() => composer.result.current.setText("Wiht"));
  act(() => composer.result.current.primary());
  // iOS had "With" pending for the last word, and puts it in the field the send just emptied, at once.
  act(() => composer.result.current.setText("With"));
  expect(composer.result.current.draft.text).toBe("");
  act(() => composer.result.current.setText("a"));
  expect(composer.result.current.draft.text).toBe("a");
  await waitFor(() => expect(mac.starts).toHaveLength(1));
  expect(mac.starts[0]!.text).toBe("Wiht");
});

it("takes a word the reader puts in a moment after the send, such as a suggestion", () => {
  const composer = renderHook(() => useComposer(input()), { wrapper: mac.phone!.wrapper });
  act(() => composer.result.current.setText("Ship it"));
  act(() => composer.result.current.primary());
  vi.setSystemTime(Date.now() + KEYBOARD_LEFTOVER_MS);
  act(() => composer.result.current.setText("Thanks"));
  expect(composer.result.current.draft.text).toBe("Thanks");
});

it("puts back what a failed send took, ahead of anything written since, and says why", async () => {
  const composer = renderHook(() => useComposer(input()), { wrapper: mac.phone!.wrapper });
  act(() => composer.result.current.setText("Run the tests"));
  act(() => composer.result.current.primary());
  await waitFor(() => expect(mac.starts).toHaveLength(1));
  aMomentLater();
  act(() => composer.result.current.setText("and the lint"));
  await act(async () => mac.starts[0]!.fail(new Error("The Mac went away.")));
  await waitFor(() => expect(composer.result.current.sending).toBe(false));
  expect(composer.result.current.draft.text).toBe("Run the tests\nand the lint");
  expect(composer.result.current.error).toBe("The Mac went away.");
  expect(felt).toEqual(["error"]);
});

it("sends once for two quick taps, and keeps no saved draft of what went", async () => {
  const composer = renderHook(() => useComposer(input()), { wrapper: mac.phone!.wrapper });
  act(() => composer.result.current.setText("Ship it"));
  act(() => {
    composer.result.current.primary();
    composer.result.current.primary();
  });
  await waitFor(() => expect(mac.starts).toHaveLength(1));
  await act(async () => mac.starts[0]!.done({ id: "r1", threadId: "t1" }));
  await waitFor(() => expect(composer.result.current.draft.text).toBe(""));
  expect(mac.starts.map((start) => start.text)).toEqual(["Ship it"]);
  expect(mac.phone!.saved.get("draft.mac-1.t1")).toBeUndefined();
});

it("saves a draft change that lands after the reader left the thread", () => {
  const composer = renderHook(() => useComposer(input()), { wrapper: mac.phone!.wrapper });
  const setText = composer.result.current.setText;
  act(() => setText("Written"));
  composer.unmount();
  setText("Written while");
  setText("Written while leaving");
  expect(JSON.parse(mac.phone!.saved.get("draft.mac-1.t1")!)).toMatchObject({ text: "Written while leaving" });
});

it("says why Send is dim only when the dim pill is tapped, with a warning tap", () => {
  const composer = renderHook(({ reason }) => useComposer(input(reason)), { wrapper: mac.phone!.wrapper, initialProps: { reason: "Loading history…" as string | null } });
  act(() => composer.result.current.setText("Hello"));
  expect(composer.result.current.dimReason).toBeNull();
  act(() => composer.result.current.explainDim());
  expect(composer.result.current.dimReason).toBe("Loading history…");
  expect(felt).toEqual(["warning"]);
  composer.rerender({ reason: null });
  expect(composer.result.current.dimReason).toBeNull();
  expect(mac.starts).toHaveLength(0);
});
