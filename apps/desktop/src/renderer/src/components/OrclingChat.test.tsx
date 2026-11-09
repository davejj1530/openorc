import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Block } from "@openorc/client";
import { defaultOrclingLook, type MessageReaction, type Orcling } from "@openorc/protocol";

const { reactions, reacted, rpc } = vi.hoisted(() => ({ reactions: [] as MessageReaction[], reacted: [] as unknown[], rpc: new Map<string, unknown>() }));
vi.mock("../lib/client", async (original) => ({
  ...(await original<object>()),
  useRpc: (method: string) => ({ data: method === "orclings.reactions" ? reactions : rpc.get(method) }),
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

afterEach(() => {
  cleanup();
  reactions.length = 0;
  reacted.length = 0;
  rpc.clear();
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
const home = { threadId: "home", members: [pip], speakers: new Map(), group: false };
const said = (id: string, role: "user" | "assistant", text: string, at: number): Block => ({ id, kind: "message", role, text, streaming: false, at, runId: "run" });
const bubbles = () => [...document.querySelectorAll(".orcling-bubble:not(.orcling-typing)")].map((el) => el.textContent);

it("shows history as one bubble per paragraph, with tapbacks both ways, and the person reacts to one bubble", () => {
  reactions.push({ runId: "run", messageId: "u1", part: 0, orclingId: "pip", reaction: "haha", at: 3 });
  render(<OrclingChat chat={home} blocks={[said("u1", "user", "lol", 1), said("a1", "assistant", "found it.\n\nthe cache key", 2)]} live={false} card={() => null} />);
  expect(bubbles()).toEqual(["found it.", "the cache key"]);
  expect(screen.getByTestId("mine").textContent).toBe("lol😂");
  expect(screen.queryByRole("status", { name: "Typing" })).toBeNull();

  const second = document.querySelectorAll(".orcling-bubble-row")[1]!;
  fireEvent.click(second.querySelector('[aria-label="React"]')!);
  fireEvent.click(second.querySelector('[aria-label="heart"]')!);
  expect(reacted).toEqual([{ threadId: "home", runId: "run", messageId: "a1", part: 1, reaction: "heart" }]);
});

it("types while a turn runs, and lets a message that arrives while watching land a bubble at a time", () => {
  vi.useFakeTimers();
  const start = Date.now();
  const { rerender } = render(<OrclingChat chat={home} blocks={[said("u1", "user", "hey", start - 1000)]} live card={() => null} />);
  expect(screen.getByRole("status", { name: "Typing" })).toBeTruthy();

  const arriving = said("a1", "assistant", "morning!\n\nthe build went green\n\nnothing waiting on you", start + 10);
  rerender(<OrclingChat chat={home} blocks={[said("u1", "user", "hey", start - 1000), arriving]} live={false} card={() => null} />);
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
  const { rerender } = render(<OrclingChat chat={home} blocks={[arriving]} live card={() => null} />);
  expect(bubbles()).toEqual(["on it"]);
  for (let step = 1; step <= 5; step++) {
    act(() => void vi.advanceTimersByTime(500));
    rerender(<OrclingChat chat={home} blocks={[arriving, ...work(step)]} live card={() => null} />);
  }
  expect(bubbles()).toEqual(["on it", "checking your projects"]);
});

it("opens the tapbacks only from the bubble's reaction button and closes them once one is chosen", () => {
  render(<OrclingChat chat={home} blocks={[said("a1", "assistant", "found it.\n\nthe cache key", 2)]} live={false} card={() => null} />);
  const [first, second] = [...document.querySelectorAll(".orcling-bubble-row")];
  const open = (row: Element) => row.getAttribute("data-open") === "true";
  // Pointing at a bubble offers the button and nothing more.
  fireEvent.pointerEnter(first!);
  fireEvent.pointerMove(first!);
  expect([open(first!), open(second!)]).toEqual([false, false]);

  fireEvent.click(first!.querySelector('[aria-label="React"]')!);
  expect([open(first!), open(second!)]).toEqual([true, false]);
  fireEvent.click(first!.querySelector('[aria-label="haha"]')!);
  expect(first!.querySelector(".orcling-reaction")?.textContent).toBe("😂");
  expect(open(first!)).toBe(false);
  // Resting or moving the pointer afterwards never brings them back.
  fireEvent.pointerEnter(first!);
  fireEvent.pointerMove(first!);
  expect([open(first!), open(second!)]).toEqual([false, false]);

  // One open at a time; Escape and a press elsewhere close them.
  fireEvent.click(first!.querySelector('[aria-label="React"]')!);
  fireEvent.click(second!.querySelector('[aria-label="React"]')!);
  expect([open(first!), open(second!)]).toEqual([false, true]);
  fireEvent.keyDown(document, { key: "Escape" });
  expect(open(second!)).toBe(false);
  fireEvent.click(second!.querySelector('[aria-label="React"]')!);
  fireEvent.pointerDown(document.body);
  expect(open(second!)).toBe(false);
});

it("types back as soon as a message is on its way", () => {
  const pending: Block = { id: "user-1", kind: "message", role: "user", text: "you there?", streaming: false, at: 5, pending: true };
  render(<OrclingChat chat={home} blocks={[said("a1", "assistant", "hi", 2), pending]} live={false} card={() => null} />);
  expect(screen.getByTestId("mine").textContent).toBe("you there?");
  expect(screen.getByRole("status", { name: "Typing" })).toBeTruthy();
});

const bo: Orcling = { ...pip, id: "bo", name: "Bo", threadId: "bo-home", look: { ...defaultOrclingLook, bodyColor: "#c46b4d" } };
const names = () => [...document.querySelectorAll(".orcling-run-name")].map((el) => el.textContent);
const runOf = (text: string) => [...document.querySelectorAll<HTMLElement>(".orcling-run")].find((run) => run.textContent?.includes(text));

it("draws a group chat with each Orcling's runs under its own name and tint", () => {
  const said2 = (id: string, runId: string, text: string, at: number): Block => ({ id, kind: "message", role: "assistant", text, streaming: false, at, runId });
  const group = {
    threadId: "group",
    members: [pip, bo],
    speakers: new Map([
      ["run-pip", pip],
      ["run-bo", bo],
    ]),
    group: true,
  };
  render(
    <OrclingChat
      chat={group}
      blocks={[
        { id: "u1", kind: "message", role: "user", text: "morning both", streaming: false, at: 1, runId: "run-pip" },
        said2("a1", "run-pip", "found the flaky test", 2),
        said2("a2", "run-pip", "it was the clock", 3),
        said2("b1", "run-bo", "nice, rerunning CI", 4),
      ]}
      live={false}
      card={() => null}
    />,
  );
  expect(names()).toEqual(["Pip", "Bo"]);
  expect(bubbles()).toEqual(["found the flaky test", "it was the clock", "nice, rerunning CI"]);
  expect(runOf("rerunning")!.style.getPropertyValue("--orcling-tint")).toBe("#c46b4d");
});

it("shows a direct message from another Orcling as that Orcling's, and one this Orcling sent with whom it went to", () => {
  rpc.set("orclings.list", [pip, bo]);
  rpc.set("orclings.origins", [{ messageId: "dm-1", fromOrclingId: "bo", toOrclingId: "pip" }]);
  render(
    <OrclingChat
      chat={home}
      blocks={[
        { id: "dm-1", kind: "message", role: "system", text: "the review is done", streaming: false, at: 1, runId: "run" },
        { id: "tool-1", kind: "tool", name: "mcp__openorc__orcling_message", input: { to: "Bo", text: "thanks, merging now" }, done: true, at: 2, runId: "run" },
      ]}
      live={false}
      card={() => <div data-testid="card" />}
    />,
  );
  expect(screen.queryByTestId("card")).toBeNull();
  expect(names()).toEqual(["Bo", "Pip to Bo"]);
  expect(bubbles()).toEqual(["the review is done", "thanks, merging now"]);
});
