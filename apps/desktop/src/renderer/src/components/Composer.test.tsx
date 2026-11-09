import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Composer, type ComposerProps } from "./Composer";
import { readDraft, writeDraft } from "../lib/drafts";
import { core } from "../lib/rpc";
import { isPreviewCovered } from "../lib/browser-preview";

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

const sendNow = () => screen.queryByLabelText("Send now");

// Context popover behavior is covered in composer-steering-ui-smoke.cjs with real layout and focus.

describe("slash suggestions", () => {
  const commands: ComposerProps["commands"] = [
    { name: "compact", hint: "Summarize", run: vi.fn() },
    { name: "code-review", hint: "Review code", insert: true, prefix: "/" },
  ];
  const message = () => screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Message" });
  const selectAt = (caret: number) => {
    const input = message();
    input.focus();
    input.setSelectionRange(caret, caret);
    fireEvent.select(input);
  };

  it.each(["please\n/", " /"])("offers inline skills for %j", (value) => {
    mount({ commands, value: "" });
    fireEvent.change(message(), { target: { value, selectionStart: value.length } });
    expect(screen.getByRole("option", { name: "/code-review Review code" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "/compact Summarize" })).toBeNull();
  });

  it("asks for the list again once as each command word starts, even with no skills to offer yet", () => {
    const wanted = vi.fn();
    mount({ commands: [], onCommandsWanted: wanted, value: "" });
    fireEvent.change(message(), { target: { value: "/", selectionStart: 1 } });
    fireEvent.change(message(), { target: { value: "/co", selectionStart: 3 } });
    expect(wanted).toHaveBeenCalledTimes(1);
    fireEvent.change(message(), { target: { value: "/co and", selectionStart: 7 } });
    fireEvent.change(message(), { target: { value: "/co and $", selectionStart: 9 } });
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
    fireEvent.change(message(), { target: { value: "/", selectionStart: 1 } });
    fireEvent.click(screen.getByText("Read ended"));
    fireEvent.click(screen.getByText("Read ended"));
    expect(wanted).toHaveBeenCalledTimes(1);
  });

  it("says the skills could not be loaded when their prefix starts a word, and still sends on Enter", async () => {
    const submitted = vi.fn(async () => {});
    mount({ commands: [], commandsNotice: { prefix: "/", text: "Couldn’t load skills", reason: "repo is missing." }, onSubmit: submitted, value: "" });
    fireEvent.change(message(), { target: { value: "costs $5", selectionStart: 8 } });
    expect(screen.queryByRole("status")).toBeNull();
    fireEvent.change(message(), { target: { value: "/review", selectionStart: 7 } });
    expect(screen.getByRole("status").textContent).toBe("Couldn’t load skills");
    expect(screen.getByRole("status").getAttribute("title")).toBe("repo is missing.");
    fireEvent.keyDown(message(), { key: "Enter" });
    await waitFor(() => expect(submitted).toHaveBeenCalledWith("/review", [], false));
  });

  it("keeps the thread's own commands beside the notice", () => {
    mount({ commands: [{ name: "compact", hint: "Summarize", run: vi.fn() }], commandsNotice: { prefix: "/", text: "Couldn’t load skills", reason: "repo is missing." }, value: "" });
    fireEvent.change(message(), { target: { value: "/", selectionStart: 1 } });
    expect(screen.getByRole("option", { name: "/compact Summarize" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("Couldn’t load skills");
    fireEvent.keyDown(message(), { key: "Escape" });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("tells a screen reader which list it controls and which row the arrows chose, with focus kept in the message", () => {
    mount({ commands, value: "" });
    expect(message().getAttribute("aria-activedescendant")).toBeNull();
    fireEvent.change(message(), { target: { value: "/", selectionStart: 1 } });
    const [first, second] = screen.getAllByRole("option");
    expect(message().getAttribute("aria-controls")).toBe(screen.getByRole("listbox").id);
    expect(message().getAttribute("aria-activedescendant")).toBe(first!.id);
    fireEvent.keyDown(message(), { key: "ArrowDown" });
    expect(message().getAttribute("aria-activedescendant")).toBe(second!.id);
    expect(second!.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(message(), { key: "Escape" });
    expect(message().getAttribute("aria-activedescendant")).toBeNull();
    expect(message().getAttribute("aria-controls")).toBeNull();
  });

  it("offers every skill rather than stopping at a page, matching names in any case", () => {
    const many: ComposerProps["commands"] = [...Array.from({ length: 30 }, (_, index) => `skill-${index}`), "COMMAND_CHEATSHEET"].map((name) => ({ name, hint: "A skill", insert: true, prefix: "/" }));
    mount({ commands: many, value: "" });
    fireEvent.change(message(), { target: { value: "/", selectionStart: 1 } });
    expect(screen.getAllByRole("option")).toHaveLength(31);
    fireEvent.change(message(), { target: { value: "/command", selectionStart: 8 } });
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["/COMMAND_CHEATSHEETA skill"]);
  });

  it("selects a row when the pointer moves over it, not when a row scrolls under a still pointer", () => {
    mount({ commands, value: "" });
    fireEvent.change(message(), { target: { value: "/", selectionStart: 1 } });
    const [first, second] = screen.getAllByRole("option");
    fireEvent.mouseEnter(second!);
    expect(first?.getAttribute("aria-selected")).toBe("true");
    fireEvent.mouseMove(second!);
    expect(second?.getAttribute("aria-selected")).toBe("true");
  });

  it("keeps the textarea focused when the list itself is pressed, so its scrollbar can be dragged", () => {
    mount({ commands, value: "" });
    fireEvent.change(message(), { target: { value: "/", selectionStart: 1 } });
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
      fireEvent.change(message(), { target: { value: "/", selectionStart: 1 } });
      // The pointer scrolls the list; the first row stays selected, so only the narrower list can bring it back.
      scrolled.mockClear();
      fireEvent.change(message(), { target: { value: "/skill-2", selectionStart: 8 } });
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
      fireEvent.change(message(), { target: { value: "/review", selectionStart: 7 } });
      expect(offered()?.[0]).toBe("/code-review");
      fireEvent.change(message(), { target: { value: "/code-review", selectionStart: 12 } });
      fireEvent.keyDown(message(), { key: "Enter" });
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
      fireEvent.keyDown(message(), { key: "Enter" });
      await waitFor(() => expect(onSubmit).toHaveBeenCalledWith("see /test", [], false));
    });

    it("picks a row at the end of a message once the arrow keys chose it", () => {
      const onSubmit = vi.fn(async () => {});
      mount({ commands: [skill("test-all")], value: "see /test", onSubmit });
      selectAt("see /test".length);
      fireEvent.keyDown(message(), { key: "ArrowDown" });
      fireEvent.keyDown(message(), { key: "Enter" });
      expect(message().value).toBe("see /test-all ");
      expect(onSubmit).not.toHaveBeenCalled();
    });

    it("closes the list on Esc and keeps what was typed", () => {
      mount({ commands: [skill("test-all")], value: "look at /te" });
      selectAt("look at /te".length);
      fireEvent.keyDown(message(), { key: "Escape" });
      expect(message().value).toBe("look at /te");
      expect(screen.queryByRole("listbox")).toBeNull();
    });

    it("runs an action and keeps the rest of the draft for the next message", () => {
      const run = vi.fn();
      mount({ commands: [{ name: "compact", hint: "Summarize", run }], value: "/comp keep this long draft" });
      selectAt(5);
      fireEvent.keyDown(message(), { key: "Enter" });
      expect(run).toHaveBeenCalledOnce();
      expect(message().value).toBe("keep this long draft");
    });

    it("leaves Shift+Enter and Cmd+Enter their own meaning while the list is open", async () => {
      const onSubmit = vi.fn(async () => {});
      mount({ commands: [skill("test-all")], value: "/te", onSubmit });
      selectAt(3);
      expect(fireEvent.keyDown(message(), { key: "Enter", shiftKey: true })).toBe(true);
      expect(message().value).toBe("/te");
      expect(onSubmit).not.toHaveBeenCalled();
      fireEvent.keyDown(message(), { key: "Enter", metaKey: true });
      await waitFor(() => expect(onSubmit).toHaveBeenCalledWith("/te", [], true));
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
    const { container } = mount({ commands, value: "please /co afterward", onSubmit });
    selectAt("please /co".length);
    const option = screen.getByRole("option", { name: "/code-review Review code" });
    if (method === "mouse") {
      fireEvent.mouseDown(option);
      fireEvent.mouseUp(message());
    } else fireEvent.keyDown(message(), { key: method });
    expect(message().value).toBe("please /code-review afterward");
    expect(container.querySelector(".composer-input-mirror mark")?.textContent).toBe("/code-review");
    await waitFor(() => {
      expect(message().selectionStart).toBe("please /code-review ".length);
      expect(message().selectionEnd).toBe(message().selectionStart);
      expect(document.activeElement).toBe(message());
    });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("still executes an action command at the beginning", () => {
    const run = vi.fn();
    mount({ commands: [{ name: "compact", hint: "Summarize", run }], value: "/comp" });
    selectAt(5);
    fireEvent.keyDown(message(), { key: "Enter" });
    expect(run).toHaveBeenCalledOnce();
    expect(message().value).toBe("");
  });

  it("inserts a Codex skill with its dollar prefix without offering slash actions", () => {
    const { container } = mount({
      commands: [
        { name: "compact", hint: "Summarize", run: vi.fn() },
        { name: "code-review", hint: "Review code", insert: true, prefix: "$" },
      ],
      value: "Please $co",
    });
    selectAt("Please $co".length);
    expect(screen.queryByRole("option", { name: "/compact Summarize" })).toBeNull();
    fireEvent.keyDown(message(), { key: "Tab" });
    expect(message().value).toBe("Please $code-review ");
    expect(container.querySelector(".composer-input-mirror mark")?.textContent).toBe("$code-review");
  });

  it.each([
    ["conversation", "Tab"],
    ["conversation", "Enter"],
    ["new-thread", "Tab"],
    ["new-thread", "mouse"],
  ] as const)("offers Codex skills from / in the %s composer and selects with %s", async (presentation, method) => {
    const onSubmit = vi.fn(async () => {});
    const { container } = mount({
      commands: [{ name: "code-review", hint: "Review code", insert: true, prefix: "$" }],
      presentation,
      value: "",
      onSubmit,
    });
    fireEvent.change(message(), { target: { value: "/", selectionStart: 1 } });
    expect(screen.getByRole("option", { name: "$code-review Review code" })).toBeTruthy();
    fireEvent.change(message(), { target: { value: "Please /co afterward", selectionStart: "Please /co".length } });
    if (method === "mouse") fireEvent.mouseDown(screen.getByRole("option", { name: "$code-review Review code" }));
    else fireEvent.keyDown(message(), { key: method });
    expect(message().value).toBe("Please $code-review afterward");
    expect(container.querySelector(".composer-input-mirror mark")?.textContent).toBe("$code-review");
    await waitFor(() => expect(message().selectionStart).toBe("Please $code-review ".length));
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
    fireEvent.change(message(), { target: { value: "/co", selectionStart: 3 } });
    expect(screen.getByRole("listbox", { name: "Commands" })).toBeTruthy();
    expect(isPreviewCovered()).toBe(true);
    const mode = screen.getByRole("button", { name: /^Mode:/ });
    act(() => mode.focus());
    await waitFor(() => expect(screen.queryByRole("listbox", { name: "Commands" })).toBeNull());
    expect(isPreviewCovered()).toBe(false);
    expect(message().value).toBe("/co");
    act(() => message().focus());
    expect(screen.getByRole("listbox", { name: "Commands" })).toBeTruthy();
  });
});

describe("send now", () => {
  it("uses the submit position for Stop with an empty draft and restores Send when typing", async () => {
    const onStop = vi.fn();
    mount({ value: "", liveByDefault: true, queueing: true, stopAction: { working: true, pending: false, onStop } });
    const stop = screen.getByRole("button", { name: "Stop" });
    expect(stop.classList.contains("composer-send")).toBe(true);
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Queue" })).toBeNull();
    fireEvent.click(stop);
    expect(onStop).toHaveBeenCalledOnce();
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), { target: { value: "A correction" } });
    expect(screen.getByRole("button", { name: "Send" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Queue" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop" }).classList.contains("composer-icon-button")).toBe(true);
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), { target: { value: "  \n " } });
    expect(screen.getByRole("button", { name: "Stop" }).classList.contains("composer-send")).toBe(true);
  });

  it("labels the secondary action Queue and still sends it to the next turn", async () => {
    const onSubmit = vi.fn(async () => {});
    mount({ liveByDefault: true, queueing: true, onSubmit });
    const queue = screen.getByRole("button", { name: "Queue" });
    expect(queue.textContent).toBe("Queue");
    fireEvent.click(queue);
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith("say something", [], false));
  });

  it("appears mid-turn beside a queue button and reaches the running turn rather than queueing, which is the whole point of it", async () => {
    const onSubmit = vi.fn(async () => {});
    mount({ queueing: true, steerable: true, onSubmit });
    expect(sendNow()).toBeTruthy();
    expect(screen.getByLabelText("Queue")).toBeTruthy();
    expect(screen.queryByLabelText("Send")).toBeNull();
    sendNow()?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalled());
    // The third argument is `now`: true steers, false queues.
    expect(onSubmit.mock.calls[0]).toEqual(["say something", [], true]);
  });

  it("stays away when the turn cannot take direction, rather than sitting there dim", () => {
    // Disabled controls drop their pointer events, so a dim Send now could
    // never show the reason it was dim. The reason moves to the queue button,
    // which is enabled and can.
    mount({ queueing: true, steerable: false, steerReason: "Earlier direction must be handled first. Direction will be queued." });
    expect(sendNow()).toBeNull();
    expect(screen.getByLabelText("Queue")).toBeTruthy();
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
      fireEvent.paste(screen.getByRole("textbox", { name: "Message" }), { clipboardData: { files: [new File(["notes"], "notes.txt", { type: "text/plain" })] } });
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
    const props = { draftKey: "navigation-accept", onSubmit, liveByDefault: true, queueing: true };
    mount(props);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    for (let i = 0; i < 6; i++) {
      cleanup();
      mount(props);
      expect(screen.getByRole("button", { name: "Send" })).toHaveProperty("disabled", true);
      expect(screen.getByRole("textbox", { name: "Message" })).toHaveProperty("disabled", true);
      expect(screen.getByText("Sending…")).toBeTruthy();
      fireEvent.keyDown(screen.getByRole("textbox", { name: "Message" }), { key: "Enter" });
      fireEvent.click(screen.getByRole("button", { name: "Queue" }));
    }
    expect(onSubmit).toHaveBeenCalledOnce();
    await act(async () => accept());
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveProperty("value", "");
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
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveProperty("value", "say something");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Message" })).toHaveProperty("value", ""));
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
      expect(screen.getByRole("textbox", { name: "Message" })).toHaveProperty("value", value);
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
  const message = () => screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Message" });

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
      fireEvent.change(message(), { target: { value: "@app", selectionStart: 4 } });
      expect(await screen.findByRole("option", { name: "src/app.ts" })).toBeTruthy();
      expect(searched).toEqual([{ scope: { kind: "thread", id: "worktree-thread" }, query: "app", limit: 8 }]);
      cleanup();
      mount({ value: "" });
      fireEvent.change(message(), { target: { value: "@app", selectionStart: 4 } });
      expect(screen.queryByRole("option", { name: "src/app.ts" })).toBeNull();
      expect(searched).toHaveLength(1);
    } finally {
      call.mockRestore();
    }
  });
});

