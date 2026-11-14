import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Composer, type ComposerHandle, type ComposerProps } from "./Composer";
import { readDraft, writeDraft } from "../lib/drafts";
import { core } from "../lib/rpc";
import { isPreviewCovered } from "../lib/browser-preview";
import { act$, caretOf, messageOf, placeCaret, press, type } from "./composer-editor/testing";

afterEach(cleanup);

/** Only what the composer reads on mount. Nothing here reaches the core or a provider. */
const BASE: ComposerProps = {
  value: "say something",
  onChange: () => {},
  onSubmit: async () => {},
  placeholder: "Message",
  model: null,
  onModel: () => {},
  mode: "act",
  onMode: () => {},
  permission: "trusted",
  onPermission: () => {},
  location: { label: null, branch: null },
};

function mount(overrides: Partial<ComposerProps> = {}) {
  const props: ComposerProps = { ...BASE, ...overrides };
  function ControlledComposer() {
    const [value, setValue] = useState(props.value);
    return (
      <Composer
        {...props}
        value={value}
        onChange={(text) => {
          setValue(text);
          props.onChange(text);
        }}
      />
    );
  }
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ControlledComposer />
    </QueryClientProvider>,
  );
}

// Context popover behavior is covered in composer-steering-ui-smoke.cjs with real layout and focus.

