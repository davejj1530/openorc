// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { finishedTurn, type runStore } from "../thread/test-fixtures/run-store";
import { useCoverHome } from "./home-cover";
import { useRowRun } from "./row-run";

/** The run store Home's rows read, and the open thread's screen as the stack tells it how it moves. */
const home = vi.hoisted(() => {
  const listeners = new Map<string, Set<(event: { data?: { closing: boolean } }) => void>>();
  return {
    store: null as ReturnType<typeof runStore> | null,
    navigation: {
      addListener(type: string, listener: (event: { data?: { closing: boolean } }) => void) {
        listeners.set(type, (listeners.get(type) ?? new Set()).add(listener));
        return () => void listeners.get(type)!.delete(listener);
      },
    },
    emit: (type: string, data?: { closing: boolean }) => listeners.get(type)?.forEach((listener) => listener({ data })),
  };
});

// A sheet is open over Home throughout, so Home is never the focused screen.
vi.mock("expo-router", () => ({ useNavigation: () => home.navigation, useIsFocused: () => false }));
vi.mock("../client", async () => {
  const { runStore } = await import("../thread/test-fixtures/run-store");
  home.store = runStore("interest");
  return { client: home.store.client };
});

afterEach(() => {
  cleanup();
  home.store!.client.runs.reset();
});

/** A Home row on run "r", counting its renders. */
function homeRow() {
  let renders = 0;
  const row = renderHook(() => {
    renders++;
    return useRowRun("r");
  });
  return { last: () => row.result.current?.blocks.at(-1), renders: () => renders };
}

it("follows its run while Home shows, under a sheet too, holds still while a thread hides Home, and catches up as a swipe back starts", () => {
  const { frame } = home.store!;
  frame(...finishedTurn.slice(0, 3));
  const row = homeRow();
  act(() => void frame(finishedTurn[3]!));
  expect(row.last()).toMatchObject({ kind: "tool", id: "ls", done: false });

  // A thread opens over Home.
  const thread = renderHook(() => useCoverHome());
  const hidden = row.renders();
  act(() => void frame(finishedTurn[4]!));
  expect(row.renders()).toBe(hidden);
  expect(row.last()).toMatchObject({ kind: "tool", id: "ls", done: false });

  // The reader swipes back: Home shows as the swipe starts, and the row follows again.
  act(() => home.emit("transitionStart", { closing: true }));
  expect(row.last()).toMatchObject({ kind: "tool", id: "ls", done: true });
  act(() => void frame(finishedTurn[5]!));
  expect(row.last()).toMatchObject({ kind: "message", id: "reply-1" });

  // They turn back, and the thread hides Home again until it closes.
  act(() => home.emit("gestureCancel"));
  const turnedBack = row.renders();
  act(() => void frame(finishedTurn[6]!));
  expect(row.renders()).toBe(turnedBack);
  thread.unmount();
  expect(row.last()).toMatchObject({ kind: "status" });
});

it("shows the run as it is when it mounts behind a thread, and follows it once Home shows", () => {
  const { frame } = home.store!;
  frame(...finishedTurn.slice(0, 4));
  const thread = renderHook(() => useCoverHome());
  const row = homeRow();
  expect(row.last()).toMatchObject({ kind: "tool", id: "ls", done: false });
  act(() => void frame(finishedTurn[4]!));
  thread.unmount();
  expect(row.last()).toMatchObject({ kind: "tool", id: "ls", done: true });
  act(() => void frame(finishedTurn[5]!));
  expect(row.last()).toMatchObject({ kind: "message", id: "reply-1" });
});

it("keeps a run nobody else holds streaming to the phone while its row shows", () => {
  const { interest } = home.store!;
  const row = renderHook(() => useRowRun("other"));
  expect([...interest()]).toContain("other");
  row.unmount();
  expect([...interest()]).not.toContain("other");
});
