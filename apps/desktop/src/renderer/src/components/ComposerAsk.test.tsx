import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WaitingAsk } from "@openorc/client";
import { core } from "../lib/rpc";
import { Composer } from "./Composer";
import { messageOf, type } from "./composer-editor/testing";

vi.mock("../lib/rpc", () => ({ core: { call: vi.fn(async () => null), onReady: vi.fn(), onPush: () => () => {} } }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** The asks of the played cases (play/asks-page.js), as an agent sends them. */
const ASKS = {
  export: {
    questions: [
      {
        id: "land",
        question: "Where should the export land?",
        options: [
          { label: "Downloads folder", description: "Saved to ~/Downloads with the date in its name." },
          { label: "Ask each time", description: "A save sheet opens so the file can go anywhere." },
        ],
        isOther: true,
      },
    ],
  },
  runner: {
    questions: [
      {
        id: "runner",
        question: "Which runner should the tests use?",
        options: [
          { label: "Vitest", description: "The same as the rest of the repository." },
          { label: "Node's own runner", description: "No dependency, slower to watch." },
        ],
      },
    ],
  },
};
type AskName = keyof typeof ASKS;

const waiting = (name: AskName, id: string = name): WaitingAsk => ({ runId: "run", block: { id: `approval-${id}`, kind: "approval", approvalId: id, approvalKind: "user_input", input: ASKS[name] } });

/** A conversation's composer mid-turn, its asks arriving as the agent sends them, with what reached the agent. */
function mount({ draft = "" }: { draft?: string } = {}) {
  const onSubmit = vi.fn(async (_text: string, _files: string[], _now: boolean) => {});
  const outside: { setAsks: (update: (asks: WaitingAsk[]) => WaitingAsk[]) => void } = { setAsks: () => {} };
  function Host() {
    const [value, setValue] = useState(draft);
    const [asks, setAsks] = useState<WaitingAsk[]>([]);
    outside.setAsks = setAsks;
    return (
      <>
        <button type="button">Outside</button>
        <Composer
          value={value}
          onChange={setValue}
          onSubmit={onSubmit}
          placeholder="Message"
          model={{ agent: "claude", model: "opus", effort: null }}
          onModel={() => {}}
          mode="act"
          onMode={() => {}}
          permission="review"
          onPermission={() => {}}
          location={{ label: null, branch: null }}
          live={{ runId: "run", working: true }}
          queueing
          liveByDefault
          steerable
          mentions={[{ key: "rini", name: "Rini", hint: "Opus 5.5" }]}
          asks={asks}
        />
      </>
    );
  }
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Host />
    </QueryClientProvider>,
  );
  const field = screen.getByRole("textbox", { name: "Message" });
  const dock = () => document.querySelector<HTMLElement>(".composer-ask");
  return {
    field,
    dock,
    arrive: (name: AskName, id?: string) => act(() => outside.setAsks((asks) => [...asks, waiting(name, id)])),
    answer: (id: string) => act(() => outside.setAsks((asks) => asks.filter((ask) => ask.block.approvalId !== id))),
    /** Presses a key wherever the keyboard is, as the person would. */
    key: (key: string, init: KeyboardEventInit = {}) => act(() => void fireEvent.keyDown(document.activeElement ?? document.body, { key, ...init })),
    answered: () =>
      vi
        .mocked(core.call)
        .mock.calls.filter(([method]) => method === "approvals.resolve")
        .map(([, params]) => params),
    sent: () => onSubmit.mock.calls.map(([text, , now]) => `${now ? "now" : "queue"}: ${text}`),
    where: () => document.activeElement?.getAttribute("data-ask-control") ?? (document.activeElement === field ? "field" : document.activeElement?.textContent),
  };
}

const QUESTIONS: AskName[] = ["export", "runner"];

describe.each(QUESTIONS)("a docked %s question, played by keys nobody meant for it", (name) => {
  it("answers nothing when Enter is pressed five times in the empty field, the first two as it arrives", () => {
    const c = mount();
    c.field.focus();
    c.key("Enter");
    c.arrive(name);
    c.key("Enter");
    for (let i = 0; i < 3; i++) c.key("Enter");
    expect([c.answered(), c.sent(), c.where()]).toEqual([[], [], "field"]);
  });

  it("answers nothing when Enter is held down while it arrives", () => {
    const c = mount();
    c.field.focus();
    c.key("Enter");
    c.arrive(name);
    for (let i = 0; i < 20; i++) c.key("Enter", { repeat: true });
    expect([c.answered(), c.sent(), c.where()]).toEqual([[], [], "field"]);
  });

  it("puts the keyboard on the question, not a choice, at arrow up, so Enter then answers nothing", () => {
    const c = mount();
    c.arrive(name);
    c.field.focus();
    c.key("ArrowUp");
    c.key("Enter");
    expect([c.answered(), c.where()]).toEqual([[], "head"]);
  });

  it("enters at the question by Shift and Tab, where Enter and Space answer nothing", () => {
    const c = mount();
    c.arrive(name);
    c.field.focus();
    c.key("Tab", { shiftKey: true });
    c.key("Enter");
    c.key(" ");
    expect([c.answered(), c.where()]).toEqual([[], "head"]);
  });

  it("queues words typed in the field as a message and never answers with them", async () => {
    const c = mount();
    c.arrive(name);
    type(c.field, "use the downloads folder");
    c.key("Enter");
    await waitFor(() => expect(c.sent()).toEqual(["queue: use the downloads folder"]));
    expect(c.answered()).toEqual([]);
  });

  it("keeps the caret and the words when it arrives mid-sentence, and queues them at Enter", async () => {
    const c = mount();
    type(c.field, "yes go");
    c.arrive(name);
    expect(c.where()).toBe("field");
    type(c.field, "yes go ahead");
    c.key("Enter");
    await waitFor(() => expect(c.sent()).toEqual(["queue: yes go ahead"]));
    expect(c.answered()).toEqual([]);
  });

  it("lets Enter pick from the open @ list and Escape only close it", () => {
    const c = mount();
    c.arrive(name);
    type(c.field, "@Ri");
    c.key("Enter");
    expect(messageOf(c.field)).toBe("@Rini ");
    type(c.field, "@Rini @R");
    c.key("Escape");
    c.key("Escape");
    expect([c.answered(), c.sent(), c.where(), messageOf(c.field)]).toEqual([[], [], "field", "@Rini @R"]);
  });

  it("answers nothing when the keyboard is outside the composer", () => {
    const c = mount();
    c.arrive(name);
    screen.getByRole("button", { name: "Outside" }).focus();
    c.key("Enter");
    expect(c.answered()).toEqual([]);
  });
});

describe("a docked question, answered on purpose", () => {
  it("answers a single choice by arrow up, arrow down and Enter", () => {
    const c = mount();
    c.arrive("runner");
    c.field.focus();
    c.key("ArrowUp");
    c.key("ArrowDown");
    expect(c.where()).toBe("choice");
    c.key("Enter");
    expect(c.answered()).toEqual([{ runId: "run", approvalId: "runner", decision: "allow", answers: { runner: ["Vitest"] } }]);
  });

  it("answers at a press on a choice", () => {
    const c = mount();
    c.arrive("export");
    fireEvent.click(screen.getByRole("button", { name: /Ask each time/ }));
    expect(c.answered()).toEqual([{ runId: "run", approvalId: "export", decision: "allow", answers: { land: ["Ask each time"] } }]);
  });

  it("returns to the field at Escape on a choice, answering nothing", () => {
    const c = mount();
    c.arrive("runner");
    c.field.focus();
    c.key("ArrowUp");
    c.key("ArrowDown");
    c.key("Escape");
    expect([c.answered(), c.where()]).toEqual([[], "field"]);
  });

  it("sends a letter typed on a choice back to the field, answering nothing", () => {
    const c = mount();
    c.arrive("runner");
    c.field.focus();
    c.key("ArrowUp");
    c.key("ArrowDown");
    c.key("a");
    expect([c.answered(), c.where()]).toEqual([[], "field"]);
  });

  it("answers in the person's own words from the ask's line, leaving the field's draft alone", () => {
    const c = mount({ draft: "Also add the date range" });
    c.arrive("export");
    const line = screen.getByRole("textbox", { name: "Something else: Where should the export land?" });
    act(() => line.focus());
    fireEvent.change(line, { target: { value: "Downloads, renamed first" } });
    c.key("Enter");
    expect(c.answered()).toEqual([{ runId: "run", approvalId: "export", decision: "allow", answers: { land: ["Downloads, renamed first"] } }]);
    expect([c.sent(), messageOf(c.field)]).toEqual([[], "Also add the date range"]);
  });

  it("offers a line for words only where the agent takes them", () => {
    const c = mount();
    c.arrive("runner");
    expect(within(c.dock()!).queryByRole("textbox")).toBeNull();
  });

  it("declines by its quiet word, last in the keyboard's walk", () => {
    const c = mount();
    c.arrive("runner");
    c.field.focus();
    c.key("ArrowUp");
    c.key("ArrowDown");
    c.key("ArrowDown");
    c.key("ArrowDown");
    expect(c.where()).toBe("action");
    c.key("Enter");
    expect(c.answered()).toEqual([{ runId: "run", approvalId: "runner", decision: "deny" }]);
  });

  it("gives the keyboard back to the field once answered", () => {
    const c = mount();
    c.arrive("runner");
    c.field.focus();
    c.key("ArrowUp");
    c.key("ArrowDown");
    c.key("Enter");
    c.answer("runner");
    expect([c.dock(), c.where()]).toEqual([null, "field"]);
  });
});

describe("the send cluster while an ask waits", () => {
  it("stands Stop alone as a white key with nothing typed, and queues a typed message with Send now dimmed", () => {
    const c = mount();
    c.arrive("runner");
    expect([document.querySelector(".composer-send"), screen.getByRole("button", { name: "Stop" }).className]).toEqual([null, "composer-stop"]);
    type(c.field, "after this");
    expect(screen.getByRole("button", { name: "Send now" }).getAttribute("data-tip")).toBe("Claude is waiting for your answer.");
    expect(screen.getByRole("button", { name: "Send now" }).hasAttribute("disabled")).toBe(true);
    c.key("Enter", { metaKey: true });
    expect(c.sent()).toEqual([]);
  });
});