describe("slash suggestions", () => {
  const commands: ComposerProps["commands"] = [
    { name: "compact", hint: "Summarize", run: vi.fn() },
    { name: "code-review", hint: "Review code", insert: true, prefix: "/" },
  ];
  const message = () => screen.getByRole("textbox", { name: "Message" });
  const selectAt = (caret: number) => placeCaret(message(), caret);

  it.each(["please\n/", " /"])("offers inline skills for %j", (value) => {
    mount({ commands, value: "" });
    type(message(), value);
    expect(screen.getByRole("option", { name: "/code-review Review code" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "/compact Summarize" })).toBeNull();
  });

  it("asks for the list again once as each command word starts, even with no skills to offer yet", () => {
    const wanted = vi.fn();
    mount({ commands: [], onCommandsWanted: wanted, value: "" });
    type(message(), "/", 1);
    type(message(), "/co", 3);
    expect(wanted).toHaveBeenCalledTimes(1);
    type(message(), "/co and", 7);
    type(message(), "/co and $", 9);
    expect(wanted).toHaveBeenCalledTimes(2);
  });

  it("does not ask again when only the callback changes, as it does when a read starts, ends or fails", () => {
    const wanted = vi.fn();
    function Changing() {
      const [value, setValue] = useState("");
      const [reads, setReads] = useState(0);
      return (
        <>
          <button onClick={() => setReads((count) => count + 1)}>Read ended</button>
          <Composer {...BASE} value={value} onChange={setValue} commands={[]} onCommandsWanted={() => wanted(reads)} />
        </>
      );
    }
    render(
      <QueryClientProvider client={new QueryClient()}>
        <Changing />
      </QueryClientProvider>,
    );
    type(message(), "/", 1);
    fireEvent.click(screen.getByText("Read ended"));
    fireEvent.click(screen.getByText("Read ended"));
    expect(wanted).toHaveBeenCalledTimes(1);
  });

  it("says the skills could not be loaded when their prefix starts a word, and still sends on Enter", async () => {
    const submitted = vi.fn(async () => {});
    mount({ commands: [], commandsNotice: { prefix: "/", text: "Couldn’t load skills", reason: "repo is missing." }, onSubmit: submitted, value: "" });
    type(message(), "costs $5", 8);
    expect(screen.queryByRole("status")).toBeNull();
    type(message(), "/review", 7);
    expect(screen.getByRole("status").textContent).toBe("Couldn’t load skills");
    expect(screen.getByRole("status").getAttribute("data-tip")).toBe("repo is missing.");
    press(message(), { key: "Enter" });
    await waitFor(() => expect(submitted).toHaveBeenCalledWith("/review", [], false));
  });

  it("keeps the thread's own commands beside the notice", () => {
    mount({ commands: [{ name: "compact", hint: "Summarize", run: vi.fn() }], commandsNotice: { prefix: "/", text: "Couldn’t load skills", reason: "repo is missing." }, value: "" });
    type(message(), "/", 1);
    expect(screen.getByRole("option", { name: "/compact Summarize" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("Couldn’t load skills");
    press(message(), { key: "Escape" });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("tells a screen reader which list it controls and which row the arrows chose, with focus kept in the message", () => {
    mount({ commands, value: "" });
    expect(message().getAttribute("aria-activedescendant")).toBeNull();
    type(message(), "/", 1);
    const [first, second] = screen.getAllByRole("option");
    expect(message().getAttribute("aria-controls")).toBe(screen.getByRole("listbox").id);
    expect(message().getAttribute("aria-activedescendant")).toBe(first!.id);
    press(message(), { key: "ArrowDown" });
    expect(message().getAttribute("aria-activedescendant")).toBe(second!.id);
    expect(second!.getAttribute("aria-selected")).toBe("true");
    press(message(), { key: "Escape" });
    expect(message().getAttribute("aria-activedescendant")).toBeNull();
    expect(message().getAttribute("aria-controls")).toBeNull();
  });

  it("offers every skill rather than stopping at a page, matching names in any case", () => {
    const many: ComposerProps["commands"] = [...Array.from({ length: 30 }, (_, index) => `skill-${index}`), "COMMAND_CHEATSHEET"].map((name) => ({ name, hint: "A skill", insert: true, prefix: "/" }));
    mount({ commands: many, value: "" });
    type(message(), "/", 1);
    expect(screen.getAllByRole("option")).toHaveLength(31);
    type(message(), "/command", 8);
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["/COMMAND_CHEATSHEETA skill"]);
  });

  it("selects a row when the pointer moves over it, not when a row scrolls under a still pointer", () => {
    mount({ commands, value: "" });
    type(message(), "/", 1);
    const [first, second] = screen.getAllByRole("option");
    fireEvent.mouseEnter(second!);
    expect(first?.getAttribute("aria-selected")).toBe("true");
    fireEvent.mouseMove(second!);
    expect(second?.getAttribute("aria-selected")).toBe("true");
  });

  it("keeps the message focused when the list itself is pressed, so its scrollbar can be dragged", () => {
    mount({ commands, value: "" });
    type(message(), "/", 1);
    expect(fireEvent.mouseDown(screen.getByRole("listbox"))).toBe(false);
    fireEvent.mouseUp(screen.getByRole("listbox"));
  });

  it("brings the first row back into view when typing narrows a list scrolled away from it", () => {
    const scrolled = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrolled;
    try {
      const many: ComposerProps["commands"] = Array.from({ length: 30 }, (_, index) => ({ name: `skill-${index}`, hint: "A skill", insert: true, prefix: "/" }));
      mount({ commands: many, value: "" });
      type(message(), "/", 1);
      // The pointer scrolls the list; the first row stays selected, so only the narrower list can bring it back.
      scrolled.mockClear();
      type(message(), "/skill-2", 8);
      const [first] = screen.getAllByRole("option");
      expect(first?.getAttribute("aria-selected")).toBe("true");
      expect(scrolled.mock.contexts).toContain(first);
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  describe("Enter, Esc and what a name typed in full means", () => {
    const skill = (name: string, aliases?: string[]): NonNullable<ComposerProps["commands"]>[number] => ({ name, hint: "A skill", insert: true, prefix: "/", ...(aliases ? { aliases } : {}) });
    const offered = () => screen.queryAllByRole("option").map((option) => option.querySelector(".composer-suggestion-label")?.textContent);

    it("sends a name typed in full as it is, so a plugin's or a longer name never takes its place", async () => {
      const onSubmit = vi.fn(async () => {});
      mount({ commands: [skill("code-review:code-review"), skill("review-strict"), skill("code-review", ["review"])], value: "/code-review", onSubmit });
      selectAt("/code-review".length);
      expect(offered()).toEqual(["/code-review", "/code-review:code-review"]);
      type(message(), "/review", 7);
      expect(offered()?.[0]).toBe("/code-review");
      type(message(), "/code-review", 12);
      press(message(), { key: "Enter" });
      await waitFor(() => expect(onSubmit).toHaveBeenCalledWith("/code-review", [], false));
    });

    it("finds a plugin's command by the name after its colon and by its short name", () => {
      mount({ commands: [skill("pstack:how", ["how"]), skill("pstack:why", ["why"])], value: "/ho" });
      selectAt(3);
      expect(offered()).toEqual(["/pstack:how"]);
    });

    it("sends a path that ends the message as it is", async () => {
      const onSubmit = vi.fn(async () => {});
      mount({ commands: [skill("test-all")], value: "see /test", onSubmit });
      selectAt("see /test".length);
      press(message(), { key: "Enter" });
      await waitFor(() => expect(onSubmit).toHaveBeenCalledWith("see /test", [], false));
    });

    it("picks a row at the end of a message once the arrow keys chose it", () => {
      const onSubmit = vi.fn(async () => {});
      mount({ commands: [skill("test-all")], value: "see /test", onSubmit });
      selectAt("see /test".length);
      press(message(), { key: "ArrowDown" });
      press(message(), { key: "Enter" });
      expect(messageOf(message())).toBe("see /test-all ");
      expect(onSubmit).not.toHaveBeenCalled();
    });

    it("closes the list on Esc and keeps what was typed", () => {
      mount({ commands: [skill("test-all")], value: "look at /te" });
      selectAt("look at /te".length);
      press(message(), { key: "Escape" });
      expect(messageOf(message())).toBe("look at /te");
      expect(screen.queryByRole("listbox")).toBeNull();
    });

    it("runs an action and keeps the rest of the draft for the next message", () => {
      const run = vi.fn();
      mount({ commands: [{ name: "compact", hint: "Summarize", run }], value: "/comp keep this long draft" });
      selectAt(5);
      press(message(), { key: "Enter" });
      expect(run).toHaveBeenCalledOnce();
      expect(messageOf(message())).toBe("keep this long draft");
    });

    it("leaves Shift+Enter and Cmd+Enter their own meaning while the list is open", async () => {
      const onSubmit = vi.fn(async () => {});
      mount({ commands: [skill("test-all")], value: "/te", onSubmit });
      selectAt(3);
      press(message(), { key: "Enter", shiftKey: true });
      expect(messageOf(message())).toBe("/te\n");
      expect(onSubmit).not.toHaveBeenCalled();
      press(message(), { key: "Enter", metaKey: true });
      await waitFor(() => expect(onSubmit).toHaveBeenCalledWith("/te", [], false));
    });
  });

  it("updates action availability when the caret moves between identical slash queries", () => {
    mount({ commands, value: "/ /" });
    selectAt(1);
    expect(screen.getAllByRole("option")).toHaveLength(2);
    expect(screen.getByRole("option", { name: "/compact Summarize" })).toBeTruthy();
    selectAt(3);
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(screen.queryByRole("option", { name: "/compact Summarize" })).toBeNull();
    selectAt(1);
    expect(screen.getAllByRole("option")).toHaveLength(2);
  });

  it.each(["mouse", "Tab"])("inserts an inline skill using %s and preserves text, highlight and caret", async (method) => {
    const onSubmit = vi.fn(async () => {});
    mount({ commands, value: "please /co afterward", onSubmit });
    selectAt("please /co".length);
    const option = screen.getByRole("option", { name: "/code-review Review code" });
    if (method === "mouse") {
      fireEvent.mouseDown(option);
      fireEvent.mouseUp(message());
    } else press(message(), { key: method });
    expect(messageOf(message())).toBe("please /code-review afterward");
    expect(message().querySelector("mark")?.textContent).toBe("/code-review");
    await waitFor(() => {
      expect(caretOf(message())).toBe("please /code-review ".length);
      expect(document.activeElement).toBe(message());
    });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("still executes an action command at the beginning", () => {
    const run = vi.fn();
    mount({ commands: [{ name: "compact", hint: "Summarize", run }], value: "/comp" });
    selectAt(5);
    press(message(), { key: "Enter" });
    expect(run).toHaveBeenCalledOnce();
    expect(messageOf(message())).toBe("");
  });

  it("inserts a Codex skill with its dollar prefix without offering slash actions", () => {
    mount({
      commands: [
        { name: "compact", hint: "Summarize", run: vi.fn() },
        { name: "code-review", hint: "Review code", insert: true, prefix: "$" },
      ],
      value: "Please $co",
    });
    selectAt("Please $co".length);
    expect(screen.queryByRole("option", { name: "/compact Summarize" })).toBeNull();
    press(message(), { key: "Tab" });
    expect(messageOf(message())).toBe("Please $code-review ");
    expect(message().querySelector("mark")?.textContent).toBe("$code-review");
  });

  it.each([
    ["conversation", "Tab"],
    ["conversation", "Enter"],
    ["new-thread", "Tab"],
    ["new-thread", "mouse"],
  ] as const)("offers Codex skills from / in the %s composer and selects with %s", async (presentation, method) => {
    const onSubmit = vi.fn(async () => {});
    mount({
      commands: [{ name: "code-review", hint: "Review code", insert: true, prefix: "$" }],
      presentation,
      value: "",
      onSubmit,
    });
    type(message(), "/", 1);
    expect(screen.getByRole("option", { name: "$code-review Review code" })).toBeTruthy();
    type(message(), "Please /co afterward", "Please /co".length);
    if (method === "mouse") fireEvent.mouseDown(screen.getByRole("option", { name: "$code-review Review code" }));
    else press(message(), { key: method });
    expect(messageOf(message())).toBe("Please $code-review afterward");
    expect(message().querySelector("mark")?.textContent).toBe("$code-review");
    await waitFor(() => expect(caretOf(message())).toBe("Please $code-review ".length));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it.each(["/tmp/co", "https://example.com/co"])("does not offer suggestions inside %j", (value) => {
    mount({ commands, value });
    selectAt(value.length);
    expect(screen.queryByRole("listbox", { name: "Commands" })).toBeNull();
  });

  it("dismisses suggestions when focus leaves the composer and releases the Preview", async () => {
    mount({ commands, value: "" });
    act(() => message().focus());
    type(message(), "/co", 3);
    expect(screen.getByRole("listbox", { name: "Commands" })).toBeTruthy();
    expect(isPreviewCovered()).toBe(true);
    const mode = screen.getByRole("button", { name: /^Mode:/ });
    act(() => mode.focus());
    await waitFor(() => expect(screen.queryByRole("listbox", { name: "Commands" })).toBeNull());
    expect(isPreviewCovered()).toBe(false);
    expect(messageOf(message())).toBe("/co");
    act(() => message().focus());
    expect(screen.getByRole("listbox", { name: "Commands" })).toBeTruthy();
  });
});

describe("the send cluster", () => {
  const ink = () => document.querySelector<HTMLButtonElement>(".composer-send")!;
  it("stops from the one ink button with nothing typed, and steps Stop aside as a key once something is", () => {
    const onStop = vi.fn();
    mount({ value: "", liveByDefault: true, queueing: true, steerable: true, stopAction: { working: true, pending: false, onStop } });
    expect(ink().getAttribute("aria-label")).toBe("Stop");
    expect(screen.queryByRole("button", { name: "Queue" })).toBeNull();
    fireEvent.click(ink());
    expect(onStop).toHaveBeenCalledOnce();
    type(screen.getByRole("textbox", { name: "Message" }), "A correction");
    expect(ink().getAttribute("aria-label")).toBe("Send now");
    expect(ink().textContent).toBe("Send now");
    expect(screen.getByRole("button", { name: "Queue" }).classList.contains("composer-send-other")).toBe(true);
    expect(screen.getByRole("button", { name: "Stop" }).classList.contains("composer-stop")).toBe(true);
    type(screen.getByRole("textbox", { name: "Message" }), "  \n ");
    expect(ink().getAttribute("aria-label")).toBe("Stop");
  });

  it("sends into the turn from the pill and with Enter, and queues from the quiet word and with Command and Enter", async () => {
    const onSubmit = vi.fn(async () => {});
    mount({ queueing: true, liveByDefault: true, steerable: true, onSubmit });
    fireEvent.click(ink());
    await waitFor(() => expect(onSubmit).toHaveBeenLastCalledWith("say something", [], true));
    cleanup();
    mount({ queueing: true, liveByDefault: true, steerable: true, onSubmit });
    press(screen.getByRole("textbox", { name: "Message" }), { key: "Enter", metaKey: true });
    await waitFor(() => expect(onSubmit).toHaveBeenLastCalledWith("say something", [], false));
  });

  it("puts Queue on the pill when the person queues by default, with Send now beside it", async () => {
    const onSubmit = vi.fn(async () => {});
    mount({ queueing: true, liveByDefault: false, steerable: true, onSubmit });
    expect(ink().getAttribute("aria-label")).toBe("Queue");
    fireEvent.click(screen.getByRole("button", { name: "Send now" }));
    await waitFor(() => expect(onSubmit).toHaveBeenLastCalledWith("say something", [], true));
  });

  it("keeps Send now dimmed with its reason when the turn cannot take a message, and Enter queues", async () => {
    const onSubmit = vi.fn(async () => {});
    const reason = "This agent reads new messages after its turn. It will be queued.";
    mount({ queueing: true, liveByDefault: true, steerable: false, steerReason: reason, onSubmit });
    expect(ink().getAttribute("aria-label")).toBe("Queue");
    const now = screen.getByRole("button", { name: "Send now" });
    expect(now).toHaveProperty("disabled", true);
    expect(now.getAttribute("data-tip")).toBe(reason);
    press(screen.getByRole("textbox", { name: "Message" }), { key: "Enter" });
    await waitFor(() => expect(onSubmit).toHaveBeenLastCalledWith("say something", [], false));
  });

  it("names a task's empty first send, and keeps the bare arrow once words are typed", () => {
    mount({ value: "", allowEmpty: true });
    expect(ink().getAttribute("aria-label")).toBe("Start from the task");
    cleanup();
    mount({ allowEmpty: true });
    expect(ink().getAttribute("aria-label")).toBe("Send");
    expect(ink().textContent).toBe("");
  });

  it("says why a send cannot go only on the dimmed send, and names the bare arrow otherwise", () => {
    mount({ disabledReason: "Sign in to OpenOrc Cloud to start a turn." });
    expect(ink().getAttribute("data-tip")).toBe("Sign in to OpenOrc Cloud to start a turn.");
    cleanup();
    mount({ queueing: true, liveByDefault: true, steerable: true });
    expect(ink().getAttribute("data-tip")).toBeNull();
    expect(screen.getByRole("button", { name: "Queue" }).getAttribute("data-tip")).toBeNull();
  });
});

it("lists @ in one list, in groups: Orclings, then Files, then Connectors", async () => {
  vi.spyOn(core, "call").mockImplementation(async (method) => (method === "files.search" ? ["src/rini.ts"] : null) as never);
  mount({
    value: "",
    mentions: [{ key: "orcling:rini", name: "Rini", hint: "Orcling" }],
    connectors: [{ name: "rini-notes", title: "Rini notes", logo: null }],
    fileSearch: { kind: "project", id: "p" },
  });
  type(screen.getByRole("textbox", { name: "Message" }), "@ri");
  await waitFor(() => expect([...document.querySelectorAll(".composer-suggestion-group")].map((group) => group.textContent)).toEqual(["Orclings", "Files", "Connectors"]));
  vi.restoreAllMocks();
});

describe("the plus", () => {
  const offers = {
    commands: [
      { name: "code-review", hint: "Review the branch", insert: true as const, prefix: "/" as const },
      { name: "compact", hint: "Summarize", run: () => {} },
    ],
    connectors: [{ name: "paper", title: "Paper", logo: null }],
    mentions: [{ key: "orcling:rini", name: "Rini", hint: "Orcling" }],
  };
  const choose = async (row: string) => {
    fireEvent.click(screen.getByRole("button", { name: "Add to this message" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: row }));
  };
  const listed = () => screen.queryAllByRole("option").map((option) => option.textContent);

  it("opens one kind's list at the caret, apart from the word before it, as one step to undo", async () => {
    mount({ ...offers, value: "ask" });
    const field = screen.getByRole("textbox", { name: "Message" });
    act$(field, () => (placeCaret(field, 3), true));
    await choose("Connector");
    expect(messageOf(field)).toBe("ask @");
    await waitFor(() => expect(listed()).toEqual(["P@paperPaper"]));
    press(field, { key: "Enter" });
    expect(messageOf(field)).toBe("ask @paper ");
    press(field, { key: "z", ctrlKey: true });
    press(field, { key: "z", ctrlKey: true });
    expect(messageOf(field)).toBe("ask");
  });

  it("opens Orclings alone, and skills alone, where `@` and `/` would mix them", async () => {
    mount({ ...offers, value: "" });
    await choose("Orcling");
    await waitFor(() => expect(listed()).toEqual(["@RiniOrcling"]));
    cleanup();
    mount({ ...offers, value: "" });
    await choose("Skill");
    await waitFor(() => expect(listed()).toEqual(["/code-reviewReview the branch"]));
  });

  it("keeps Command dimmed with its reason once words are written", async () => {
    mount({ ...offers, value: "ask" });
    fireEvent.click(screen.getByRole("button", { name: "Add to this message" }));
    const command = await screen.findByRole("menuitem", { name: "Command" });
    expect(command.getAttribute("aria-disabled")).toBe("true");
    expect(command.getAttribute("data-tip")).toBe("Commands start a message.");
  });
});

describe("a queued message coming back", () => {
  it("is added after the words already written, with its files, as one step to undo and no pop", () => {
    const handle = createRef<ComposerHandle>();
    mount({ handle, value: "Then open a pull request", draftKey: "returned" });
    act(() => handle.current!.append("Also run the phone tests", ["/assets/0b0c4b3e-1111-4a4a-8a8a-123456789abc-shot.png"]));
    const field = screen.getByRole("textbox", { name: "Message" });
    expect(messageOf(field)).toBe("Then open a pull request\nAlso run the phone tests");
    expect(field.querySelector("[data-landing]")).toBeNull();
    expect(screen.getByRole("img", { name: "shot.png" })).toBeTruthy();
    press(field, { key: "z", ctrlKey: true });
    expect(messageOf(field)).toBe("Then open a pull request");
  });

  it("takes the field as it is when nothing is written", () => {
    const handle = createRef<ComposerHandle>();
    mount({ handle, value: "" });
    act(() => handle.current!.append("Also run the phone tests", []));
    expect(messageOf(screen.getByRole("textbox", { name: "Message" }))).toBe("Also run the phone tests");
  });
});

describe("pending sends across navigation", () => {
  it("blocks Send when reopened during an attachment import and includes that file after completion", async () => {
    let finish!: (value: { path: string; name: string; bytes: number }) => void;
    const save = vi.fn(
      () =>
        new Promise<{ path: string; name: string; bytes: number }>((resolve) => {
          finish = resolve;
        }),
    );
    const originalCall = core.call.bind(core);
    const call = vi.spyOn(core, "call").mockImplementation((method, params) => {
      const fallback = () => originalCall(method, params);
      return method === "attachments.saveFile" ? save() : fallback();
    });
    const onSubmit = vi.fn(async () => {});
    const props = { draftKey: "pending-import-send", onSubmit };
    try {
      mount(props);
      const field = screen.getByRole("textbox", { name: "Message" });
      act$(field, () => fireEvent.paste(field, { clipboardData: { files: [new File(["notes"], "notes.txt", { type: "text/plain" })] } }));
      await waitFor(() => expect(save).toHaveBeenCalledOnce());
      cleanup();
      mount(props);
      expect(screen.getByRole("button", { name: "Send" })).toHaveProperty("disabled", true);
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
      expect(onSubmit).not.toHaveBeenCalled();
      await act(async () => finish({ path: "/assets/notes.txt", name: "notes.txt", bytes: 5 }));
      expect(screen.getByRole("button", { name: "Send" })).toHaveProperty("disabled", false);
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
      await waitFor(() => expect(onSubmit).toHaveBeenCalledExactlyOnceWith("say something", ["/assets/notes.txt"], false));
    } finally {
      call.mockRestore();
    }
  });

  it("keeps one send pending when the same draft is reopened and clears the reopened input on acceptance", async () => {
    let accept!: () => void;
    const onSubmit = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          accept = resolve;
        }),
    );
    const props = { draftKey: "navigation-accept", onSubmit, liveByDefault: true, queueing: true, steerable: true };
    mount(props);
    fireEvent.click(screen.getByRole("button", { name: "Send now" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    for (let i = 0; i < 6; i++) {
      cleanup();
      mount(props);
      expect(screen.getByRole("button", { name: "Send now" })).toHaveProperty("disabled", true);
      expect(screen.getByRole("textbox", { name: "Message" }).getAttribute("aria-disabled")).toBe("true");
      expect(screen.getByText("Sending…")).toBeTruthy();
      press(screen.getByRole("textbox", { name: "Message" }), { key: "Enter" });
      fireEvent.click(screen.getByRole("button", { name: "Queue" }));
    }
    expect(onSubmit).toHaveBeenCalledOnce();
    await act(async () => accept());
    expect(messageOf(screen.getByRole("textbox", { name: "Message" }))).toBe("");
    expect(screen.queryByText("Sending…")).toBeNull();
  });

  it("persists accepted attachment cleanup while the composer is unmounted", async () => {
    let accept!: () => void;
    const onSubmit = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          accept = resolve;
        }),
    );
    const draftKey = "navigation-attachments";
    writeDraft(draftKey, { attachments: [{ path: "/data/image.png", url: "data:image/png;base64,AA==", name: "Correction" }] });
    mount({ draftKey, onSubmit });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith("say something", ["/data/image.png"], false));
    cleanup();
    await act(async () => accept());
    expect(readDraft(draftKey, { attachments: [] }).attachments).toEqual([]);
    mount({ draftKey, value: "", onSubmit });
    expect(screen.queryByRole("button", { name: "Remove image" })).toBeNull();
    expect(screen.queryByText("Sending…")).toBeNull();
  });

  it("allows another thread to send while the first thread is awaiting delivery", async () => {
    let accept!: () => void;
    mount({
      draftKey: "pending-thread",
      onSubmit: () =>
        new Promise<void>((resolve) => {
          accept = resolve;
        }),
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(accept).toBeDefined());
    cleanup();
    const onSubmit = vi.fn(async () => {});
    mount({ draftKey: "other-thread", onSubmit });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    await act(async () => accept());
  });

  it("retains an error and its draft when delivery fails away from the thread, and permits a deliberate retry", async () => {
    let reject!: (error: Error) => void;
    const onSubmit = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((_resolve, no) => {
            reject = no;
          }),
      )
      .mockResolvedValue(undefined);
    const props = { draftKey: "navigation-error", onSubmit };
    mount(props);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    cleanup();
    await act(async () => reject(new Error("Provider rejected this input")));
    mount(props);
    expect(screen.getByRole("alert").textContent).toContain("Provider rejected this input");
    expect(messageOf(screen.getByRole("textbox", { name: "Message" }))).toBe("say something");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(messageOf(screen.getByRole("textbox", { name: "Message" }))).toBe(""));
  });
});

describe("Stop delivery", () => {
  it.each(["Keep this draft"])("shows pending cancellation and its error for draft %j, with a working retry", async (value) => {
    let reject!: (error: Error) => void;
    const interrupt = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, no) => {
            reject = no;
          }),
      )
      .mockResolvedValue(null);
    const originalCall = core.call.bind(core);
    const call = vi.spyOn(core, "call").mockImplementation((method, params) => (method === "runs.interrupt" ? interrupt(params) : originalCall(method, params)));
    try {
      mount({ value, live: { runId: "running", working: true } });
      fireEvent.click(screen.getByRole("button", { name: "Stop" }));
      await waitFor(() => expect(call).toHaveBeenCalledWith("runs.interrupt", { runId: "running" }));
      await waitFor(() => expect(screen.getByRole("button", { name: "Stop" })).toHaveProperty("disabled", true));
      expect(screen.getByText("Stopping…")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Stop" }));
      expect(interrupt).toHaveBeenCalledTimes(1);
      await act(async () => reject(new Error("Provider refused cancellation")));
      await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Provider refused cancellation"));
      expect(messageOf(screen.getByRole("textbox", { name: "Message" }))).toBe(value);
      expect(screen.getByRole("button", { name: "Stop" })).toHaveProperty("disabled", false);
      fireEvent.click(screen.getByRole("button", { name: "Stop" }));
      await waitFor(() => expect(interrupt).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    } finally {
      call.mockRestore();
    }
  });
});

describe("file mentions", () => {
  const message = () => screen.getByRole("textbox", { name: "Message" });

  it("searches the conversation's own folder, and nowhere without one", async () => {
    const searched: unknown[] = [];
    const originalCall = core.call.bind(core);
    const call = vi.spyOn(core, "call").mockImplementation((method, params) => {
      if (method !== "files.search") return originalCall(method, params);
      searched.push(params);
      return Promise.resolve(["src/app.ts"] as never);
    });
    try {
      mount({ value: "", fileSearch: { kind: "thread", id: "worktree-thread" } });
      type(message(), "@app", 4);
      expect(await screen.findByRole("option", { name: "src/app.ts" })).toBeTruthy();
      expect(searched).toEqual([{ scope: { kind: "thread", id: "worktree-thread" }, query: "app", limit: 8 }]);
      cleanup();
      mount({ value: "" });
      type(message(), "@app", 4);
      expect(screen.queryByRole("option", { name: "src/app.ts" })).toBeNull();
      expect(searched).toHaveLength(1);
    } finally {
      call.mockRestore();
    }
  });
});

describe("mode picker", () => {
  const offered = async () => (await screen.findAllByRole("menuitem")).map((item) => item.querySelector("span")?.textContent);
  it("offers Claude every mode", async () => {
    mount({ model: { agent: "claude", model: "claude-opus-5-5", effort: null }, modelControl: <span /> });
    fireEvent.click(screen.getByRole("button", { name: "Mode: Accept edits" }));
    expect(await offered()).toEqual(["Plan", "Review everything", "Accept edits", "Autonomous"]);
  });
  it("offers OpenCode only the modes it can run, and still shows a saved one it cannot", async () => {
    mount({ model: { agent: "opencode", model: "openai/gpt-5", effort: null }, modelControl: <span /> });
    expect(screen.getByText("Mode unavailable")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Mode: Accept edits" }));
    expect(await offered()).toEqual(["Plan", "Autonomous"]);
  });
});

describe("initial execution location", () => {
  it("offers the checkout choice before the first start", () => {
    mount({ hasStarted: false, children: <button>Checkout</button>, location: { label: "Local checkout", branch: "main" } });
    expect(screen.getByRole("button", { name: "Checkout" })).toBeTruthy();
  });
  it.each([true, false])("removes the destination after a thread has started (busy=%s)", (busy) => {
    const { container } = mount({ hasStarted: true, busy, children: <button disabled>Checkout</button>, location: { label: "Local checkout", branch: "main" } });
    expect(screen.queryByRole("button", { name: "Checkout" })).toBeNull();
    expect(screen.queryByText("Local checkout")).toBeNull();
    expect(container.querySelector(".composer-destination")).toBeNull();
    expect(screen.getByRole("button", { name: /^Mode:/ })).toBeTruthy();
    expect(screen.queryByText("main")).toBeNull();
  });
});

describe("mode pill", () => {
  it("opens a menu of the levels the agent offers and applies the chosen one without stepping", async () => {
    const onExecutionMode = vi.fn();
    mount({ model: { agent: "opencode", model: "m", effort: null }, mode: "act", permission: "autonomous", onExecutionMode });
    const pill = screen.getByRole("button", { name: "Mode: Autonomous" });
    fireEvent.click(pill);
    const items = await screen.findAllByRole("menuitem");
    expect(items.map((item) => item.textContent)).toEqual(["PlanRead-only, proposes a plan", "AutonomousRuns tools without asking"]);
    expect(onExecutionMode).not.toHaveBeenCalled();
    fireEvent.click(items[0]!);
    expect(onExecutionMode).toHaveBeenCalledExactlyOnceWith({ mode: "plan", permissionMode: "review" });
  });
});

describe("connector mentions", () => {
  const connectors: ComposerProps["connectors"] = [{ name: "paper", title: "Paper", logo: null }];
  const message = () => screen.getByRole("textbox", { name: "Message" });
  const typeAt = (text: string) => {
    type(message(), text, text.length);
    fireEvent.select(message());
  };

  it("offers a connector for an @ word and Enter picks it, even at the end of the message", () => {
    const onSubmit = vi.fn(async () => {});
    const onConnectorsWanted = vi.fn();
    mount({ value: "", connectors, onConnectorsWanted, onSubmit });
    typeAt("do you see @pa");
    expect(onConnectorsWanted).toHaveBeenCalled();
    expect(screen.getByRole("option", { name: "@paper Paper" })).toBeTruthy();
    press(message(), { key: "Enter" });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(messageOf(message())).toBe("do you see @paper ");
    const mark = message().querySelector("mark[data-connector='paper']");
    expect(mark?.querySelector(".mark-pill-name")?.textContent).toBe("Paper");
    expect(mark?.querySelector(".connector-logo-letter")?.textContent).toBe("P");
  });

  it("leaves an @ word that names no connector unmarked", () => {
    mount({ value: "mail me@paper.com or @papers", connectors });
    expect(message().querySelector("mark[data-connector]")).toBeNull();
  });

  it("lists the connectors the agent goes without in this mode, dimmed under why, and picking one leaves the message", () => {
    mount({ value: "", connectors: [], connectorsAside: { connectors, reason: "Claude has connectors in Autonomous mode." } });
    typeAt("ask @pa");
    const row = screen.getByRole("option", { name: /@paper/ });
    expect([row.getAttribute("aria-disabled"), row.dataset.tip]).toEqual(["true", "Claude has connectors in Autonomous mode."]);
    expect(document.querySelector(".composer-suggestion-group")?.textContent).toBe("Claude has connectors in Autonomous mode.");
    fireEvent.mouseDown(row);
    expect(messageOf(message())).toBe("ask @pa");
  });

  it("sends on Enter when only dimmed connectors match, since none of them can be picked", async () => {
    const onSubmit = vi.fn(async () => {});
    mount({ value: "", connectors: [], connectorsAside: { connectors, reason: "Claude has connectors in Autonomous mode." }, onSubmit });
    typeAt("ask @pa");
    press(message(), { key: "ArrowDown" });
    press(message(), { key: "Enter" });
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
  });

  it("says it is loading connectors while their list is read for the first time, above the rows, where they will land", () => {
    mount({ value: "", connectors: [], connectorsLoading: true });
    typeAt("@");
    const status = screen.getByRole("status");
    expect(status.textContent).toBe("Loading connectors…");
    const list = screen.getByRole("listbox", { hidden: true });
    expect(status.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe("skill hover", () => {
  it("says what a skill is for once the pointer rests on its mark", async () => {
    vi.useFakeTimers();
    // jsdom draws nothing, so the mark says where it is, and its pointer events keep their coordinates.
    vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(function (this: HTMLElement) {
      return (this.dataset["skill"] ? [new DOMRect(10, 10, 80, 16)] : []) as unknown as DOMRectList;
    });
    if (!("PointerEvent" in window)) Object.assign(window, { PointerEvent: MouseEvent });
    mount({ value: "please /code-review this", commands: [{ name: "code-review", hint: "Review the branch for bugs", insert: true, prefix: "/" }] });
    const message = screen.getByRole("textbox", { name: "Message" });
    fireEvent.pointerMove(message, { clientX: 20, clientY: 15 });
    expect(screen.queryByText("Review the branch for bugs")).toBeNull();
    await act(async () => void vi.advanceTimersByTime(400));
    expect(screen.getByText("Review the branch for bugs")).toBeTruthy();
    fireEvent.pointerMove(message, { clientX: 200, clientY: 15 });
    await act(async () => void vi.advanceTimersByTime(400));
    await vi.waitFor(() => expect(screen.queryByText("Review the branch for bugs")).toBeNull());
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("heads what a skill is for with its image and name over the call that runs it", async () => {
    vi.useFakeTimers();
    vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(function (this: HTMLElement) {
      return (this.dataset["skill"] ? [new DOMRect(10, 10, 80, 16)] : []) as unknown as DOMRectList;
    });
    if (!("PointerEvent" in window)) Object.assign(window, { PointerEvent: MouseEvent });
    const icon = "data:image/png;base64,AAAA";
    mount({ value: "please /immaculate this", commands: [{ name: "immaculate", displayName: "Immaculate", icon, hint: "Design like a member of the studio", insert: true, prefix: "/" }] });
    fireEvent.pointerMove(screen.getByRole("textbox", { name: "Message" }), { clientX: 20, clientY: 15 });
    await act(async () => void vi.advanceTimersByTime(400));
    const card = document.querySelector<HTMLElement>(".skill-hover")!;
    expect([...card.querySelectorAll(".skill-hover-name, .skill-hover-call, .skill-hover-hint")].map((part) => part.textContent)).toEqual([
      "Immaculate",
      "/immaculate",
      "Design like a member of the studio",
    ]);
    expect(card.querySelector("img")?.getAttribute("src")).toBe(icon);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
});
