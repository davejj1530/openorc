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
  checks: {
    questions: [
      {
        id: "checks",
        question: "Which checks should run before a merge?",
        options: [{ label: "Type check" }, { label: "Unit tests" }, { label: "The packaged smoke test" }],
        multiSelect: true,
      },
    ],
  },
  three: {
    questions: [
      { id: "land", question: "Where should the export land?", options: [{ label: "Downloads folder" }, { label: "Ask each time" }], isOther: true },
      { id: "format", question: "Which format comes first?", options: [{ label: "CSV" }, { label: "JSON" }] },
      { id: "checks", question: "Which checks should run before a merge?", options: [{ label: "Type check" }, { label: "Unit tests" }, { label: "The packaged smoke test" }], multiSelect: true },
    ],
  },
  build: { command: "pnpm --filter website build" },
  deploy: { command: "vercel deploy --prebuilt --prod" },
  slack: { channel: "#releases", text: "OpenOrc beta 21 is out." },
};
type AskName = keyof typeof ASKS;
const APPROVALS: Partial<Record<AskName, { toolName: string; reason?: string; onceOnly?: boolean }>> = {
  build: { toolName: "Bash" },
  deploy: { toolName: "Bash" },
  slack: { toolName: "slack.post", reason: "Allow Slack to post in #releases?", onceOnly: true },
};

const waiting = (name: AskName, id: string = name): WaitingAsk => ({
  runId: "run",
  block: { id: `approval-${id}`, kind: "approval", approvalId: id, approvalKind: APPROVALS[name] ? "command" : "user_input", input: ASKS[name], ...APPROVALS[name] },
});