describe("mode picker", () => {
  const offered = async () => (await screen.findAllByRole("menuitem")).map((item) => item.firstElementChild?.textContent);
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
  const message = () => screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Message" });
  const typeAt = (text: string) => {
    fireEvent.change(message(), { target: { value: text, selectionStart: text.length, selectionEnd: text.length } });
    fireEvent.select(message());
  };

  it("offers a connector for an @ word and Enter picks it, even at the end of the message", () => {
    const onSubmit = vi.fn(async () => {});
    const onConnectorsWanted = vi.fn();
    const { container } = mount({ value: "", connectors, onConnectorsWanted, onSubmit });
    typeAt("do you see @pa");
    expect(onConnectorsWanted).toHaveBeenCalled();
    expect(screen.getByRole("option", { name: "@paper Paper" })).toBeTruthy();
    fireEvent.keyDown(message(), { key: "Enter" });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(message().value).toBe("do you see @paper ");
    const mark = container.querySelector(".composer-input-mirror mark.connector-token");
    expect(mark?.textContent).toBe("@paper");
    expect(mark?.querySelector(".connector-token-at")?.getAttribute("data-letter")).toBe("P");
  });

  it("leaves an @ word that names no connector unmarked", () => {
    const { container } = mount({ value: "mail me@paper.com or @papers", connectors });
    expect(container.querySelector(".composer-input-mirror mark.connector-token")).toBeNull();
  });

  it("lists the connectors the agent goes without in this mode, dimmed under why, and picking one leaves the message", () => {
    mount({ value: "", connectors: [], connectorsAside: { connectors, reason: "Claude has connectors in Autonomous mode." } });
    typeAt("ask @pa");
    const row = screen.getByRole("option", { name: /@paper/ });
    expect([row.getAttribute("aria-disabled"), row.title]).toEqual(["true", "Claude has connectors in Autonomous mode."]);
    expect(document.querySelector(".composer-suggestion-group")?.textContent).toBe("Claude has connectors in Autonomous mode.");
    fireEvent.mouseDown(row);
    expect(message().value).toBe("ask @pa");
  });

  it("sends on Enter when only dimmed connectors match, since none of them can be picked", async () => {
    const onSubmit = vi.fn(async () => {});
    mount({ value: "", connectors: [], connectorsAside: { connectors, reason: "Claude has connectors in Autonomous mode." }, onSubmit });
    typeAt("ask @pa");
    fireEvent.keyDown(message(), { key: "ArrowDown" });
    fireEvent.keyDown(message(), { key: "Enter" });
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
