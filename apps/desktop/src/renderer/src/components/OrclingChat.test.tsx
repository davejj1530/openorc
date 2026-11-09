import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Block } from "@openorc/client";
import { defaultOrclingLook, type MessageReaction, type Orcling } from "@openorc/protocol";

const { reactions, reacted } = vi.hoisted(() => ({ reactions: [] as MessageReaction[], reacted: [] as unknown[] }));
vi.mock("../lib/client", async (original) => ({
  ...(await original<object>()),
  useRpc: (method: string) => ({ data: method === "orclings.reactions" ? reactions : undefined }),
  useRpcMutation: () => ({ mutate: (params: unknown) => reacted.push(params) }),
}));
vi.mock("./ThreadImages", () => ({ ThreadRichText: ({ children }: { children: string }) => <p>{children}</p> }));
vi.mock("./OrclingAvatar", () => ({ OrclingAvatar: () => <span data-testid="face" /> }));
vi.mock("./UserMessage", () => ({
  UserMessage: ({ text, badge }: { text: string; badge?: React.ReactNode }) => (
    <div data-testid="mine">
      {text}
      {badge}
    </div>
  ),
}));

import { OrclingChat } from "./OrclingChat";

// jsdom has no PointerEvent, so pointer events would arrive without coordinates.
globalThis.PointerEvent ??= MouseEvent as unknown as typeof PointerEvent;

afterEach(() => {
  cleanup();
  reactions.length = 0;
  reacted.length = 0;
  vi.useRealTimers();
});

const pip: Orcling = {
  id: "pip",
  name: "Pip",
  look: defaultOrclingLook,
  settings: { agent: "codex", model: "fixture", effort: null, fastMode: false },
  permission: "allow",
  claudeAccountId: "claude-cli",
  threadId: "home",
  wakes: [],
  createdAt: 1,
  updatedAt: 1,
};
const said = (id: string, role: "user" | "assistant", text: string, at: number): Block => ({ id, kind: "message", role, text, streaming: false, at, runId: "run" });
const bubbles = () => [...document.querySelectorAll(".orcling-bubble:not(.orcling-typing)")].map((el) => el.textContent);

it("shows history as one bubble per paragraph, with tapbacks both ways, and the person reacts to one bubble", () => {
  reactions.push({ runId: "run", messageId: "u1", part: 0, orclingId: "pip", reaction: "haha", at: 3 });
  render(<OrclingChat orcling={pip} blocks={[said("u1", "user", "lol", 1), said("a1", "assistant", "found it.\n\nthe cache key", 2)]} live={false} card={() => null} />);
  expect(bubbles()).toEqual(["found it.", "the cache key"]);
  expect(screen.getByTestId("mine").textContent).toBe("lol😂");
  expect(screen.queryByRole("status", { name: "Typing" })).toBeNull();

  const second = document.querySelectorAll(".orcling-bubble-row")[1]!;
  fireEvent.click(second.querySelector('[aria-label="heart"]')!);
  expect(reacted).toEqual([{ threadId: "home", runId: "run", messageId: "a1", part: 1, reaction: "heart" }]);
});

it("types while a turn runs, and lets a message that arrives while watching land a bubble at a time", () => {
  vi.useFakeTimers();
  const start = Date.now();
  const { rerender } = render(<OrclingChat orcling={pip} blocks={[said("u1", "user", "hey", start - 1000)]} live card={() => null} />);
  expect(screen.getByRole("status", { name: "Typing" })).toBeTruthy();

  const arriving = said("a1", "assistant", "morning!\n\nthe build went green\n\nnothing waiting on you", start + 10);
  rerender(<OrclingChat orcling={pip} blocks={[said("u1", "user", "hey", start - 1000), arriving]} live={false} card={() => null} />);
  expect(bubbles()).toEqual(["morning!"]);
  expect(screen.getByRole("status", { name: "Typing" })).toBeTruthy();
  act(() => void vi.advanceTimersByTime(2100));
  expect(bubbles()).toEqual(["morning!", "the build went green"]);
  act(() => void vi.advanceTimersByTime(2100));
  expect(bubbles()).toEqual(["morning!", "the build went green", "nothing waiting on you"]);
  expect(screen.queryByRole("status", { name: "Typing" })).toBeNull();
});

it("keeps landing bubbles while the Orcling's hidden work streams on", () => {
  vi.useFakeTimers();
  const start = Date.now();
  const arriving = said("a1", "assistant", "on it\n\nchecking your projects", start + 10);
  const work = (n: number): Block[] => Array.from({ length: n }, (_, i) => ({ id: `tool-${i}`, kind: "tool", name: "orcling_projects", input: {}, done: false }));
  const { rerender } = render(<OrclingChat orcling={pip} blocks={[arriving]} live card={() => null} />);
  expect(bubbles()).toEqual(["on it"]);
  for (let step = 1; step <= 5; step++) {
    act(() => void vi.advanceTimersByTime(500));
    rerender(<OrclingChat orcling={pip} blocks={[arriving, ...work(step)]} live card={() => null} />);
  }
  expect(bubbles()).toEqual(["on it", "checking your projects"]);
});

it("shows the person's tapback at once and folds the bar away until the pointer comes back", () => {
  render(<OrclingChat orcling={pip} blocks={[said("a1", "assistant", "found it.", 2)]} live={false} card={() => null} />);
  const row = document.querySelector(".orcling-bubble-row")!;
  fireEvent.click(row.querySelector('[aria-label="haha"]')!, { clientX: 100, clientY: 100 });
  expect(row.querySelector(".orcling-reaction")?.textContent).toBe("😂");
  expect(row.getAttribute("data-picked")).toBe("true");
  // No other bubble offers its bar until the pointer really moves.
  const chat = document.querySelector(".orcling-chat")!;
  expect(chat.getAttribute("data-hushed")).toBe("true");
  fireEvent.pointerMove(chat, { clientX: 102, clientY: 101 });
  expect(chat.getAttribute("data-hushed")).toBe("true");
  fireEvent.pointerMove(chat, { clientX: 130, clientY: 100 });
  expect(chat.getAttribute("data-hushed")).toBeNull();
  fireEvent.pointerLeave(row);
  expect(row.getAttribute("data-picked")).toBe("true");
  fireEvent.pointerEnter(row);
  expect(row.getAttribute("data-picked")).toBeNull();
});

it("types back as soon as a message is on its way", () => {
  const pending: Block = { id: "user-1", kind: "message", role: "user", text: "you there?", streaming: false, at: 5, pending: true };
  render(<OrclingChat orcling={pip} blocks={[said("a1", "assistant", "hi", 2), pending]} live={false} card={() => null} />);
  expect(screen.getByTestId("mine").textContent).toBe("you there?");
  expect(screen.getByRole("status", { name: "Typing" })).toBeTruthy();
});