/** A conversation's composer mid-turn, its asks arriving as the agent sends them, with what reached the agent. */
function mount({ draft = "", blocked = null, parked = false, label }: { draft?: string; blocked?: string | null; parked?: boolean; label?: string } = {}) {
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
          live={parked ? null : { runId: "run", working: true }}
          queueing={!parked}
          liveByDefault
          steerable={!parked}
          mentions={[{ key: "rini", name: "Rini", hint: "Opus 5.5" }]}
          asks={asks}
          asksLabel={label}
          asksBlocked={blocked}
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

const EVERY: AskName[] = ["export", "runner", "checks", "three", "build", "deploy", "slack"];

it("names the dock for the person whose answer is needed", () => {
  const c = mount({ label: "Waiting on Morgan" });
  c.arrive("export");
  expect(screen.getByRole("group", { name: "Waiting on Morgan" })).toBe(c.dock());
  expect(screen.queryByRole("group", { name: "Waiting on you" })).toBeNull();
});

describe.each(EVERY)("a docked %s ask, played by keys nobody meant for it", (name) => {
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

describe("several choices, several questions, several asks", () => {
  const press = (name: RegExp | string) => fireEvent.click(screen.getByRole("button", { name }));

  it("toggles several choices, marks the picked ones, and sends them at Answer", () => {
    const c = mount();
    c.arrive("checks");
    press(/Type check/);
    press(/Unit tests/);
    expect(screen.getByRole("button", { name: /Type check/ }).getAttribute("aria-pressed")).toBe("true");
    expect(c.answered()).toEqual([]);
    press("Answer");
    expect(c.answered()).toEqual([{ runId: "run", approvalId: "checks", decision: "allow", answers: { checks: ["Type check", "Unit tests"] } }]);
  });

  it("asks three questions one at a time under one count, and sends all three at the last Answer", () => {
    const c = mount();
    c.arrive("three");
    expect(within(c.dock()!).getByText("1 of 3")).toBeTruthy();
    press(/Downloads folder/);
    expect([within(c.dock()!).getByText("2 of 3").textContent, c.where()]).toEqual(["2 of 3", "field"]);
    press(/JSON/);
    press(/Type check/);
    press(/The packaged smoke test/);
    press("Next");
    expect(within(c.dock()!).getByText("Your answers")).toBeTruthy();
    expect(c.answered()).toEqual([]);
    press("Answer");
    expect(c.answered()).toEqual([
      { runId: "run", approvalId: "three", decision: "allow", answers: { land: ["Downloads folder"], format: ["JSON"], checks: ["Type check", "The packaged smoke test"] } },
    ]);
  });

  it("reopens a kept answer from its line", () => {
    const c = mount();
    c.arrive("three");
    press(/Downloads folder/);
    press(/Where should the export land\?/);
    expect(within(c.dock()!).getByText("1 of 3")).toBeTruthy();
  });

  it("shows one ask of two, says one more waits, and lets nothing pressed for the first reach the second", () => {
    vi.useFakeTimers();
    try {
      const c = mount();
      c.arrive("runner", "first");
      c.arrive("runner", "second");
      expect(within(c.dock()!).getByText("1 more waits")).toBeTruthy();
      c.field.focus();
      c.key("ArrowUp");
      c.key("ArrowDown");
      c.key("Enter");
      c.answer("first");
      for (let i = 0; i < 6; i++) c.key("Enter");
      fireEvent.click(screen.getByRole("button", { name: /Vitest/ }));
      expect(c.answered().map((params) => (params as { approvalId: string }).approvalId)).toEqual(["first"]);
      expect(within(c.dock()!).queryByText("1 more waits")).toBeNull();
      act(() => void vi.advanceTimersByTime(300));
      fireEvent.click(screen.getByRole("button", { name: /Vitest/ }));
      expect(c.answered().map((params) => (params as { approvalId: string }).approvalId)).toEqual(["first", "second"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a docked approval, answered on purpose", () => {
  it("allows once by arrow up, the arrows down to Allow once, and Enter", () => {
    const c = mount();
    c.arrive("build");
    c.field.focus();
    c.key("ArrowUp");
    for (let i = 0; i < 3; i++) c.key("ArrowDown");
    expect(document.activeElement?.textContent).toBe("Allow once");
    c.key("Enter");
    expect(c.answered()).toEqual([{ runId: "run", approvalId: "build", decision: "allow" }]);
  });

  it("denies with the note written in its own line at Enter there, and the field's draft stays a message", () => {
    const c = mount({ draft: "also run the lint after" });
    c.arrive("build");
    const line = screen.getByRole("textbox", { name: "What to do instead of Bash" });
    act(() => line.focus());
    fireEvent.change(line, { target: { value: "Build only the pricing page" } });
    c.key("Enter");
    expect(c.answered()).toEqual([{ runId: "run", approvalId: "build", decision: "deny", note: "Build only the pricing page" }]);
    expect([c.sent(), messageOf(c.field)]).toEqual([[], "also run the lint after"]);
  });

  it("allows once at a double press on Allow once", () => {
    const c = mount();
    c.arrive("build");
    const allow = screen.getByRole("button", { name: "Allow once" });
    fireEvent.click(allow);
    fireEvent.click(allow);
    expect(c.answered()).toEqual([{ runId: "run", approvalId: "build", decision: "allow" }]);
  });

  it("allows the first of two by keys, and six more Enters leave the second untouched", () => {
    const c = mount();
    c.arrive("build");
    c.arrive("deploy");
    c.field.focus();
    c.key("ArrowUp");
    for (let i = 0; i < 3; i++) c.key("ArrowDown");
    c.key("Enter");
    c.answer("build");
    for (let i = 0; i < 6; i++) c.key("Enter");
    expect(c.answered().map((params) => (params as { approvalId: string }).approvalId)).toEqual(["build"]);
    expect(within(c.dock()!).getByText("vercel deploy --prebuilt --prod")).toBeTruthy();
  });

  it("offers Allow once alone for a request that can only be allowed once, with the raw request on demand", () => {
    const c = mount();
    c.arrive("slack");
    expect(within(c.dock()!).queryByRole("button", { name: "Allow for this run" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show request" }));
    expect(within(c.dock()!).getByText(/"channel": "#releases"/)).toBeTruthy();
  });
});

describe("an ask that can't be answered from here, and one whose turn has ended", () => {
  it.each(["export", "build"] as const)("shows a %s ask with every control dimmed, says why on demand, and takes no press or key", (name) => {
    const c = mount({ blocked: "Only Ana can answer in Ana's thread." });
    c.arrive(name);
    const controls = [...c.dock()!.querySelectorAll<HTMLElement>("button, input")];
    expect(controls.every((control) => control.hasAttribute("disabled") || control.textContent === "Show request")).toBe(true);
    expect(
      within(c.dock()!)
        .getAllByRole("button")
        .find((button) => button.hasAttribute("disabled"))
        ?.getAttribute("data-tip"),
    ).toBe("Only Ana can answer in Ana's thread.");
    for (const control of controls) fireEvent.click(control);
    c.field.focus();
    c.key("ArrowUp");
    for (let i = 0; i < 4; i++) (c.key("ArrowDown"), c.key("Enter"));
    expect(c.answered()).toEqual([]);
  });

  it("docks an ask whose turn has ended, and sends a message typed meanwhile, which starts the next turn", async () => {
    const c = mount({ parked: true });
    c.arrive("export");
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    type(c.field, "Downloads, and add the date range");
    c.key("Enter");
    await waitFor(() => expect(c.sent()).toEqual(["queue: Downloads, and add the date range"]));
    expect(c.answered()).toEqual([]);
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
