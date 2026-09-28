import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Composer, type ComposerProps } from "./Composer";
import { readDraft, writeDraft } from "../lib/drafts";
import { core } from "../lib/rpc";

afterEach(cleanup);

/** Only what the composer reads on mount. Nothing here reaches the core or a provider. */
function mount(overrides: Partial<ComposerProps> = {}) {
  const props: ComposerProps = {
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
    ...overrides,
  };
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
    expect(message().value).toBe("please /code-review  afterward");
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
    const { container } = mount({ commands: [{ name: "code-review", hint: "Review code", insert: true, prefix: "$" }], value: "Please $co" });
    selectAt("Please $co".length);
    fireEvent.keyDown(message(), { key: "Tab" });
    expect(message().value).toBe("Please $code-review ");
    expect(container.querySelector(".composer-input-mirror mark")?.textContent).toBe("$code-review");
  });

  it.each(["/tmp/co", "https://example.com/co"])("does not offer suggestions inside %j", (value) => {
    mount({ commands, value });
    selectAt(value.length);
    expect(screen.queryByRole("listbox", { name: "Commands" })).toBeNull();
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
    expect(screen.getByText("main")).toBeTruthy();
  });
});
