// @vitest-environment jsdom
import { defaultOrclingLook, type OrclingChatSummary, type ThreadSummary } from "@openorc/protocol";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { flatStyle, nativeProps, reduceMotion } from "../test-fixtures/react-native";

const focus = vi.hoisted(() => ({ focused: true }));
vi.mock("expo-router", () => ({ router: { push: vi.fn() }, useIsFocused: () => focus.focused }));
vi.mock("./OrclingFaces", () => ({ useOpenChat: () => () => undefined }));
vi.mock("../client", () => ({ useRpc: () => ({ data: undefined }) }));

const { faceMotion, OrclingMotion, seedOf } = await import("./OrclingMotion");
const { moodOf, OrclingList } = await import("./OrclingList");

afterEach(() => {
  cleanup();
  focus.focused = true;
  reduceMotion.set(false);
});

const thread = (activity: ThreadSummary["activity"], unread: boolean) => ({ activity, unread, session: { status: "idle" }, backgroundCommands: [] }) as unknown as ThreadSummary;
const chat = (name: string, extra: Partial<OrclingChatSummary> = {}): OrclingChatSummary => ({
  id: name.toLowerCase(),
  name,
  look: defaultOrclingLook,
  threadId: `home-${name.toLowerCase()}`,
  thread: thread("idle", false),
  last: null,
  ...extra,
});

it("hops an Orcling that works, nudges one that wants the person, and lets the rest breathe", () => {
  expect(moodOf(chat("Rex", { thread: thread("running", false) }))).toBe("working");
  expect(moodOf(chat("Pip", { thread: thread("idle", true) }))).toBe("asking");
  expect(moodOf(chat("Sol", { thread: thread("waiting", false) }))).toBe("asking");
  expect(moodOf(chat("Ivy"))).toBe("rest");
});

it("gives each Orcling its own pace, the same every time, and holds every part together", () => {
  expect(seedOf("pip")).toBe(seedOf("pip"));
  const pip = faceMotion("rest", 60, seedOf("pip"), false);
  const rex = faceMotion("rest", 60, seedOf("rex"), false);
  expect(pip.eyes.animationDuration).not.toBe(rex.eyes.animationDuration);
  // Glasses glance with the eyes, so they keep the eyes' pace and start.
  expect(pip.glasses.animationDuration).toBe(pip.eyes.animationDuration);
  expect(pip.glasses.animationDelay).toBe(pip.eyes.animationDelay);
  expect(faceMotion("working", 60, 1, false).body.animationDuration).toBe("1.1s");
  const held = faceMotion("rest", 60, 1, true);
  expect([held.body, held.eyes, held.glasses].map((part) => part.animationPlayState)).toEqual(["paused", "paused", "paused"]);
});

it("shows the still face under Reduce Motion", async () => {
  render(<OrclingMotion look={defaultOrclingLook} size={60} seed={1} mood="rest" paused={false} />);
  expect(document.body.innerHTML).not.toBe("");
  await act(async () => reduceMotion.set(true));
  // The still face draws one picture where the moving one stacks its parts.
  expect(document.body.querySelectorAll("div").length).toBeLessThan(3);
});

/** How the faces on screen play: running or paused, once per moving part. */
const playing = () => [...new Set(Array.from(document.querySelectorAll("div")).map((element) => flatStyle(nativeProps.get(element)?.style).animationPlayState))].filter(Boolean);

it("reads each preview as plain text and holds the faces while the list is out of sight", () => {
  const chats = [chat("Pip", { thread: thread("idle", true), last: { id: "m1", role: "assistant", text: "- **Deleted:** `tdd` and `docs`", createdAt: Date.now() } })];
  const view = render(<OrclingList chats={chats} top={0} bottom={0} />);
  expect(screen.getByRole("button", { name: "Pip, Unread, Deleted: tdd and docs" })).toBeTruthy();
  expect(screen.getByText("Deleted: tdd and docs")).toBeTruthy();
  expect(playing()).toEqual(["running"]);
  view.rerender(<OrclingList chats={chats} top={0} bottom={0} shown={false} />);
  expect(playing()).toEqual(["paused"]);
  // Shown again, but under a screen pushed over Home.
  focus.focused = false;
  view.rerender(<OrclingList chats={chats} top={0} bottom={0} />);
  expect(playing()).toEqual(["paused"]);
});
